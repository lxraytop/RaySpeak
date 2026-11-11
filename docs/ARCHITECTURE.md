# 架构设计

## 1. 分层

| 层 | 位置 | 职责 |
| --- | --- | --- |
| 视图 | `src/components/` | 纯展示 + 局部交互状态（展开、输入、弹窗内容） |
| 应用状态 | `src/App.tsx` | 连接、快照、频道/成员/消息、深链、头像、右键菜单、弹窗编排 |
| 协议封装 | `src/protocol.ts` | 所有 `invoke` 与 `listen` 的类型化出口 |
| 领域映射 | `src/utils/live.ts` | Rust DTO → 前端模型、组注册、排序保持 |
| 设置 | `src/settings.ts` | localStorage、默认值、CSS 变量与 `data-*` 投影 |
| Tauri 桥 | `src-tauri/src/lib.rs` | 命令、事件、Bridge、快照循环、文件传输 |
| 协议内核 | `src-tauri/vendor/tsclient-rs/` | TS3 握手、目录、消息、语音、文件传输（含补丁） |

前端不直接持有 `Client`；所有协议动作都是 Tauri command。

## 2. Rust 侧

### Bridge

`Bridge` 是全局 `Arc`，由 Tauri `manage`：

- `client: Mutex<Option<Arc<Client>>>`：当前连接
- `generation`：每次连接/断开递增，旧快照循环据此退出
- `self_clid`、`groups`、`channel_quality`
- `icon_cache`、`avatar_cache`：data URL 缓存，重连时清空
- `last_snapshot`：JSON 字符串，用于抑制重复 `ts://snapshot`
- `permissions`：当前身份权限缓存
- `resolved_host`：SRV 解析出的文件传输主机（仅内部）
- `pending_deep_link`：冷启动深链，等待前端取走

### 非 Send future

`tsclient-rs` 的 future 不是 `Send`。`run_proto()` 把它放进
`tauri::async_runtime::spawn_blocking`，在该线程上 `block_on` Bridge 自有的
Tokio runtime。**新增任何协议命令都必须沿用此模式。**

### 连接流程

`connect_server`：

1. 校验昵称；清理旧连接、缓存
2. `load_identity()`（首次生成并写入 app config 目录）
3. `Client::new(..., ClientOptions { server_password: 空则 None })`
4. `attach_handlers()` 注册消息/戳/踢/断开/语音/插件/权限事件
5. 握手 + 等待 connected + 等待 directory ready
6. 发送五类 `servernotifyregister`
7. 拉取组列表与频道 codec quality
8. `build_snapshot()` 并写入 `last_snapshot`
9. 启动 `spawn_snapshot_loop()`，emit `ts://connected`

### 快照循环

每 650ms：

- 检查 generation、连接状态、目录是否 ready
- `directory_snapshot()` → `build_snapshot()`
- 与 `last_snapshot` 比较，变化才 emit `ts://snapshot`
- 连接断开时 emit `ts://disconnected` 并清理 client

目录顺序由 tsclient-rs 的 `ordered_channels_from_index()` 按兄弟 predecessor 链输出，
Rust/前端都**不得**再按 `ChannelDto.order` 数值排序。

### 命令分类

- 连接/身份：`connect_server`、`disconnect_server`、`get_identity_string`、`export_identity`
- 目录：`get_snapshot`、`refresh_directory`
- 消息：`send_channel_message`、`send_private_message`、`send_server_message`、`poke_client`
- 管理：`move_client`、`kick_client`、`ban_client`、频道增删改、`update_self`
- 信息：`get_client_details`、`get_my_permissions`、`get_server_info`、`get_stats`
- 图标/头像：`fetch_channel_icon`、`fetch_client_avatar`、`upload_avatar`、`delete_avatar`
- 文件：`list_files`、`upload_file`、`download_file`、`delete_file`
- 语音：`set_voice_enabled`、`send_voice_data`、`set_audio_state`
- 应用：`get_app_info`、`open_data_dir`、`take_deep_link`、`send_plugin_command_backend`

### 图标与头像

- 图标：频道/组/服务器图标都是频道 0 的 `/icon_<u32>`，`fetch_channel_icon`
  下载后转 data URL 并缓存。组/频道前端用注册表 `utils/icons.ts` 取用。
- 头像：DTO 带 `avatarHash`（`client_flag_avatar`）。下载路径
  `/avatar_<UID按字节 a-p 编码>`，大小上限 2MB，检测 PNG/JPEG/GIF/WebP。
- 上传：前端把图片裁剪成 256×256 JPEG（≤200KB），Rust 计算 MD5、上传到
  `/avatar_<md5>`，再 `clientupdate client_flag_avatar=<md5>`；
  本地目录缓存通过 vendor 的 `set_own_avatar()` 立即更新。
- 删除：`ftdeletefile cid=0 name=/avatar_`，再清空 flag；本地缓存同步清空。

### 文件传输主机

服务器域名可能只有 SRV。`HostLogger` 捕获 tsclient-rs 的
`connecting to server: host:port` 日志，写入 `resolved_host`。
`transfer_host()` 返回该主机（无则退回常量域名），供图标/头像/文件传输使用。
任何路径都不得把该值回传前端或写日志。

## 3. 前端侧

### App.tsx 状态分组

- 连接：`auth`、`connected`、`authError`、`latency`、`serverInfo`、`serverIcon`
- 目录：`channels`、`clients`、`activeId`、`permissions`
- 消息：`messages`、`dmMessages`、`system`、`unread`
- UI：`page`、`modal`、`profileId`、`contextMenu`、`toast`
- 设置：`settings`（localStorage 同步）
- refs：`clientsRef`、`channelsRef`、`activeIdRef`、`pageRef`、`selfUidRef`、
  `pendingSentRef`、`clientDetailsRef`、`avatarRequests`、`iconRequests`

事件回调里使用 ref 读取最新值，避免闭包过期。

### 快照应用

`applySnapshot(snapshot, focusSelf?)`：

1. 注册组图标元数据
2. DTO → 频道/成员模型
3. 基于 clid 计算加入/离开/换频道系统消息（受通知设置控制）
4. 为新成员预取 `client_details`（简介、平台、版本、DB ID、频道组、头像 hash）
5. 更新 selfUid、校正 activeId
6. 预取频道图标、组图标
7. 头像 effect 根据 `avatarHash` 下载并回填 `avatarUrl`

`toClient()` 只有在 avatarHash 未变时才保留旧 `avatarUrl`，避免换头像后显示旧图。

### 消息

- 发送：先乐观插入，再 `pendingSentRef` 记录；失败回滚。
- 接收：`ts://message`。`targetMode` 1=私聊，2=频道，3=服务器。
- 去重：自己的回声按“同类型 + 同文本 + 10 秒内”移除 pending 记录并丢弃回声。
- 布局：`ChatMessage.self` 驱动 `.msg.is-self`，CSS `row-reverse` 实现右侧。
- 频道映射：`targetmode=2` 的 `target` 通常为 0，回退到 invoker 的频道。

### 深链

`ray://join/<cid>?name=<name>`：

- 聊天渲染：`MessageText` 自动识别为 `.ray-link`，派发 `rayspeak:deep-link`
- 应用内：`handleDeepLink()` → 未连接存 `deepLinkRef`，连接后 join；
  频道不存在时 `refreshDirectory` 后重试
- OS：`tauri-plugin-deep-link` + 单实例转发；冷启动通过 `take_deep_link`
- 邀请弹窗复制/私聊发送同一链接，不包含服务器地址

### 语音

`useVoice.ts`：

- 采集：`getUserMedia` → AudioWorklet 20ms 分帧
- 编码：WebCodecs Opus → base64 → `send_voice_data`
- 解码：`ts://voice` → 每用户独立解码器 → 抖动缓冲 → 独立音量
- 说话态由收包时间推导；本地静音/闭麦通过 `set_audio_state` 同步
- 屏幕共享仅本地预览（TS3 协议不传视频）

## 4. 打包与图标

- 窗口：无边框、透明、`minWidth 1080 × 700`
- 图标：`src-tauri/icons/` 由根目录 `logo.png` 通过 `npx tauri icon` 生成
- 网页内 logo：`public/logo.png`（透明圆角 256px）
- 安装包：NSIS，currentUser 模式

## 5. 修改建议

- 新功能先判断是“协议真实能力”还是“本地 UI 能力”，不要混用文案。
- 协议调用集中在 Rust command 中，TS 端只通过 `protocol.ts`。
- 不要让 `App.tsx` 继续无序膨胀：可把消息、目录、deep link 拆为 hooks，
  但迁移时保持 ref/回调语义。
- 改快照数据结构时同步更新 `protocol.ts` DTO 与 `utils/live.ts` 映射。

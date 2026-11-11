# TeamSpeak 协议接入说明

本文记录 RaySpeak 实际使用/依赖的 TeamSpeak 3 行为，以及 `tsclient-rs` 的补丁内容。
修改协议层前先阅读本文，避免重复踩坑。

> 真实服务器地址只存在于 `src-tauri/src/lib.rs` 的常量中，任何文档、UI、日志都不得出现。

## 1. 连接与身份

- 使用 `tsclient-rs` 的 P-256/Ed25519 加密握手；`ClientOptions.server_password`
  为空时传 `None`，空密码可正常连接。
- 身份保存在 app config 目录的 `identity.dat`，首次自动生成，后续复用。
- 服务器域名可能只有 `_ts3._udp` SRV 记录：UDP 连接由 crate 处理，
  文件传输需要真实主机，由 `HostLogger` 捕获日志中的
  `connecting to server: host:port`，写入 `Bridge.resolved_host`。
- 连接后等待 `wait_connected` 与 `wait_directory_ready`（目录欢迎流完成）。

## 2. 目录与排序

- 欢迎流：`channellist`、`channelclientlist`、`channellistfinished` 由 crate 组装成
  `DirectoryCache`，`directory_snapshot()` 输出树。
- **欢迎流不保证下发全服成员**：部分服务器只推当前频道的 `channelclientlist`，
  其他频道成员要等客户端走进去才出现（表现为“新号只看到自己频道的人”）。
  因此连接完成后主动执行一次 `clientlist -uid -away -voice -groups`，把结果
  upsert 进目录（vendor 补丁 `Client::refresh_clients`），并在快照循环里每 ~30 秒
  对齐一次，修复漏掉的 join/leave 通知。
- **频道密码位同样要主动拉**：欢迎流的 `channellist` 不保证带
  `channel_flag_password`，用 `channellist -icon -flags` 再刷一次
  （`Client::refresh_channels`），否则加密频道不会弹密码框。
- 排序：`channel_order` **不是序号**，而是同级前一个频道的 ID（predecessor）。
  crate 的 `ordered_channels_from_index()` / `ordered_sibling_ids()` 已按该链输出；
  前端只按快照数组顺序渲染。
- 频道父节点缺失或为 0 时是根节点；spacer 频道（`[cspacer]` 等）也属于节点，
  它同样是真实频道（可以有人、可以被进入），前端必须显示其人数与成员，
  其子节点需要按层级缩进渲染。组 ID 使用 `s<sgid>` / `c<cgid>` 前缀隔离命名空间。
- 手动刷新：`refresh_directory` 现在会先重拉 `clientlist` 与频道 flags，再拉组与
  codec quality，然后复用 crate 的目录缓存。

## 3. 成员可见性与事件订阅（关键）

语音连接（`client_type=0`）和 ServerQuery（`client_type=1`）是两套不同的能力，
实测结论如下（真实服务器抓包）：

| 命令 | 语音连接结果 | 说明 |
| --- | --- | --- |
| `servernotifyregister event=...` | `error id=516 msg=invalid client type` | 查询会话专用，语音连接一律拒绝 |
| `clientlist [-uid -groups ...]` | `error id=2568 insufficient client permissions` | 普通身份无该权限，`failed_permid=29` |
| `channelsubscribeall` | `error id=0 msg=ok` | 订阅整棵频道树 |

**结论：连接成功后必须发送 `channelsubscribeall`。** 不发这条命令时，服务器只
推送当前频道的成员，客户端走遍其他频道才看得见人；发了之后服务器会补推全部
频道的 `channelclientlist` / `notifycliententerview`，本地目录缓存即拥有全服成员。

- 文字消息、成员进出与换频道事件由上述订阅直接推送，不需要 `servernotifyregister`。
- 实现位置：`connect_server` 在 `wait_directory_ready` 之后发送（失败仅降级为
  “只看得到本频道”，不中断连接）；快照循环每 ~30 秒重订阅一次做无损重同步；
  `refresh_directory` 同样是重订阅而不是拉 `clientlist`。
- 参考实现：WebSpeak（`@honeybbq/teamspeak`）在欢迎流之后调用的正是
  `channelsubscribeall`，并从 SDK 本地目录读成员，不发 `clientlist`。

## 3.1 加密频道与加入失败

- 加入频道走 `clientmove clid=<self> cid=<id> cpw=<channel_password>`（与参考实现
  字节一致；`cpw` 只在非空时携带，值会做 TS3 转义）。密码不落盘、不写日志。
- 实测错误：密码被拒返回 `error id=781 msg=invalid channel password`；权限不足返回
  `error id=2568 insufficient client permissions`。两者必须分开提示，否则非管理员会
  被“密码错误”误导着反复重输。
- 注意：TS3 对未达“加入权限值”的加密频道也可能统一回报 781，若密码确认正确仍被
  拒绝，需要管理员降低该频道的 `i_channel_needed_join_power` 或提升客户端组权限。
- 历史 bug：`clean_error()` 曾把所有含 `password` 的错误改写成“服务器密码错误”，
  导致频道密码错误被误报；现在只有 `server password` 才按登录密码处理。
- 前端在密码错误时保留弹窗并显示原因，可直接重试；频道没有密码标志但服务器要求
  密码（781）时，也会在失败后补弹密码框。

## 4. 文字消息

`notifytextmessage` 参数：

- `targetmode=1`：私聊，`target` 为目标 clid
- `targetmode=2`：频道消息，**`target` 常为 0，表示发送者当前频道**
- `targetmode=3`：服务器消息

处理约定：

- 频道消息先尝试用 `target` 匹配频道 ID；失败则使用 invoker 的 `cid` 或当前 activeId。
- 发送频道消息调用 `sendTextMessage(client, 2, channelId, text)`；
  由于协议语义，实际是发送到发送者当前频道。
- 自己的回声去重：同 kind + 同文本 + 10 秒内，移除乐观消息的 pending 记录并丢弃回声。
- 私聊不需要 `client_flag_avatar` 等额外字段，`invokeruid` 直接作为联系人 ID。

## 5. 服务器信息

- `serverinfo` / `serverlist` / `hostinfo` 在访客身份下可能被拒
  （`insufficient client permissions id=2568`）；`servervariable` 在该环境会超时。
- 服务器名称、平台、版本、人数上限、`virtualserver_icon_id` 从握手
  `initserver` 参数读取。crate 原本只读取 `aclid`，补丁增加保存与暴露。
- `notifyserveredited` / `notifyserverupdated` 更新本地属性缓存。
- 服务器图标与频道图标同样位于频道 0 文件区，路径 `/icon_<u32>`。

## 6. 图标

- 频道图标：`channel_icon_id` → `/icon_<id>`，下载转 data URL 缓存。
- 服务器组/频道组图标：`servergrouplist` / `channelgrouplist` 的 `iconid`。
  - 正数大 ID 为自定义图标文件，可下载。
  - `100/200/300/500/600` 等为内置图标，没有对应文件；前端用近似图标映射。
  - 负数内置图标（-1/-2）现在按有符号解析，前端做近似显示。
- 频道图标 `0`/缺失表示没有图标；不要下载 `/icon_0`。

## 7. 头像（TeamSpeak 3 真实支持）

- 每个客户端字段：`client_flag_avatar`：头像文件 MD5（空字符串表示无头像）。
- 文件位置：频道 0，文件名由客户端 UID 派生：

```
UID(base64) --解码--> bytes
filename = "/avatar_" + 每个 byte 拆成两个字母
           高 4 位 -> a..p，低 4 位 -> a..p
```

TS3 UID 为 20 字节 SHA-1 base64，文件名 40 个字母；TS6 为 32 字节，64 字母。

- 下载：`ftinitdownload cid=0 name=/avatar_<letters>` + 文件传输；
  无文件时 TS3 返回 2054（TS6 2051），前端回退字母头像。
- 上传：
  1. 计算图片 MD5
  2. `ftinitupload cid=0 name=/avatar_<md5> overwrite=1` + 上传字节
  3. `clientupdate client_flag_avatar=<md5>`
  4. 服务器会把文件重命名为 UID 派生名
- 删除：`ftdeletefile cid=0 name=/avatar_`（按调用者自身解析），
  然后 `clientupdate client_flag_avatar=` 清空标记。
- 前端上传前裁剪为 256×256 JPEG（白底），后端限制 200,000 字节。
- 头像下载缓存键为 `uid:hash`；hash 变化即失效。
- DTO：`ClientDto.avatarHash`，前端 `Client.avatarHash/avatarUrl`。
- 测试提示：上传/删除会改真实账号资料，联调请使用一次性身份或临时 app config。

## 8. vendor 补丁清单

`src-tauri/vendor/tsclient-rs` 基于 crate 0.2.7，补丁点：

1. `ClientInner.server_properties` + `Client::server_properties()`，
   `handle_init_server` 保存 `initserver` 参数。
2. `process_notification_result` 合并 `notifyserveredited` / `notifyserverupdated`
   的 `virtualserver_*` 字段。
3. `ClientInfo.avatar`，`parse_client()` 读取 `client_flag_avatar`，
   `apply_client_notification()` 处理头像变化。
4. `Client::set_own_avatar()` + `DirectoryCache::update_client()` 改为 `pub(crate)`，
   用于上传/删除后立即刷新本地快照。

升级 `tsclient-rs` 时需逐条重新应用，并确认公开类型新增字段没有遗漏构造器。

## 9. 频道 / 成员管理

- 加入频道：`clientMove(clid, cid, password)`；密码错误/权限不足由服务器返回。
- 移动成员、踢出、封禁：`clientMove` / `clientKick` / `banClient`。
- 创建频道：`channelcreate ... channel_codec` / `channel_codec_quality`；
  `channel_order` 不显式设置，由服务器分配。
- 编辑频道：`channeledit`。密码字段为空时不要发送，删除密码时发送空值。
- 权限判断：`permissionlist` + 当前客户端 `client_servergroups`。
  管理按钮在无权限时禁用，不能只依赖 UI。

## 10. 文件传输

- 频道文件：`ftlistfile` / `ftinitupload` / `ftinitdownload` / `ftdeletefile`。
- 所有传输都使用 `transfer_host()` 解析出的真实主机 + `FileTransferInfo.port`。
- 图标 / 头像固定使用 `cid=0`；普通频道文件使用频道 ID。
- 限制：图标 ≤1MB、头像 ≤2MB（下载）/200KB（上传）、普通文件由服务器权限决定。

## 11. 语音

- `tsclient-rs` 提供 Opus 语音事件；前端 `useVoice.ts` 负责采集/编码/解码/播放。
- 编解码器编号：0 Speex Narrow、1 Speex Wide、2 Speex Ultra、3 CELT Mono、
  4 Opus、5 Opus Music。
- 频道 quality → 码率换算：`(quality * 12).clamp(8, 510)` kbps；无数据时默认 64。
- `clientupdate client_input_muted/client_output_muted` 同步本地静音/闭麦状态。
- 服务器不转发视频，屏幕共享只是本地预览。

## 12. 深链（应用层，不是 TS 协议）

- 格式：`ray://join/<channelId>?name=<encoded name>`
- Windows 通过 `tauri-plugin-deep-link` 注册 `ray` scheme；
  `tauri-plugin-single-instance`（deep-link feature）转发给已运行实例。
- 冷启动：`get_current()` 存入 `pending_deep_link`，前端 `take_deep_link` 取一次。
- 运行中：`on_open_url` emit `ts://deep-link`。
- 前端 `parseRayLink()` 只接受 `ray://join/<id>`，未知频道会先刷新目录再重试。
- 链接不包含服务器地址。

# RaySpeak

基于 TeamSpeak 协议的第三方语音客户端，已接入真实服务器。

- 技术栈：Tauri 2 + React 19 + TypeScript + Vite + tsclient-rs（Rust）
- 界面：KOOK / NN 风格，1200×780 frameless 窗口，浅色 / 深色主题
- 产物：Windows NSIS 安装包，主程序约 10 MB

## 进入服务器

桌面应用启动后停在登录门：

- 输入**昵称**后进入；服务器未设置密码时**密码留空**即可
- 服务器地址固定写在 Rust 配置中，界面、错误提示、日志都不会显示该地址
- 域名只配置 SRV 记录时，客户端会自动解析出实际接入主机用于文件传输，
  解析结果同样不会出现在界面或错误信息中
- 昵称可选择在本机记住；**密码只在本次握手使用，不会写入本地文件或日志**
- 身份密钥首次启动时在 `app_config_dir()/identity.dat` 生成，后续复用
- 被踢出、密码错误、连接中断都会回到登录门并显示脱敏后的原因

## 已接入的真实功能

- 连接：ECDH / RSA 谜题 / EAX 加密握手，连接状态与频道目录超时处理
- 服务器信息：握手 `initserver` 直接提供名称、平台、版本、人数上限与图标
  （无需受权限限制的 `serverinfo`），侧栏实时显示服务器名、人数和图标
- 频道：目录树、父子关系、`icon_id` 自定义图标（下载后缓存为 data URL）、
  TeamSpeak 名称格式（`[b] [i] [u] [color] [size] [url]` 与
  `[cspacer]/[rspacer]/[*spacer]`）、密码 / 人数上限 / 编解码 / 描述；
  顺序严格按服务器的 predecessor 链渲染，并提供手动刷新
- 成员：实时快照（650 ms 增量推送）与目录事件订阅（server/channel）、
  真实头像（`client_flag_avatar` + 频道 0 的 `avatar_<uid>` 文件传输）、
  静音 / 闭麦 / 离开 / 频道指挥状态、服务器组与频道组（含自定义/内置组图标）、
  个人简介、客户端平台 / 版本 / 数据库 ID / UID；
  可在资料卡或右键菜单设置/删除自己的头像（上传前缩放为 256 px JPEG）
- 文字消息：频道消息、服务器消息、私聊；订阅 textserver/textchannel/textprivate
  后收发均走协议事件；自己的消息靠右、他人靠左（私聊与频道一致）
- 邀请：`ray://join/<频道ID>?name=<频道名>` 深链，聊天中自动识别可点击，
  也支持从资料卡或联系人页私聊发送；不泄露服务器地址
- 频道管理：加入频道（含频道密码）、移动成员、踢出、封禁、
  创建 / 编辑 / 删除频道、设置或移除频道密码；管理按钮按真实权限与服务器组判断
- 文件：列出、上传、下载、删除频道文件（系统文件对话框选择路径）
- 统计：`serverrequestconnectioninfo` 轮询延迟，显示在标题栏与房间头部
- 语音：WebCodecs Opus 编解码 + WebAudio
  - 麦克风采集 → AudioWorklet 20 ms 分帧 → Opus 编码 → `send_voice_data`
  - 收包 `ts://voice` → 每用户独立解码器 → 抖动缓冲后按用户音量播放
  - 本地静音 / 闭麦 / 单用户音量与本地静音，说话绿圈由收包时间和
    本地音量推导
  - 静音状态通过 `clientupdate client_input_muted / client_output_muted`
    同步给服务器

## 本地能力（协议不提供或只做本地）

- 屏幕共享面板：使用 `getDisplayMedia` 做本地预览；TeamSpeak 协议不传输
  视频，共享状态只在本地界面显示
- 频道动态、联系人「最近会话」、屏蔽名单、音量、主题、布局等设置保存在 localStorage
- 无头像的成员使用昵称生成的字母头像；服务器图标、频道图标、组图标与
  成员头像均读取服务器真实资源
- 好友在线状态：TS 协议无好友系统，未做虚假展示

## 开发文档

- [AGENTS.md](AGENTS.md) — 后续 Agent 必读：硬约束、架构、陷阱、检查清单
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块、状态与数据流
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — TeamSpeak 命令/事件、头像与补丁说明
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 环境、构建、调试、发布
- [docs/PACKAGING.md](docs/PACKAGING.md) — 打包步骤、工具链依赖与常见报错
- [docs/ROADMAP.md](docs/ROADMAP.md) — 已知缺口与后续任务
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 变更记录：成员可见性、加密频道与外观批次

## 开发

> `src-tauri/vendor/tsclient-rs` 是 tsclient-rs 0.2.7 的最小补丁副本：
> 增加暴露 `initserver` 属性（服务器名称/图标等）、解析
> `client_flag_avatar` 的接口，并跟随 `notifyserveredited` /
> `notifyclientupdated` 更新；`src-tauri/Cargo.toml` 用
> `[patch.crates-io]` 指向它。

```bash
npm install
npm run dev       # 浏览器预览（自动使用内置演示数据）
npm run app:dev   # Tauri 桌面窗口（真实协议，需输入密码）
npm run typecheck
```

浏览器预览不会连接服务器：没有 Tauri 运行时或带 `?demo=1` 时使用内置演示数据，
用于检查 UI。`?login=1` 可在浏览器中查看登录门外观。

### 调试 URL 参数（浏览器 / 演示模式）

- `?screen=settings&section=appearance` 直接打开设置分区
  （account/audio/appearance/hotkeys/notify/privacy/advanced/about）
- `?screen=contacts&dm=asara` 打开指定联系人的私聊
- `?layout=cards|grid` 指定房间布局
- `?theme=light|dark|system` 指定主题
- `?channel=team1` 指定初始频道
- `?profile=asara` 打开指定用户资料卡
- `?modal=create|files|room|screen|invite` 打开对应能力弹窗
- `?login=1` 强制显示登录门

## 构建

```bash
npm run app:build
```

产物：

- `src-tauri/target/release/rayspeak.exe`
- `src-tauri/target/release/bundle/nsis/RaySpeak_0.2.0_x64-setup.exe`

## 环境

Rust 工具链位于 `F:\dev\cargo` / `F:\dev\rustup`，
Windows 依赖 VS 2022 BuildTools 与 WebView2 Runtime。

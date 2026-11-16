# AGENTS.md — RaySpeak 开发交接

本文件面向后续接手本仓库的 AI Agent。开始修改前请完整阅读，尤其是「硬约束」和「常见陷阱」。

## 项目概览

RaySpeak 是一个 Windows 桌面 TeamSpeak 3 第三方客户端：

- 前端：React 19 + TypeScript 5.6 + Vite 6，单页应用，UI 风格接近 KOOK / 语音房产品
- 桌面壳：Tauri 2（WebView2、无边框透明窗口、NSIS 打包）
- 协议层：Rust + `tsclient-rs 0.2.7`（**仓库内 vendor 了带补丁的副本**）
- 当前版本：`0.3.0`，应用标识 `gg.rayspeak.app`

已实现：真实加密握手、频道目录、**全服成员可见（`channelsubscribeall`）**、成员状态、
文字/私聊消息、头像、频道/服务器/组图标、频道文件传输、成员管理、Opus 语音收发、
`ray://` 深链邀请、自定义右键菜单、主题与设置、**加密频道加入（`cpw` 哈希）**、
成员进出提示音、房间头部在线状态与深浅色快捷键、轮廓化外观预设与高对比模式、
头像与联系人目录本地持久化、**可切换的音频配置档**、**可选原生麦克风采集（Rust/WASAPI +
SpeexDSP/RNNoise，编码后直接发包）**、麦克风诊断（`--mic-diag` / `--mic-scan`）、
**屏幕共享独立页面（EasyTier 组网 + 原生 WGC 采集 + WebRTC，不经 TeamSpeak 服务器）**。

「共享」与「文件」的房间入口当前**暂时隐藏**（命令、弹窗与设置项都还在），
恢复时只需在 `App.tsx` 的 `room-actions` 里放回按钮。

## 硬约束（不得违反）

1. **服务器地址保密**：服务器地址硬编码在 `src-tauri/src/lib.rs` 的
   `SERVER_ADDR` / `SERVER_HOST` 常量中。页面、错误提示、日志、toast、
   deep link 中都不得出现真实地址、SRV 解析结果或文件传输主机。
2. **密码不落地**：服务器密码只用于本次握手；不得写入 localStorage、文件、日志或事件。
   允许空密码连接。
3. **先登录后进入**：未连接时只能看到登录门；昵称必填，密码可空。
4. **不伪造服务器能力**：协议做不到的功能不要伪装成真实数据。
   做不到时明确降级或标注为本地能力。
5. **不提交生成物与测试残留**：`node_modules/`、`dist/`、`src-tauri/target/`、
   `src-tauri/resources/easytier/`、`.shots/`、临时 CDP 脚本、测试截图、
   `ws` 临时依赖都不要进 Git。
6. **协议相关改动先读 `src-tauri/vendor/tsclient-rs/`**：这是打过补丁的副本，
   升级 crate 后必须重新应用补丁，见 `docs/DEVELOPMENT.md`。

## 快速命令

```bash
npm install
npm run dev         # 浏览器演示模式（不连服务器）
npm run typecheck   # 每次改 TS 必跑
npm run audio:check # 采集侧 DSP 自检（7 项断言，无需设备）
npm run easytier:fetch # 下载并校验屏幕共享用的 EasyTier 内核（首次构建前执行）
npm run app:dev     # Tauri 开发窗口
npm run app:build   # 生产构建 + NSIS 安装包
```

`app:dev` / `app:build` 走 `scripts/tauri-run.mjs`，会从 Visual Studio Build Tools
里找到 CMake 并设置 `CMAKE_POLICY_VERSION_MINIMUM=3.5`（libopus 的 CMakeLists 还是 3.1）。
直接跑 `cargo check` / `cargo test` 时如果报「找不到 cmake」或「Unable to find libclang」，
需要手动补齐两个环境变量（本机 VS 在 **F 盘**，`vswhere -latest` 解析到的是
`Visual Studio/18/BuildTools`，只在 C 盘找会落空）：

```bash
export CMAKE="F:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
export CMAKE_POLICY_VERSION_MINIMUM=3.5
export LIBCLANG_PATH="C:/Users/<you>/AppData/Roaming/Python/Python310/site-packages/clang/native"
```

完整工具链说明与报错处置见 [docs/PACKAGING.md](docs/PACKAGING.md)。

本机 Rust 工具链位于非 C 盘，运行 Rust 命令前：

```bash
export PATH="/f/dev/cargo/bin:$PATH"
export RUSTUP_HOME="F:/dev/rustup"
export CARGO_HOME="F:/dev/cargo"
cd src-tauri && cargo check
```

产物：

- `src-tauri/target/release/rayspeak.exe`
- `src-tauri/target/release/bundle/nsis/RaySpeak_0.3.0_x64-setup.exe`

环境基线：Node 20+（当前 22.22.2）、npm 10+、Rust 1.99、CMake（VS BuildTools 自带）、
WebView2 Runtime、Windows 10/11。

## 目录结构

```
src/
  App.tsx              前端状态中枢：连接、快照、消息、深链、右键菜单、头像上传
  protocol.ts          Tauri invoke/event 的类型化封装（所有后端命令的入口）
  types.ts             前端领域模型
  settings.ts          Settings 类型、默认值、localStorage 读写、CSS 变量/属性应用
  useVoice.ts          麦克风采集、Opus 编解码、语音收发
  utils/live.ts        后端 DTO → 前端模型；组/频道/客户端映射
  utils/icons.ts       频道图标、组图标 data URL 注册表
  utils/tsText.tsx     TS 格式文本解析（[b]/[color]/[cspacer] 等）
  screenShare.ts       屏幕共享服务：WebRTC、原生帧泵、信令收发（单例）
  components/          UI 组件（登录、频道树、成员卡、聊天、联系人、设置、屏幕共享…）
  styles.css           全部样式（主题通过 CSS 变量与 data-* 属性切换）

src-tauri/
  src/lib.rs           Tauri 命令、Bridge、事件、快照循环、头像/图标/文件传输
  src/audio.rs         原生麦克风采集 + SpeexDSP/RNNoise + Opus 编码
  src/share/           屏幕共享：房间派生、EasyTier 生命周期、STUN、信令 mesh、WGC 采集
  vendor/tsclient-rs/  带最小补丁的 tsclient-rs 0.2.7（见下）
  tauri.conf.json      窗口、深链 scheme、打包配置
  Cargo.toml           `[patch.crates-io]` 指向 vendor 副本

docs/                  ARCHITECTURE / PROTOCOL / DEVELOPMENT / ROADMAP / SCREEN_SHARE
```

## 架构速览

```
React (App.tsx)
  │ invoke / listen
  ▼
src/protocol.ts
  │ Tauri commands / events
  ▼
src-tauri/src/lib.rs  (Bridge: Arc<Client>, caches, generation)
  │ non-Send futures via run_proto + spawn_blocking
  ▼
tsclient-rs (vendor)
  │ UDP + 文件传输 TCP
  ▼
TeamSpeak 服务器
```

- 连接成功后 Rust 侧启动 650ms 快照循环，目录或质量变化时 emit `ts://snapshot`。
- 文字消息、戳一戳、被踢、断开、权限变化、语音、深链使用独立的 `ts://*` 事件。
- 前端 `App.tsx` 是唯一大状态容器；子组件基本无业务状态。
- 设置保存在 localStorage，并通过 `applySettings()` 投影为 CSS 变量与 `data-*` 属性。

详细设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 常见陷阱（务必先看）

1. **tsclient-rs 的 future 不是 `Send`**：所有协议调用必须走 `run_proto()`，
   在 Bridge 自有的 Tokio runtime + `spawn_blocking` 中执行，不能直接丢进
   Tauri executor。
2. **文件传输主机不是域名**：服务器可能只有 SRV 记录。连接时 `HostLogger`
   从 tsclient-rs 日志捕获真实主机，`transfer_host()` 供图标、头像、文件传输使用；
   该值不得返回前端。
3. **组 ID 有两个命名空间**：服务器组 `s<rawId>`，频道组 `c<rawId>`。
   原始数字 ID 会冲突，不能混用。
4. **`channel_order` 不是排序键**：它是“前一个同级频道 ID”的 predecessor 链。
   后端快照已按服务器树顺序输出，前端不要再按 `order` 数值排序。
5. **必须订阅文本通知**：连接后发送
   `servernotifyregister event=server|channel|textchannel|textprivate|textserver`，
   否则消息能发出但收不到任何回声/他人消息。
6. **频道消息的 `target` 常为 0**：`notifytextmessage targetmode=2 target=0` 表示
   “发送者当前频道”。不要用 `targetId` 匹配频道 ID；映射时回退到 invoker 所在频道。
7. **服务器信息来自握手**：`serverinfo` 会因权限被拒；服务器名称/图标/版本/上限
   从 `initserver` 参数获取（vendor 补丁暴露）。侧栏服务器卡片使用它。
8. **头像协议**：`client_flag_avatar` 是 MD5；文件在频道 0，路径
   `/avatar_<UID 每字节拆成 a-p 两个字母>`。上传先传 `/avatar_<md5>` 再
   `clientupdate client_flag_avatar=<md5>`；删除用 `ftdeletefile cid=0 name=/avatar_`。
   测试头像请用一次性身份，**不要覆盖真实用户头像**。
9. **深链有两条路径**：Tauri 事件 `ts://deep-link` 和渲染进程内部的
   `rayspeak:deep-link` 自定义事件。未连接时先存 `deepLinkRef`，登录后处理。
   冷启动 URL 通过 `take_deep_link` 命令取一次。
10. **单实例**：`tauri-plugin-single-instance`（启用 deep-link）必须保持首个注册；
    第二个实例会把 URL 转发给已运行实例。
11. **前端会为所有新客户端预取 `clientinfo`**（简介/平台/头像 hash/频道组）。
    大服务器上这是 N 次请求，改造时考虑并发/限流。
12. **空密码必须继续可用**，密码只在内存中的 `sessionCreds` 使用。
13. **本地缓存键**：`rayspeak.avatars.v1`（头像）与 `rayspeak.contacts.v1`（联系人目录）
    存在 localStorage，只用于离线展示与头像持久化，不得据此伪造服务器在线状态；
    「设置 → 网络与高级 → 清理本地缓存」会同时清空它们。
14. **面板透明度**：所有纯色面板走 `--panel*` + `--opacity-k`（`panelOpacity / 80`），
    新增面板请使用 `var(--panel)`，不要写死 `rgba(255,255,255,…)`，否则不透明度滑杆会失效。
15. **成员可见性靠 `channelsubscribeall`，不是 `clientlist`**：语音连接（client_type=0）上
    `clientlist` 一律 `2568 insufficient client permissions`、`servernotifyregister` 一律
    `516 invalid client type`（两者都是查询会话的能力）。连接后必须发一次
    `channelsubscribeall`，服务器才会补推其他频道的 `channelclientlist` /
    `notifycliententerview`；快照循环每 ~30 秒重订阅一次做无损重同步。不要再往
    `connect_server` 里加 `servernotifyregister` / `refresh_clients`，它们是无效命令。
16. **频道密码位来自欢迎流 `channellist`**（`channel_flag_password`），`refresh_channels`
    同样会被 2568 拒绝，别再调用。加入用 `clientmove clid=<self> cid= cpw=`，
    其中 `cpw` 必须是 `base64(sha1(明文))`——语音连接的密码字段全是这个规则，发明文时
    密码正确也会回 `781 invalid channel password`（坑过一次，见 `prepare_client_password`）。
    权限不足是 `2568`，两者提示必须分开，且别把所有含 “password” 的错误都当成服务器登录密码。
17. **播放只有 WebView 一条路径**：解码、抖动缓冲、混音、音量都在前端
    （`useVoice.ts`），Rust 侧 `on_voice_data` 只负责把 `ts://voice` 转发给前端。
    早期那套「WASAPI 原生播放（`nativeAudio` / 原生输出设备）」已经删除——
    不要再加回来：它没有播放参考信号，AEC 不收敛，还额外引入设备时钟漂移。
    设置页也不再显示「播放管线」卡片，只保留扬声器音量 / 输出设备 / 测试音。
18. **原生采集（`nativeMic`）默认关闭，但有自动回退**：开启后 `useVoice` 不再
    `getUserMedia`，Rust 用 SpeexDSP（`aec-rs-sys`）做 NS/AGC（**不启用 AEC**，
    因为没有播放参考）、自建 VAD/PTT 门控与门控/RNNoise 降噪，
    编码后由 tick 线程在 `Worker` 锁外 `Client::send_voice`。
    采集支持任意设备采样率（`pick_input_config` 优先 48k，其次 44.1k，
    再由 `resample_into` 线性插值拉回 48 kHz）；**时钟漂移用 ±0.5% 的重采样步进
    伺服修正**（`trim = clamp((occupancy-target)/target*0.05, ±0.005)`），
    不要退回「直接丢掉一整块样本」——那会造成波形断裂，听起来就是「咔哒/电流声」。
    打不开时前端会自动回退 WebView 采集（`nativeMicActive`），不需要用户手动关开关。
    **设备选择必须同时存 `nativeInput`**：浏览器只给 deviceId，cpal 只认设备名，
    选择设备时要把 label 写进 `settings.nativeInput`（配置档字段），
    Rust 找不到指定设备时**直接报错**，绝不悄悄回落到系统默认——否则用户会以为切换生效了。
    设置页的本地测试/校准/检测/授权会自己开麦克风，先用 `onAudioTestHold`
    让原生采集释放设备（并等 ~260ms 的 IPC + 防抖），否则两路会抢同一支麦克风。
    构建时需要 `libclang`（bindgen），`tauri-run.mjs` 会自动探测 pip 的 `libclang.dll`。
19. **音频配置档（`audioProfiles`）是音频设置的唯一持久化形态**：21 个音频字段
    会即时写回当前配置档（`App.tsx` 的 `updateSettings` + `captureAudioProfile`），
    切换配置档走 `audioProfilePatch`。新增音频设置项时必须同步加进
    `AUDIO_PROFILE_KEYS`，否则它不会随配置档保存。
20. **个人简介必须用 `clientedit`**：`clientupdate` 只接受昵称/静音/头像等字段，
    传 `client_description` 不会报错但也完全不生效。正确写法是
    `clientedit clid=<self> client_description=...`（权限
    `b_client_modify_own_description`）。连接后先 `getClientDetails(self.clid)`
    把服务器简介回填到设置，再以它为基线做 900ms 防抖推送；
    不要在 `clients` 快照里做防抖（每 650ms 会重置计时器）。

21. **屏幕共享不是 TS 协议功能**：媒体与信令都走 EasyTier 虚拟网，房间密钥由
    `SERVER_ADDR + 频道 ID` 在 Rust 本地派生。不要把服务器地址、虚拟网 secret 或
    EasyTier 日志原样返回前端；新增共享设置时也不要落盘 PIN。
    注意 `easytier-core` 启动时会把**整份 TOML 配置连 `network_secret` 一起**打进
    info 日志，`easytier.rs` 的 `redact()` 必须继续过滤这些行（有单测守着）；
    新增任何「把 EasyTier 日志带给前端」的路径都要先过 `redact()`。
    日志还经过两级降噪：`is_benign_noise()` 丢弃断开的虚拟网卡与 RPC 探活噪声，
    `RepeatFilter` 把 3 秒内正文相同的连续日志折叠成「×N」（`send_msg has error
    errs=[RouteError(None)]` 是节点重连时的正常刷屏）；不要把这两层删掉。
22. **EasyTier 由提权 helper 启动**：`runas` 拉起同一个 exe 的 `--share-helper`
    模式（见 `src-tauri/src/share/easytier.rs`），helper 再启动 easytier-core。
    不要改成从普通权限进程直接 `Command::new(easytier-core)`，那样创建不了 TUN；
    也不要把 helper 的 token 写进日志。资源目录用 `npm run easytier:fetch` 生成，不入库。
    **所有控制台子进程都必须 `CREATE_NO_WINDOW`**：release 构建没有控制台，
    漏掉一个（典型是每 3 秒一次的 `easytier-cli`）就会周期性弹出终端窗口；
    调试构建的 helper 还要 `FreeConsole()`。
23. **屏幕采集走原生 WGC（`windows-capture`）**，不弹 WebView2 选屏器。
    单元测试构建使用 `capture_stub.rs`，因为测试二进制没有应用清单，
    链接 `TaskDialogIndirect`（comctl32 v6）会在加载阶段以 0xC0000139 退出。
    改采集模块时要同步维护 stub 的公开接口。
24. **本机 STUN 不能删**：WebView2 会把 host candidate 混淆成 mDNS `.local`，
    只有绑定虚拟 IP 的 STUN 能让 Chromium 拿到 EasyTier 地址（`share_ice_servers`）。
25. **信令 mesh 的重复连接按 peer id 收敛**（`signal.rs`）：双方同时拨号时，
    必须保留「较小 peer id 发起」的那条；不要退回「先到先得」，否则两个连接会
    互相关闭并反复重连。断开清理要比较 `Arc::ptr_eq`，避免误删新连接。
26. **共享网络/采集的启动要串行且带代次**（`share/mod.rs`）：`share_network_start` /
    `share_capture_start` 各持一把异步锁，并在每个 await 后比较 `generation`；
    stop 先递增代次再关已有对象。少了这套守卫，「启动中点停止」或「连点两次开始」
    会遗留第二个提权 helper（孤儿 easytier-core + TUN）或第二个 WGC 采集线程。
    前端取帧循环同理带 `captureGeneration`，停止共享后旧循环必须自己退出。
27. **转发给前端的信令 `from` 只取握手中的 peer id**，不要改成信任消息里自报的
    `from`（同房间成员即可冒充别人发 SDP）；helper 停止时必须先 abort 日志转发
    任务，否则它收尾时的 `exit` 事件会把刚重启好的共享网络误判成离线。
28. **公共中继节点会掉线，禁止再写死单一节点**：`share/nodes.rs` 的 `CATALOG` 是
    候选池（当前 20 个，含社区列表补入的 tcp/udp/ws/wss 节点）。**测速只在用户点
    「测速」时进行**：进入共享页不自动探测，`share_network_start` 内部也不探测，
    节点顺序由前端缓存（`rayspeak.shareNodes.v1`）经 `peers` 传入，
    `collect_peers` 把用户选择排第一并补齐兜底；不要再把 `probe_catalog` 塞回启动流程。
    内置目录由 `share_node_options` 静态返回，节点列表常驻、未测速也可选；
    单行测速走 `share_probe_node`，只能测一个内置 id 或自定义 URI。
    支持自定义节点（URI 本身即 id，后端用 `parse_uri` 再校验），邀请码的 `nuri`
    可携带自定义节点，但仍**绝不能**包含服务器地址或虚拟网 secret。
    设置页「屏幕共享网络」的常用项是连接方式（`--p2p-only` / `--disable-p2p`）
    与画质优先（`degradationPreference`）；路由/MTU/压缩/日志在高级折叠里，
    全部经 `NetworkOptions` 白名单校验后才拼进 `easytier-core` 参数，
    不要接受任意命令行；默认日志级别是 `warn`，避免每秒 INFO 把诊断面板刷满。
29. **真实频道 id 是纯数字，不是 `c<id>`**：后端 `ChannelDto.id` 来自
    `channel.id.to_string()`（`c` 前缀只用于**组** id）；`join_channel` 也直接
    `parse::<u64>()`。共享页曾按 `c12` 解析，导致真实频道永远显示「不是真实语音
    频道」、按钮禁用。解析时要兼容两种写法但**去掉 `c` 前缀**，且空串必须
    判为无效（`Number('') === 0` 会误进频道 0 的房间）。
30. **采集帧交付是 latest-wins，别再改回逐帧请求/应答**：`capture.rs` 用
    「最新帧 + 版本号 + `Notify`」覆盖式交付，`share_capture_frame` 有新帧立即返回、
    1 秒无新帧返回空；前端优先用 `MediaStreamTrackGenerator` 喂 `VideoFrame`。
    改回 oneshot/`sync_channel(1)` 的同步模型会把「等 WGC 产帧 → IPC → 编码」
    串起来，实测帧率明显下降。轨道必须保持 `contentHint='motion'`，
    发送端 `degradationPreference='maintain-framerate'`。

31. **屏幕帧必须先压缩再过 IPC**：Tauri 走 WebView2 自定义协议，实测吞吐只有
    约 **106MB/s**（1MB ≈ 9µs，每趟另有约 2.6ms 固定开销；按 3MB 拆块后
    线性不变，别指望分块绕过）。1728×1080 的 RGBA 一帧 7.3MB ≈ 70ms，
    采集会被压到 9fps。所以原生侧缩放后输出 **JPEG q80/4:2:0**（约 200KB），
    帧头是 8 字节（宽、高，小端）+ JPEG，前端用 `createImageBitmap` 解码成
    `VideoFrame`。新增任何把大块像素/文件交给前端的路径，先按
    「字节数 ÷ 100MB/s」估算，必要时先压缩。
    编码必须在独立线程里做（`capture.rs` 的 `spawn_encoder`）：读回+缩放约 14ms、
    JPEG 约 20ms，串在 WGC 回调里就超过 33ms 帧间隔，会掉到 24fps；
    采集线程用 `try_send` 投递，编码跟不上就丢这一帧，latest-wins 不变。
    实测 1080p 端到端约 27fps（改之前是 9fps）。
    诊断面板的「采集 / 读回+缩放 / JPEG 编码 / 交付 / 编码」各行就是按这个思路分诊的。

32. **系统声音必须排除自身进程树**：可选系统音频走 WASAPI 进程回环
    （`share/audio.rs`，Windows 10 2004+），
    `ProcessLoopbackMode` 固定为 `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`，
    `TargetProcessId` 取 `GetCurrentProcessId()`。改成整个系统回环或包含自身，
    会把 RaySpeak 收到的语音再采一遍发出去，直接形成回声。音频在开始共享时
    一次性协商（没有重协商）：启动失败只允许降级成无声画面并显示 `audioError`，
    不能让共享整体失败。`share_audio_read` 固定返回**平面 f32**（L…R 分段），
    前端 `AudioData` 用 `format:'f32-planar'`；格式不一致会把声音播成噪声。
    激活参数必须用 `CoTaskMemAlloc` 放在堆上再塞进 `PROPVARIANT` 的 VT_BLOB：
    windows-rs 的 `PROPVARIANT` 实现了 Drop（`PropVariantClear`），会对
    `pBlobData` 调 `CoTaskMemFree`；指向栈上会让进程以
    `STATUS_HEAP_CORRUPTION` 立即退出（已踩过）。`Initialize` 的 flags 必须包含
    `AUDCLNT_STREAMFLAGS_LOOPBACK`，否则返回 `AUDCLNT_E_INVALID_STREAM_FLAG`
    （0x88890021），只有 AUTOCONVERTPCM/SRC_DEFAULT_QUALITY 不够。
    WGC 对被最小化窗口不产帧：`IsIconic` 必须继续上报（前端据此显示「已最小化」
    警告），不要用「最后收到帧的时间」猜停帧原因。

## 当前状态与已知缺口

已实测：空密码登录、频道顺序、消息收发（频道/私聊）、左右气泡、ray 深链（含 OS 唤起）、
头像下载与上传/删除、服务器卡片、组图标、右键菜单、exe 图标。

屏幕共享已实现：独立页面、EasyTier 公共节点组网（20 个候选，支持 tcp/udp/ws/wss）、
原生 WGC 采集、WebRTC 收发、同频道自动发现、可选 PIN、手动虚拟 IP 兜底、画质设置、
全屏观看、最小化窗口警告与**可选系统声音（进程回环，排除 RaySpeak 自身）**。
**尚未完成双机 + 真实服务器的人工验收**，也不支持多人中转树。

已知限制/可继续做的工作见 [docs/ROADMAP.md](docs/ROADMAP.md)。
其中重要的有：离线联系人头像不持久化、历史消息头像不会动态补全、
无消息历史（TS 协议限制）、无好友系统、大服务器 `clientinfo` 预取需要限流、
vendor 补丁需要随 crate 升级维护、屏幕共享无中继树。

## 提交前检查

```bash
npm run typecheck
npm run audio:check
npm run easytier:fetch   # 首次构建/打包前
cd src-tauri && cargo test --lib && cargo check
npm run app:build
```

- 搜索并确认界面/错误/日志中没有真实服务器地址或解析后主机
- 确认没有新增临时脚本、截图、`ws` 依赖
- 涉及协议行为时更新 `docs/PROTOCOL.md`
- 涉及架构/状态流时更新 `docs/ARCHITECTURE.md`
- 改 UI 后至少在 `npm run dev` 演示模式检查，并在可能时用真实窗口验证

## 文档索引

- [README.md](README.md) — 用户视角功能与运行说明
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — 模块、状态、数据流
- [docs/PROTOCOL.md](docs/PROTOCOL.md) — TeamSpeak 命令/事件与补丁说明
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — 构建、调试、打包、维护流程
- [docs/PACKAGING.md](docs/PACKAGING.md) — 打包步骤、工具链依赖与常见报错
- [docs/SCREEN_SHARE.md](docs/SCREEN_SHARE.md) — 屏幕共享：EasyTier 组网、信令、采集与限制
- [docs/ROADMAP.md](docs/ROADMAP.md) — 已知缺口与建议任务
- [docs/CHANGELOG.md](docs/CHANGELOG.md) — 变更记录（按批次：功能、协议修复、验证记录）

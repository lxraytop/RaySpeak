# 屏幕共享（EasyTier + WebRTC）

屏幕共享是一个**独立页面**（左侧导航「共享」），媒体与信令都不经过 TeamSpeak
服务器：客户端按当前 TS 频道在本地派生一个 EasyTier 虚拟局域网，同频道的
RaySpeak 客户端加入同一虚拟网，用虚拟网地址交换 WebRTC 信令，画面由 WebRTC
经 EasyTier 的 P2P 直连或公共节点中继传输。语音继续走原来的 TS3 UDP 通道，
两者互不占用、互不阻塞。

```
Windows Graphics Capture ──JPEG 帧──► Rust 采集线程
        │                              │ 拉取式 IPC（最多 1 个未完成请求）
        ▼                              ▼
   前端 createImageBitmap ──视频轨──► RTCPeerConnection ──DTLS/SRTP──► EasyTier TUN
                                                                           │
TS3 语音（独立 UDP，不变）◄── tsclient-rs ◄────────────────────────────────┘
```

## 1. 为什么这样拆

| 需求 | 做法 | 原因 |
| --- | --- | --- |
| 不走 TeamSpeak 服务器 | EasyTier 虚拟网 + 本地信令 | TS3 协议没有视频通道；公共节点只负责组网 |
| 同频道自动发现 | 房间密钥由 `SERVER_ADDR + 频道 ID` 派生 | 不把服务器地址发到前端，也不需要用户手填房间号 |
| 不依赖第三方信令 | 虚拟 IP 上的 TCP 信令 + `easytier-cli peer` 发现 | MCTier 的公网 WSS 不能复用（协议/许可/可用性都不受控） |
| 采集不弹浏览器选屏器 | 原生 WGC（`windows-capture`） | WebView2 的 `getDisplayMedia` 权限与选择器体验不可控 |
| 不影响语音 | 独立的 Rust 模块、独立前端服务、独立画布 | 不碰 `useVoice`、麦克风与 TS 协议状态 |

> 架构参照了 MCTier（EasyTier + WebRTC + 原生采集 + 静态 IP）的公开实现。
> MCTier 自有代码是「源码可得、非商业」许可，本项目没有复制其代码，
> 只按相同思路用自研 Rust/TypeScript 实现。

## 2. 房间与网络

```
room_id  = sha256("rayspeak-screen-share-v1" | SERVER_ADDR | channel_id)[0..16]
network  = "rayspeak-" + room_id[0..12]
secret   = sha256("rayspeak-screen-share-secret-v1" | room_id | pin)
peer_id  = 每次会话随机 8 hex
ipv4     = 10.126.126.2..254（随机）
hostname = "rs-" + peer_id
```

- `SERVER_ADDR` 只在 Rust 内使用，`room_id` / `network` 才返回前端。
- 前端传入的 `channel_id` 是**纯数字**（后端 `ChannelDto.id` 来自
  `channel.id.to_string()`），共享页兼容 `c<数字>` 写法但会去掉前缀；
  空串不能当成 0（否则会误判成频道 0 的房间）。
- 可选 PIN 参与 `secret` 派生：设置不同的 PIN 会进入不同的 EasyTier 网络，
  因此双方必须一致；PIN 不落盘、不写日志。
- 网络是**按频道隔离**的：不同频道 = 不同 EasyTier 网络，广播与节点列表天然隔离。

### 2.1 公共节点、手动测速与自定义节点

EasyTier 的公共中继节点由社区维护，掉线、被攻击、换地址是常态（官方
`public.easytier.top` / `public.easytier.cn` 已长期不可用）。因此**不写死单一节点**：

- `share/nodes.rs` 内置 20 个候选节点（TCP/UDP/WebSocket、国内/海外），
  用户还可以添加自己的 `tcp://host:port`（也支持 udp/ws/wss，最多 6 个）。
- **测速只在用户点按钮时进行**：进入共享页不会自动探测，结果连同时间戳缓存
  在本地（`rayspeak.shareNodes.v1`），下次打开直接展示「上次测速 X 分钟前」。
  每个节点连续握手 3 次，给出最低延迟与抖动（最大差值）。
- **节点列表常驻**：内置目录由 `share_node_options` 直接返回（纯静态，不联网），
  未测速也完整展示、可直接选择，「自动」使用缓存里最快的可达节点。自定义节点排在
  列表最前，可移除。
- **单节点测速**：每行末尾的刷新按钮调用 `share_probe_node`，只测该节点
  （内置 id 或自定义 URI），结果合并进缓存；「全部测速」仍会并发测试全部节点。
- 点「开启共享网络」后 **Rust 不再联网测速**，直接把用户的选择与缓存里的可达
  节点顺序交给 EasyTier（`collect_peers`），点击即进入 UAC。
- 自定义节点用 URI 本身作为 id；Rust 侧用 `parse_uri` 再校验一次协议、端口，
  无效地址不会进入 `--peers`。邀请码可以携带自定义节点（见 2.3）。
- 两端只要有一条节点交集就能互相发现。主节点会写进 `NetworkInfo`
  （`nodeId` / `nodeLabel` / `nodeUri`），页面显示「中继节点 xxx · 23ms」
  （延迟来自上次手动测速）。
- 全部节点都不可达时不会硬失败，而是按目录顺序给 EasyTier 前三个地址自行重试；
  真连不上时，诊断面板会带上 EasyTier 的最近日志。
- 多节点兜底可以在设置里关闭：关闭后只连测速最快的一个节点（连接更少，但主节点
  掉线后要重新开启网络才会换节点）。
- **网络评估**：测速后按「延迟 + 抖动」给优秀/良好/一般/较差，并建议最高画质
  （优秀/良好 → 1080p60，一般 → 1080p30，较差 → 720p30；仅中继模式最高 30fps）。
  这是一项保守估算，不是带宽实测；共享后诊断面板的「链路可用」才来自
  Chromium `availableOutgoingBitrate`。

### 2.2 可调参数（设置 → 网络与高级 → 屏幕共享网络）

这些参数只影响本机 EasyTier 实例，下次开启共享网络时生效；PIN 与房间密钥
不参与、不持久化：

| 参数 | 传给 EasyTier / WebRTC | 默认 | 说明 |
| --- | --- | --- | --- |
| 连接方式 | `--p2p-only true`（仅 P2P） / `--disable-p2p true`（仅中继） | 自动 | 自动模式能直连就直连，打洞失败时由公共节点中转 |
| 画质优先 | `degradationPreference`：`maintain-resolution` / `maintain-framerate` | 流畅 | 清晰模式优先保分辨率，适合文字、代码 |
| 多节点兜底 | 最多 4 个可达节点 | 开 | 关闭只连测速最快的一个 |
| 帮助转发他人流量 | `--relay-network-whitelist <本房间网络名>` | 开 | 关闭只转发本房间，降低流量与隐私暴露 |
| 路由策略（高级） | `--latency-first true/false` | 延迟优先 | 最短路径按跳数选路 |
| MTU（高级） | `--mtu <1200–1400>` | 自动（加密 1360） | 过大可能被链路分片 |
| 传输压缩（高级） | `--compression zstd` | 关闭 | 文字/代码窗口收益明显，视频收益小、多占 CPU |
| 诊断日志级别（高级） | `--console-log-level` | `warn` | `info` 用于排障，日志会明显变多 |

> 仅 P2P（`--p2p-only`）表示只和已建立 P2P 链路的节点通信；跨 NAT 打洞失败时
> 两端会连不上，这是该模式的预期行为，不是故障。

### 2.3 邀请码

`RS1.<base64url(JSON)>`，字段只有：

```json
{ "v": 1, "cid": "12", "cname": "频道名", "nid": "sz-tencent", "pin": "可选房间PIN", "nuri": "可选自定义节点" }
```

`nuri` 只在主节点是自定义 URI 时出现，导入方会校验 `tcp|udp|ws|wss` 协议并加入
自己的自定义节点列表。邀请码仍然不包含服务器地址与虚拟网密钥。

- **不含服务器地址、不含虚拟网 secret**：房间仍由接收方按自己的 `SERVER_ADDR`
  + `cid` 本地派生，所以邀请码只能邀请同一台 TS 服务器上的好友。
- 导入后会切到 `cid` 对应的频道、把 PIN 与主节点填进共享页；好友点「开启共享网络」
  即可用同一房间、同一节点观看。
- 频道在当前服务器上不存在时明确提示，不静默失败。
- 联系人私聊会自动识别消息里的 `RS1.*`：气泡下方出现「屏幕共享邀请」卡片，
  点「加入」即按邀请码切频道并套用 PIN/节点；原始邀请码不会以长串形式显示。

## 3. 启动与提权

创建 TUN 网卡需要管理员权限，RaySpeak 本身以普通用户运行：

1. 前端调用 `share_network_start`。
2. Rust 生成随机端口与 token，用 `ShellExecuteExW("runas")` 启动**同一个 exe**
   的 `--share-helper <port> <token>` 模式（UAC 只在这里出现）。
3. helper 在 `127.0.0.1:<port>` 等待带 token 的连接，收到
   `{"type":"start","program":...,"args":[...]}` 后启动
   `easytier-core.exe`（`CREATE_NO_WINDOW`），把 stdout/stderr 逐行回传。
4. app 以「能否在虚拟 IP 上 bind」为准等待网卡就绪（25 秒），失败时把最近的
   EasyTier 日志带进错误提示。
5. app 退出或连接断开时，helper 读取 EOF 后结束 easytier-core；
   `share_network_stop` 会显式发送 `{"type":"stop"}`。helper 自身消失（被结束或崩溃）
   时，app 侧连接管道 EOF，状态回落到离线并带上最近日志。

EasyTier 关键参数：

```
--network-name rayspeak-<12hex>  --network-secret <64hex>
--ipv4 10.126.126.x              --dhcp false
--hostname rs-<peer_id>
--instance-name rayspeak-<peer_id>
--rpc-portal 127.0.0.1:<random>  --rpc-portal-whitelist 127.0.0.1/32
--listeners tcp://0.0.0.0:<p> udp://0.0.0.0:<p>
--peers <测速后的主节点> <最多 3 个可达兜底节点>
--disable-ipv6 true --disable-upnp true --latency-first true
```

不使用 `--dhcp`（显式 `--dhcp false`）：静态 IP 让 app 立刻知道自己的地址，
STUN 与信令端口都能立即绑定。

生命周期上还有一条**代次（generation）规则**：`share_network_start` /
`share_capture_start` 各持一把异步锁串行执行，并在每个 await 之后比较代次；
`share_network_stop` / `share_capture_stop` 先递增代次再关闭已有对象。因此「正在启动时
点了停止」或连点两次开始，都不会留下第二个提权 helper 或第二个 WGC 采集线程。
helper 停止前会先终止日志转发任务，避免这次收尾的 `exit` 事件把刚重启的网络误判成掉线。

## 4. 发现与信令

- **发现**：每 3 秒执行
  `easytier-cli -p 127.0.0.1:<rpc> peer -o json`，取 `hostname` 以 `rs-` 开头、
  且不是本机的节点，得到 `peer_id → 虚拟 IP`。
- **信令**：每端在虚拟 IP 的 **TCP 47654** 上监听。发现到对端后主动拨号，
  收到连接也会接受。双方同时拨号时，按「peer id 较小的一方发起的连接」收敛，
  避免两条连接互相关闭。
- 握手：`{"type":"hello","peer":...,"name":...,"room":...}`；`room` 不匹配直接断开。
- 业务消息：

  | type | 方向 | 说明 |
  | --- | --- | --- |
  | `share-start` / `share-stop` | 共享者 → * | 共享列表 |
  | `view-offer` | 观看者 → 共享者 | 含 SDP |
  | `view-answer` | 共享者 → 观看者 | 含 SDP |
  | `ice` | 双向 | `role` 区分 sharer/viewer |
  | `view-stop` | 观看者 → 共享者 | 关闭该观众 |

- 兜底：页面提供「手动连接：对方虚拟 IP」，在 `easytier-cli` 不可用时直接拨号。
- 新成员加入时，共享者会重播一次 `share-start`（前端对 peer 变化做 200ms 防抖）。
- 转发给前端的 `from` 取**握手中的 peer id**，不看消息里自报的 `from`，
  同房间成员无法冒充别人发 SDP。网络停止后已建立的连接也不再转发信令。

## 5. WebRTC 与 ICE

- 观看者创建 `recvonly` 视频 transceiver 并发 offer；共享者
  `setRemoteDescription` 后把 transceiver 改为 `sendonly` 并 `replaceTrack`，
  再回 answer。
- 发送端按画质设置 `maxBitrate` / `maxFramerate`（`setParameters`）。
- **关键点：本机 STUN**。WebView2 没有摄像头/麦克风授权时，Chromium 会把 host
  candidate 混淆成 mDNS `.local`，对端无法解析。Rust 在虚拟 IP 上起一个只应答
  Binding Request 的 STUN（`share_ice_servers` 返回 `stun:<虚拟IP>:<端口>`），
  Chromium 做 srflx 探测时得到的就是 EasyTier 地址。
- 不启用 `iceTransportPolicy: 'relay'`：没有 TURN，媒体必须走 EasyTier 的
  P2P 或公共节点中继。

## 6. 采集

- `share_capture_sources` 枚举显示器与顶层窗口（WGC）。
- `share_capture_start` 以目标短边（720/1080/1440/2160）等比缩放（CPU 缩放），帧率
  30/60/120，通过 `MinimumUpdateInterval` 限速。
- **latest-wins 交付**：采集线程只保留最新一帧（版本号 + `Notify`），
  `share_capture_frame` 有新帧立即返回、1 秒无新帧返回空；消费端慢时旧帧直接被覆盖，
  不会排队累积延迟。2 秒没人取帧就跳过像素拷贝与编码。帧格式为
  **8 字节头（宽、高，小端）+ JPEG**。
  不要改回「请求 → 等下一张 WGC 帧 → 返回」的逐帧同步：采集等待、IPC 与编码会被串行，
  实测帧率会明显打折。
- **传输压缩**：Tauri IPC 走 WebView2 自定义协议，实测吞吐约 **106MB/s**
  （1MB ≈ 9µs + 每趟 ~2.6ms 固定开销，拆块也线性不变）。1080p 原始 RGBA
  一帧 7.3MB ≈ 70ms，采集只剩 9fps。因此采集线程缩放后直接输出
  **JPEG q80 / 4:2:0**（1728×1080 约 183KB、编码 13ms），帧格式为
  **8 字节头（宽、高，小端）+ JPEG**；前端 `createImageBitmap` 解码后
  交给 `VideoFrame`，静止画面复用已解码帧重发。
- **编码线程**：读回+缩放（约 14ms）与 JPEG（约 20ms）串在 WGC 回调里会超过
  33ms 帧间隔、掉到 24fps，所以采集线程只投递，编码在独立线程；编码跟不上时
  直接丢弃这一帧（latest-wins）。
- **诊断读法**：诊断面板的「采集（WGC）→ 读回+缩放 → JPEG 编码 → 交付 → 编码」
  是一条链。`采集 0` 说明桌面静止（WGC 只在画面变化时产帧，此时徽标显示
  「画面静止」）；`采集 30 / 交付 9` 是传输问题；`交付 30 / 编码 9` 才是编码或带宽问题。
  编码优先协商 H.264（Windows 上是 MediaFoundation 硬件编码），AV1 排在最后。
- **最小化窗口不产帧**：WGC 对被最小化的窗口停止产帧，观众会停在最后一帧。
  Rust 用 `IsIconic` 上报 `minimized`，统计每秒都会刷新（即使 0 帧），
  舞台上方给出「被共享的窗口已最小化，还原后自动恢复」警告；采集错误也会
  通过 `lastError` 带回来，不再让用户以为客户端卡死。共享显示器不受影响。
- 实测（1920×1200 → 1728×1080）：改之前 9fps；JPEG 后 23fps；再把编码拆线程后
  约 27fps（此时受限于源画面变化率与 30fps 目标，不是管线）。60/120fps 档位在
  1080p 下仍会被 JPEG 编码（约 20ms/帧）封顶，界面显示的是实测值。
- **视频桥**：JPEG → `createImageBitmap` → `VideoFrame` 写进
  `MediaStreamTrackGenerator`，跳过 canvas 上传；不支持时回退
  `canvas.captureStream(0)` + `drawImage` + `requestFrame()`。
  轨道 `contentHint='motion'`，发送端 `degradationPreference='maintain-framerate'`。
- 静止画面每秒重发最后一帧（前端 `byteLength === 0` 分支），保证新观众和编码器持续有画面。
  取帧循环带一个自增的**代数**：停止共享或重新开始时旧循环立即退出，
  不会留下还在向已销毁的采集会话要帧的循环；共享者也只回应 `shareId`
  与当前会话一致的 offer，过期 offer 直接忽略。
- 停止：`CaptureControl::stop()` 直接向采集线程投递 `WM_QUIT`，静止画面也能立即停；
  窗口被关闭时 emit `ts://share-capture-ended` 让前端收尾。
- **实测指标**：共享端按真实采集帧统计分辨率与帧率（1 秒窗口，来源是帧头里的
  宽高），观看端用 `requestVideoFrameCallback` 统计实际解码上屏的帧；
  阶段徽标与工具栏显示的是实测值，设置项只代表上限。
- **共享/观看支持全屏**：Tauri 窗口 `setFullscreen(true)` + 舞台 `position: fixed`
  覆盖整窗，按钮或 Esc 退出；共享/观看结束时自动退出，浏览器演示模式退回 DOM Fullscreen。
- **系统声音（可选，默认关）**：`share/audio.rs` 用 WASAPI 进程回环
  （`ActivateAudioInterfaceAsync` + `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`，
  Windows 10 2004+），`PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE`
  排除 RaySpeak 自身进程树——语音频道、提示音与自听都不会被采集回来，
  因此不会形成回声。格式 48kHz/2ch/f32，事件驱动、200ms 缓冲；
  `share_audio_read(max_frames)` 以 20ms 帧返回**平面 f32**，前端
  `AudioData({format:'f32-planar'})` → `MediaStreamTrackGenerator`，与视频一起发送。
  激活参数（`AUDIOCLIENT_ACTIVATION_PARAMS`）必须用 `CoTaskMemAlloc` 分配：
  windows-rs 的 `PROPVARIANT` 在 Drop 时会 `PropVariantClear`，对 VT_BLOB 的
  `pBlobData` 调 `CoTaskMemFree`，指向栈上会让进程直接崩堆。
  音频轨在开始共享时一次性协商（不重协商）：探活失败的机器只降级为无声画面，
  工具栏显示 `audioError`；观看端可静音，自动播放被拦截时显示「点击播放声音」。
  共享网络仍只传媒体，声音不经过 TeamSpeak 服务器。

## 7. 资源、权限与分发

- `npm run easytier:fetch` 下载官方 `easytier-windows-x86_64-v2.6.4.zip`，
  校验 SHA-256 后把 `easytier-core.exe`、`easytier-cli.exe`、`wintun.dll`、
  `Packet.dll` 放到 `src-tauri/resources/easytier/`（该目录不入库）。
- `tauri.conf.json` 通过 `bundle.resources` 映射到安装目录的 `easytier/`；
  运行时依次在资源目录、exe 同级、开发目录里查找。
- 官方 `easytier-core.exe` 静态导入 Npcap 的 `packet.dll`，因此包内附带官方
  Release 的 `Packet.dll`。Npcap 的再分发条款比 GPL/LGPL 更严格，发布前需要
  由维护者确认许可；如需彻底规避，可按 MCTier 的方式自编译去 Npcap 版本。
- UAC：每次启动共享网络都会请求管理员权限；拒绝时会得到明确错误。
- Windows 防火墙：首次监听/接收 WebRTC 流量时可能弹窗，需要允许
  `rayspeak.exe` 与 WebView2 进程；否则信令可连但画面不通。
- **secret 不外泄**：`easytier-core` 启动时会把整份 TOML 配置（含
  `network_secret`）打进 info 日志。所有日志行在进入缓存、错误提示与
  `ts://share-net-log` 之前都过 `redact()`（按 key 与按值各兜一次），
  单测 `forwarded_logs_never_carry_the_network_secret` 守着这条不变式。
  残留风险：secret 仍出现在 `easytier-core` 的命令行里，本机其它进程可枚举
  进程列表看到——同机器用户本来也能读到你的 TS 密码输入，接受此限制。
- **日志噪声**：EasyTier 正常运行时每秒都有 INFO（peer-center 同步、RPC），
  连接新中继会按秒重试到成功；本机存在已断开虚拟网卡（TAP / 蓝牙 / VMware）时，
  还会逐个尝试绑定它们的 169.254 / 旧 IPv6 地址并失败。`easytier.rs` 的
  `is_benign_noise()` 会过滤这些重复行（`bind addr fail`、`can not find interface`、
  SSDP 的 `no peer id for ip: 239.255.255.250`），日志按 350ms 批量推送，
  避免每行一次 IPC 与页面重渲染。

## 8. 已知限制

- 只有 Windows（WGC + Wintun）。
- 系统声音依赖 Windows 10 2004+ 与支持进程回环的音频驱动；旧系统或独占模式下
  会退化为无声画面（不会中断共享）。
- 无远程控制、无中继树（每个观众都由共享者单独上传一路；多人观看时上传带宽线性增长）。
- 同频道的非 RaySpeak 客户端看不到共享；跨频道需要手动房间码（当前未做 UI）。
- 帧缩放与逐帧 IPC 都在 CPU 上：2160p@120fps 会打满一核并撑爆 IPC 带宽，
  实际可用档位是 1080p/30–60（4K 建议 30fps）。
- PIN 不一致时表现为「看不到成员」，不会报错。
- 双机 + 真实服务器的完整验收仍需人工完成（UAC 与防火墙交互无法自动化）。

## 9. 验证

```bash
npm run typecheck
cargo test --lib          # 含房间派生、STUN 报文、helper 协议、日志脱敏、缩放计算
npm run app:build         # 确认安装包内含 resources/easytier/*
```

两台机器（同一 TS 服务器、同一频道）：

1. 双方进入「共享」页 → 先点一次「测速」，确认有可达节点（列表会显示毫秒数）。
2. A 开启共享网络 → 允许 UAC；页面显示主节点的延迟。
3. A 点「复制邀请码」发给 B；B 粘贴并「加入」→ 自动切到同频道并套用同一节点/PIN。
4. B 点「开启共享网络」→ 允许 UAC；双方在「房间成员」里看到对方「已连接」。
5. A 选显示器/窗口 + 画质 → 开始共享。
6. B 在「正在共享」里点「观看」；确认画面流畅、语音不中断。
7. 出错时展开页面底部「连接诊断」：可看到阶段、虚拟 IP、信令端口与最近 EasyTier 日志；
   点「连通自检」会自动跑一遍「测速 → 启动网络 → 虚拟网卡/信令 → 发现成员」。

## 10. 相关代码

| 位置 | 职责 |
| --- | --- |
| `src-tauri/src/share/mod.rs` | 房间派生、状态、命令 |
| `src-tauri/src/share/easytier.rs` | UAC helper、easytier-core 生命周期 |
| `src-tauri/src/share/nodes.rs` | 公共节点池、并发测速、节点排序 |
| `src-tauri/src/share/signal.rs` | 发现、信令 mesh |
| `src-tauri/src/share/stun.rs` | 虚拟网 STUN |
| `src-tauri/src/share/capture.rs` | WGC 采集与帧泵（JPEG 编码线程） |
| `src-tauri/src/share/audio.rs` | WASAPI 进程回环（排除 RaySpeak 自身） |
| `src-tauri/src/share/capture_math.rs` | 缩放/参数校验（单测） |
| `src-tauri/src/share/capture_stub.rs` | 测试构建的采集替身 |
| `src/screenShare.ts` | 前端 WebRTC/采集/信令服务（单例） |
| `src/components/ScreenSharePage.tsx` | 独立页面 |

# 变更记录

记录 RaySpeak 的功能演进与协议层修正。`0.3.0` 之前的批次按分支归档；当前版本 `0.3.0`。

## 0.3.0 · 分支 `feat/screen-share-easytier` · 屏幕共享（EasyTier + WebRTC）

新增独立「共享」页：屏幕画面经 EasyTier 公共节点组网、由 WebRTC 传输，
信令与媒体都不经过 TeamSpeak 服务器；语音链路完全不受影响。

### 组网与提权

- 房间密钥在 Rust 本地由 `SERVER_ADDR + 当前频道 ID` 派生（可选 PIN），
  同频道的 RaySpeak 客户端自动加入同一个 EasyTier 网络，不同频道天然隔离。
- 创建 TUN 需要管理员权限：用 `runas` 启动同一个 exe 的 `--share-helper`
  模式，由 helper 管理 `easytier-core.exe` 并回传日志；app 退出时自动结束子进程。
- 首次使用前运行 `npm run easytier:fetch` 下载并校验 EasyTier 2.6.4
  （`easytier-core` / `easytier-cli` / `wintun.dll` / `Packet.dll`），
  目录不入库，打包时映射到安装目录的 `easytier/`。
- 启动流程带代次（generation）守卫并串行加锁：启动中停止、连点两次开始，
  都不会遗留第二个提权 helper 或第二个采集线程；helper 被结束或崩溃时
  状态回落到离线并带上最近日志。

### 发现与信令

- 每 3 秒用 `easytier-cli peer -o json` 读取同网络节点，按 `rs-<peerId>`
  主机名发现同房间成员；虚拟 IP 上监听 TCP 47654 交换 SDP/ICE。
- 双方同时拨号时按「较小 peer id 发起」收敛，断开清理用 `Arc::ptr_eq`
  防止误删新连接；页面另提供「手动连接虚拟 IP」兜底。
- 转发给前端的信令发送者取握手中的 peer id，不采信消息自报的 `from`；
  网络停止后残留连接不再转发信令。

### 画质与采集

- 原生 Windows Graphics Capture 枚举显示器/窗口，GPU 抓帧后在 CPU 缩放为
  720/1080/1440/2160 短边、30/60/120fps；拉取式二进制 IPC 带背压，
  无消费者时跳过像素拷贝。
- 前端把 RGBA 帧画入离屏 canvas（`captureStream(0)` + `requestFrame`），
  经 WebRTC 发送；发送端按画质设置 `maxBitrate` / `maxFramerate`。
  取帧循环带自增代数，停止/重开共享时旧循环立刻退出；共享者只回应
  `shareId` 与当前会话一致的 offer，过期 offer 直接忽略。
- 本机 STUN 绑定虚拟 IP，解决 WebView2 把 host candidate 混淆成 mDNS
  `.local` 导致对端无法路由的问题。

### 公共节点与邀请码

- **修复真实频道无法开启共享**：后端 `ChannelDto.id` 是纯数字（`channel.id.to_string()`），
  共享页此前按 `c<数字>` 解析，导致任何真实语音频道都被判成「不是真实语音频道」、
  按钮永久禁用。现在两种格式都接受，空串不再被 `Number('')` 当成 0；
  邀请码编码/解码统一为纯数字，与频道列表 id 直接匹配。
- 不再写死三条节点（其中 `easytier.weiai.org.cn` 已不可达）：`share/nodes.rs`
  内置 14 个社区候选，页面打开与开启网络前并发测 TCP 延迟，最快可达节点作为
  本次主节点，另带最多 3 个可达兜底；全部不可达时按目录顺序交给 EasyTier 重试。
- 页面新增「加速节点」选择与「测速」按钮，在线后显示实际使用的中继节点与延迟。
- 新增邀请码（`RS1.*`）：只含频道、可选 PIN 与节点 id，不含服务器地址或 secret；
  导入后自动切到同频道并套用同一 PIN/节点，解决「两边不在同一频道/节点」导致的
  互相发现失败。
- 新增「连接诊断」折叠面板：阶段、中继节点、虚拟 IP、信令端口、已脱敏的
  EasyTier 最近日志，失败时可以直接看到卡在哪一步。

### 帧率与采集链路（参照 MCTier / RayPlay 复检）

- **交付模型改成 latest-wins**：原生侧维护「最新帧 + 版本号 + `Notify`」，前端按
  编码速度取帧；不再使用「请求 → 等下一张 WGC 帧 → 返回」的逐帧同步，
  否则采集等待、IPC、编码会被串行起来，30/60fps 都会被打折。消费慢时旧帧直接覆盖，
  不排队、不累积延迟；静止画面每秒重发最后一帧。
- **WebCodecs 视频轨**：优先 `MediaStreamTrackGenerator` + `VideoFrame(RGBA)`，
  去掉 canvas `putImageData` 与 `requestFrame` 的上传/合成；旧运行时仍回退 canvas。
- **编码器提示**：`contentHint = 'motion'`（之前是 detail，会优先保清晰度而压帧率），
  `degradationPreference = 'maintain-framerate'`（带宽不足时先降分辨率）。
- 缩放改为 32 位定点步进 + 行块拷贝；实测 2560×1440 → 1920×1080 单帧约 **2.9ms**
  （原实现约 3.3ms，且大分辨率下缓存压力更大）。
- 共享端「实际分辨率/帧率」现在反映采集→视频桥的真实吞吐，便于定位瓶颈在采集、
  IPC 还是编码。
- 共享中额外显示发送端 `getStats()` 的**真实编码帧率、编码器名与受限原因**
  （带宽 / CPU），诊断面板同步展示；「采集 fps 正常但编码 fps 低」即可直接指向
  编码或网络，而不是采集链路。

### 帧传输改为原生 JPEG（实测定位 9fps 的真正原因）

- **传输瓶颈实测**：Tauri IPC 走 WebView2 自定义协议，吞吐约 **106MB/s**
  （1MB ≈ 9µs，每趟另有约 2.6ms 固定开销；拆块后线性不变，不是「超过 4MB
  才变慢」）。1728×1080 的原始 RGBA 一帧 7.3MB，单趟就要 ~70ms，
  采集循环被压到 **9fps**。原生采集（WGC 约 27fps、读回+缩放 9.5ms）和
  编码器（同一内容 H.264/VP9 都能跑满 30fps）都不是瓶颈。
- 采集线程在缩放后交给**独立编码线程**输出 **JPEG q80 / 4:2:0**：1728×1080
  约 **240KB**。读回+缩放（~14ms）与 JPEG（~20ms）串在 WGC 回调里要 40ms、
  比 33ms 帧间隔还长，会再掉到 24fps；拆开后采集只投递、编码跟不上就丢掉这一帧
  （latest-wins 不变）。前端 `createImageBitmap` 解码后交给 `VideoFrame`，
  静止画面复用已解码的帧重发，不重复解码。
- 帧头改为 **8 字节（宽、高，小端）+ JPEG**，不再传原始 RGBA。
- 采集统计新增 WGC 到达数、构建+编码耗时与帧体积（只读计数，不影响采集），
  配合交付帧率可以一眼分清「画面静止 / 原生慢 / 传输慢 / 编码慢」。
- `setCodecPreferences` 改为 H.264 优先（Windows 上是 MediaFoundation 硬件编码），
  VP8/VP9 其次、AV1 最后；诊断面板显示实际协商的编码格式与编码器名。

### 体验与可观测性

- 修复后台周期性弹终端窗口：每 3 秒一次的 `easytier-cli peer` 探测没有
  `CREATE_NO_WINDOW`，release 无控制台时每次都会新开一个黑框；调试构建的
  helper 也补了 `FreeConsole()`。
- 联系人私聊自动识别邀请码：气泡里渲染「屏幕共享邀请 · 频道名 · 含 PIN」卡片，
  点「加入」直接切频道并套用节点/PIN；正文中的原始 `RS1.*` 串会折叠起来。
- 共享页显示**实测**分辨率与帧率：共享者统计真实采集帧（1 秒窗口），
  观看者用 `requestVideoFrameCallback` 统计真正解码上屏的帧。
- 共享/观看画面支持**全屏**：Tauri 窗口切全屏 + 舞台覆盖整窗，按钮或 Esc 退出；
  停在登录门或窗口全屏失败时退回 DOM Fullscreen（浏览器演示模式）。
- 明确「共享只传画面」：语音仍走 TeamSpeak，页脚与文档注明画面不会从语音链路回传
  （系统声音为可选项，见下批次）。
- 诊断面板新增「连通自检」：节点测速 → 启动网络（UAC）→ 虚拟网卡/信令 →
  10 秒内等待成员，逐步输出「已连通 / 等待对端」。

### 节点扩充、窗口共享停帧与可选系统声音

- **公共节点池扩充到 20 个**：保留原有 14 个可用候选，另从社区列表补入
  `easytier.weiai.org.cn`、`183.230.36.171`、`et.basd1.de`、`mc.yqst.top`、
  `et.0612.fun`、`et.chinokou.cn` 六个；`parse_uri` 开始支持 **ws / wss**
  （默认端口 80/443、忽略路径），测速仍用 TCP 握手近似。新节点同样参与排序与兜底，
  `CATALOG` 的 id 唯一、URI 可解析由单测守护。
- **共享单个窗口「停在最后一帧」的原因**：Windows Graphics Capture 对**最小化窗口**
  不再产帧，而旧页面只在有帧时才刷新统计，看起来像卡死。现在原生侧用 `IsIconic`
  判定最小化、把最近一次采集错误一并带回，统计每秒都会刷新（即使 0 帧），
  舞台上方直接给出「被共享的窗口已最小化」警告；还原窗口即自动恢复。
- **可选系统声音**：新增 WASAPI 进程回环（Windows 10 2004+），
  `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` 以 `EXCLUDE_TARGET_PROCESS_TREE` 排除
  RaySpeak 自身进程树，**语音频道、提示音与自听都不会被共享出去形成回声**。
  48kHz 立体声 f32 以 20ms 帧经 `share_audio_read` 交给前端
  `AudioData` → `MediaStreamTrackGenerator`，随视频轨一起发送；观看端可静音，
  自动播放被拦截时显示「点击播放声音」。音频轨在开始共享时一次性协商，
  不支持的机器只降级为无声画面（`audioError` 提示），不中断共享，也不落盘 PIN。
  激活参数放在 `CoTaskMemAlloc` 内存里：windows-rs 的 `PROPVARIANT` 在 Drop 时
  会 `PropVariantClear` → `CoTaskMemFree(pBlobData)`，指向栈上的参数会让进程
  以 `STATUS_HEAP_CORRUPTION` 退出。
- **诊断日志分级**：按 ERROR / WARN / INFO 着色并在标题汇总数量；补充说明
  EasyTier 的 ERROR 多为节点探测、路由表或 TUN 的失败重试，可自愈，
  阶段「已就绪」且成员正常时不代表故障；新增「复制日志」。
  本机已断开的虚拟网卡（TAP / 蓝牙 PAN / VMware）会让 EasyTier 反复尝试绑定它们的
  169.254 或旧 IPv6 地址并失败，SSDP 组播也会报「no peer id」——这些行在进入缓存与
  前端之前统一过滤（附单测）；日志改为 350ms 批量推送（或攒满 40 行立即推送），
  不再每行触发一次 IPC 与页面重渲染。
- **共享页信息层级重排**：未联网时只显示「第一步 · 开启共享网络」与
  「已有好友的邀请码？」，连上后切换为紧凑网络状态（虚拟 IP / 节点 / 信令端口 /
  成员）与邀请码按钮；「正在共享」「房间成员」独立成卡，邀请码导入与手动 IP
  收进折叠项；空舞台增加三步引导，工具栏按「来源 | 画质」分组。
  「正在共享」现在把自己那一路也算进去（标记「共享中」+ 观众数），房间成员列表
  固定显示「你」，只剩自己时明确提示「0/0 不代表故障」，不再出现自己在共享、
  侧栏却说「还没有人共享」的矛盾。
- **EasyTier 底层参数移到「设置 → 网络与高级 → 屏幕共享网络」**：路由策略
  （延迟优先 / 最短路径）、MTU（自动/1200/1300/1360/1400）、传输压缩（关闭/zstd）、
  P2P 打洞开关、多中继兜底、是否帮助转发其他网络流量、诊断日志级别
  （默认改为 `warn`，只保留警告与错误）。参数随下一次开启共享网络生效，
  共享页只展示一行当前策略摘要；全部经 Rust 侧校验后再拼进 `easytier-core` 参数，
  不落盘 PIN、不包含服务器地址。
- **「带宽受限」不再一律当成网络故障**：编码状态条新增实测发送码率（每秒按
  `bytesSent` 差值计算），并区分两种 `qualityLimitationReason=bandwidth`——
  实测码率 ≥ 上限 80% 时显示「已达码率上限」（1080p60 自动上限是 8 Mbps，
  属于画质设置里的自设值），低于则显示「网络带宽不足」；状态条附悬停说明。
  工具栏与诊断面板同步显示「实际 / 上限」Mbps，此前「编码上限 自动」既没有单位
  也看不到生效数值。
- **中继节点抖动不再刷屏**：公共节点掉线重连后，EasyTier 控制面会以约 5Hz
  连续输出 `send_msg has error errs=[RouteError(None)]`，直到路由重新同步。
  现在 3 秒窗口内正文相同的连续日志（去掉时间戳后比较）只保留第一条，停止后补一条
  「相同日志已折叠 ×N」；`peer rpc transport read aborted` 是我们自己每 3 秒
  `easytier-cli` 探活断开连接造成的，直接归入噪声过滤。新增 3 项单测。

### 节点选择、网络评估与传输模式

- **测速改为手动**：进入共享页不再自动探测 20 个节点。只有点「测速/重新测速」
  才并发握手；结果与时间戳缓存到 localStorage，再次打开直接显示「上次测速 X 分钟前」。
  每个节点握手 3 次，同时给出延迟与抖动。
- **节点列表常驻且可单选测速**：内置节点目录由 `share_node_options` 直接返回
  （不联网），未测速也完整展示、可直接选择；自定义节点排在最前并带移除按钮。
  每行末尾的刷新图标只测该节点（`share_probe_node`，内置 id 或自定义 URI），
  结果合并进缓存，不影响其他行；「全部测速」仍保留。
- **开启网络不再测速**：`share_network_start` 去掉内部探测，直接使用页面选择的
  节点和缓存里的可达顺序（`collect_peers`），点击「开启共享网络」立即进入 UAC，
  不再先等几秒。
- **可选节点与自定义节点**：节点列表按延迟排序、可点选；支持添加
  `tcp://host:port`（udp/ws/wss 亦可），最多 6 个，随测速一起测试，后端再用
  `parse_uri` 校验一次。邀请码新增可选 `nuri`，导入方校验协议后加入自己的节点列表。
- **网络评估**：测速后按延迟 + 抖动给出优秀/良好/一般/较差，并建议最高画质
  （1080p60 / 1080p30 / 720p30，仅中继最高 30fps），可一键应用。界面明确说明
  这是握手估算；共享后诊断面板新增 `availableOutgoingBitrate`「链路可用」，
  状态条继续显示实测发送码率。
- **设置页更简洁**：常用项改为「连接方式」（自动 / 仅 P2P / 仅中继）与
  「画质优先」（流畅 / 清晰），路由策略、MTU、压缩、日志级别收进「高级参数」。
  连接方式分别映射 `--p2p-only` 与 `--disable-p2p`（已用内核 `--help` 核对），
  画质优先映射 `degradationPreference`。
- 旧的 `holePunching` 字段在读取设置时自动迁移：关闭过打洞的用户变为「仅中继」。

### 验证与限制

- `npm run typecheck`、`npm run audio:check`（8/8）、`cargo test --lib`（34 项：房间派生、
  STUN 报文、helper 协议、日志脱敏/噪声过滤/重复折叠、节点目录/排序/自定义节点校验、
  单节点测速拒绝无效目标、WebSocket URI 解析、缩放采样、CLI JSON 解析、
  网络参数与连接方式参数拼装）、
  `cargo check` 与 `npm run app:build` 全绿；安装包脚本确认 `easytier-core.exe`、
  `easytier-cli.exe`、`wintun.dll`、`Packet.dll` 都装进 `$INSTDIR\easytier` 并在卸载时清理，
  产物 `RaySpeak_0.3.0_x64-setup.exe`（14.20 MiB）可正常启动。
  另用 mock 的 Tauri invoke 在浏览器里检查了「未开启 / 在线 / 共享中」三套页面布局。
  本轮新增 UI 同样用演示模式复核：节点列表（内置未测速也展示、自定义节点置顶、
  行内单测按钮、延迟/抖动/不可达）、上次测速时间、网络评估与应用按钮，
  以及设置页「连接方式 / 画质优先 / 高级参数」折叠均正常；手动测速点击与 `--p2p-only` 实际启动仍待打包版人工确认（需要 UAC）。
- 系统音频在打包后的 exe 里实测：`share_audio_start` 成功激活进程回环，
  3.2 秒读到 1414 个 20ms 包（1.2MB 平面 f32，L/R 峰值约 0.70/0.72，播放的是
  另一进程的提示音，RaySpeak 自身被排除）；WebView2 侧
  `MediaStreamTrackGenerator({kind:'audio'})` + `AudioData(f32-planar)` 可用。
  仍缺两个 RaySpeak 实例之间的人工听感验收。
- 窗口共享在打包版里实测：捕获自身窗口 1.2 秒 26 帧（约 27fps，单帧 ~86KB）；
  最小化后统计立刻返回 `minimized=true` 且基本无新帧，还原后帧率立即恢复，
  与页面警告文案一致。
- 缩放基准：2560×1440 → 1920×1080 定点实现约 2.9ms/帧（临时 rustc -O 基准，未入库）。
- 实测发现 `easytier-core` 会把整份 TOML 配置（含 `network_secret`）打进启动日志，
  已改为在进入日志缓存、错误提示与 `ts://share-net-log` 之前过滤掉（附单测）。
- 节点层实测：本机到候选节点 TCP 延迟 21–292ms，7 个可达、7 个不可达（含官方域名）；
  用两个不同 hostname 的 EasyTier 实例、相同网络名+密钥，经同一条公共节点
  `tcp://47.108.52.1:11012` 在 no-tun 模式下互相发现，确认中继能让同房间两端相遇。
- 本机以 no-tun 模式实测 EasyTier 公共节点 `tcp://225284.xyz:11010` 可连通，
  并核对了 `easytier-cli -p <rpc> -o json peer` 的真实字段（`-o` 必须在子命令前）。
- 尚未完成双机 + 真实服务器的人工验收；不支持远程控制与多人中转树；
  Windows 防火墙可能需要在首次使用时放行。系统声音依赖 Windows 10 2004+，
  旧系统或独占音频设备上会降级为无声画面。

---

## 未发布 · 分支 `feat/voice-quality-p0` · 音频设置重构

用户反馈「自听即使关掉降噪也有一堆电流声」，且默认播放管线被怀疑「表现异常」。
本批次做三件事：删掉问题最多的原生播放、把监听修成真链路、把音频设置重排成可保存的配置档。

### 删除原生播放（WASAPI / libopus / 抖动缓冲）

- 设置页移除「播放管线」卡片（原生音频播放开关、原生输出设备、刷新输出设备）。
- 删除 `set_native_channel`、`list_native_audio_outputs`、`native_audio_active`、
  `audio_self_test` 与 `--audio-self-test` 入口；`on_voice_data` 恒定转发 `ts://voice`。
- 原因：播放参考信号（`EchoRef`）依赖设备回调块长，240/480/960 波动时与采集错位，
  AEC 不收敛；设备时钟与系统定时器不同步还会周期性欠载。播放回到 WebView2 单链路，
  由 Chromium 的 AEC/NS/AGC 统一处理。
- `audio.rs` 从 2404 行缩到约 1100 行，只剩原生麦克风采集。

### 监听修复

- 设置页「本地测试 / 自听 / 校准底噪」全部改走与真实发送**同一个**
  `AudioWorklet`（`CAPTURE_PROCESSOR`），自听听到的就是「处理后、即将发送」的信号；
  以前自听走的是独立简易链路，关掉降噪时听到的底噪和真正发出去的不是一回事。
- 采集总线的电平/门限/底噪与 Worklet 报告一致；无信号时直接给出警告
  （「当前麦克风几乎没有信号，请先检测输入」），不再让用户对着一条死电平条猜。
- 自听输出跟随 `outputDevice`（`setSinkId`），并提示虚拟增强设备（FxSound）会污染判断。

### 音频设置重排 + 配置档

- 新增 8 张卡片：配置档 / 麦克风 / 音量与监听 / 扬声器 / 输入方式 / 语音处理 /
  编码与网络 / 采集诊断（仅原生采集时出现）。
- 去掉重复项：原「播放管线」「采集管线」两张卡片合并进麦克风与扬声器；
  立体声开关由音乐模式推导，不再单独暴露；输入设备在配置档内随档切换。
- **多配置档**：`AudioProfile` 保存 20 个音频字段（设备、增益、模式、灵敏度、
  降噪方式、门限、编码、抖动……），支持另存为 / 重命名 / 删除，至少保留一套；
  编辑任意音频项会即时写回当前档，语音栏左下角下拉框可随时切换。
- `AUDIO_PROFILE_KEYS` 是唯一的字段清单：新增音频设置项必须同时加入，
  否则不会随配置档保存（见 AGENTS.md 陷阱 19）。

### 验证

- `npm run typecheck`、`npm run audio:check`（7 项 Worklet DSP 断言）、
  `cargo test --lib`（Rust 门控/限幅/RNNoise/重采样）、`cargo check` 全绿。
- 真机：`rayspeak.exe --mic-scan` 可定位无信号设备；`--mic-diag 8` 输出
  WAV + 工频/嘶声/断点指标。默认 XIBERIA K03S 实测为数字静音，
  这解释了「关降噪也有电流声」——Chromium AGC 会放大全零输入。

---

## 未发布 · 分支 `feat/voice-quality-p0` · 麦克风设备选择与原生采集冲突

用户反馈：改完设置后设备选择「失效」，打开原生采集还会和设备抢占。

### 根因

- 设备选择只有浏览器的 `deviceId`，原生采集却按 cpal 设备名打开；运行时用
  `deviceLabels[deviceId]` 反查名字。未授权（`label` 为空）或从未走过 WebView
  采集时查不到名字 → 传 `null` → 原生永远用系统默认设备，看起来就是「切换无效」。
- Rust 侧 `select_input_device` 找不到指定名字时会**悄悄回落到默认设备**，
  进一步掩盖了问题。
- 设置页的本地测试 / 校准 / 设备检测 / 授权各自 `getUserMedia`，与原生采集
  同时打开同一支麦克风，在只支持单客户端的驱动上直接抢设备。

### 修正

- `AudioProfile` 新增 `nativeInput`（cpal 设备名，21 个音频字段）：选设备时把
  label 同步存下来，原生采集直接用这个名字；旧配置仍可用 label 反查兜底。
- 选择设备时如果还没授权、拿不到名字，先自动授权刷新一次再绑定；
  仍失败会提示「原生采集会继续使用系统默认麦克风」，不再静默。
- Rust 找不到指定设备时返回错误「找不到麦克风「X」」，前端提示并回退 WebView，
  不会再假装切换成功。
- 本地测试 / 自听 / 校准底噪 / 检测输入 / 授权期间通过 `onAudioTestHold`
  让原生采集释放设备，开麦前等 260ms（IPC + 120ms 防抖）；结束后自动恢复。
- 测试时的电平条优先显示本地测试值（此时原生事件会停更）。
- 设备下拉去重：未授权时 `deviceId` 全为空串，不再出现多个同名空选项。

---

## 未发布 · 分支 `feat/voice-quality-p0` · 监听、频道交互与资料同步

针对实测反馈的三处问题：自听仍然没声音、频道需要双击进入、个人描述不同步。

### 自听（本地监听）修复

- 根因一：`CAPTURE_WORKLET_SOURCE` 的 `process()` 只把处理结果 `postMessage` 给主线程，
  从未写回 `outputs`，所以 `node.connect(destination)` 拿到的是静音——开关怎么点都没声音。
  现在处理后的整帧进入输出队列，按渲染块写给 `outputs`（最多落后一帧，10–60ms）。
- 根因二：关闭自听时用 `context.createGain()`（默认增益 1）连接 destination，
  本地测试一开麦克风就会一直外放；改为固定增益节点，开关只切 0/1。
- 根因三：`getUserMedia` 等 await 之后用户手势过期，新建的 `AudioContext`
  常驻 `suspended`；现在与 `useVoice` 一致，创建后显式 `resume()`。
- 新增离线断言「自听（监听）输出有信号」，`npm run audio:check` 现为 8 项。

### 底噪可见

- 电平条读数补上「底噪 X dBFS」，并在按钮下方说明校准口径：
  安静环境采 1.8 秒、取 20% 分位电平、自动阈值 = 底噪 + 9 dB（附当前数值）。
- 删除「诊断录音」按钮及其后端：`analyze_mic_sample` 命令、`micdiag::analyze_frontend`、
  `protocol.analyzeMicSample`。现场排查仍可用 `rayspeak.exe --mic-diag` / `--mic-scan`。

### 频道交互

- 频道列表改为**双击进入/切换频道**，单击只切换查看的频道（TS3 行为），
  行内提示补充「双击进入频道」。
- 进出提醒与提示音只在**自己所在频道**有人进入/离开时触发；其它频道的流动不再打扰。
  自己换频道只在消息区留一行记录，不播提示音。
- 删除成员卡片上「这是你 · 可在设置中修改昵称」小字。

### 个人描述同步

- `clientupdate` 不接受 `client_description`，自己的简介要用
  `clientedit clid=<self> client_description=...`（权限 `b_client_modify_own_description`）。
- 连接后拉取自己的 `clientinfo` 作为基线：服务器有简介就回填设置；
  拿不到时以本地值为基线，用户后续编辑仍会推送。
- 自动同步的防抖不再依赖 `clients` 快照（以前每次快照都会重置 900ms 计时器），
  只在昵称/描述变化时启动；推送失败会 toast 具体原因，不再静默吞掉。

---

## 未发布 · 分支 `feat/mic-diagnostics`

针对「关掉降噪自听仍有电流声」的排查与重建：先让问题可测量，再消除能制造断点的代码路径。

### 测量：把「电流声」拆成可区分的三类

新增 `rayspeak.exe --mic-diag [秒]`：用 WASAPI 直接录默认麦克风（按设备原采样率），
输出 `mic-diag-raw.wav` / `mic-diag-processed.wav`（同一段信号过一遍真实 DSP）与
`mic-diag.json`，指标包括：

- `dcOffset`、`peakDbfs`、`rmsDbfs`、`clippedSamples`
- `floorDbfs` / `medianDbfs`（100ms 分窗 RMS 的 10% / 50% 分位，避开说话段）
- `humRatio` + `humFreq`：45–65 / 95–125 / 145–185 / 235–245 Hz 四个**不重叠**频带
  的能量占比（区间统计，避免 50 与 60 Hz 在 11.7 Hz 分辨率下互相覆盖导致占比 >1）
- `highBandRatio`：>6 kHz 能量占比（嘶声）
- `clickCount` / `clickBoundaryHits`：相邻样本差值的离群点，以及其中落在
  480/960 样本网格上的比例 —— 用于区分「代码丢帧」与「设备中断」
- `verdict`：把指标翻译成结论（工频哼声 / 高频嘶声 / 底噪偏高 / 削波 /
  断点集中在帧边界 / 采集几乎无信号）

「典型电平（中位数）」< −70 dBFS 或整体 RMS < −60 dBFS 时判为「采集期间几乎没有
持续信号」，不再给出频谱结论——否则数字静音下噪声除以噪声会算出 80% 的「工频占比」。

新增 `rayspeak.exe --mic-scan`：逐个打开输入设备各录 1.2 秒，报告 `hasSignal`。
设置页也有对应的「检测麦克风输入」按钮（每个设备 0.8 秒），可直接一键改用有信号的设备
（同时更新 WebView 的 deviceId 与原生采集的设备名）。

### WebView 链路也能录：`analyze_mic_sample`（后续批次已移除，见下）

设置页「诊断录音」用与真实发送**同一个** AudioWorklet 录 8 秒，
前端把 Float32 PCM 交给 Rust 分析与落盘（下载目录 `mic-webview.wav`），
返回峰值/底噪/工频占比。这样可以直接对比：
「WASAPI 原始」（`--mic-diag`）vs「WebView 处理后」（诊断录音）vs「自听听到的」。

### 重建：试听与诊断不再走另一条链路

- 把 AudioWorklet 源码抽到 `src/audio/captureWorklet.ts`，`useVoice` 与设置页共用。
  之前设置页的「本地测试 / 自听」是 `getUserMedia → gain → destination`，
  完全绕过高通/降噪/门控，所以「关掉降噪后听到的底噪」并不是实际发送的信号。
  现在试听听到的就是处理后的待发送信号（与 Discord 的麦克风测试一致）。
- 输出侧显式提示：默认输出若是 FxSound 之类的虚拟增强设备，其自身音效会干扰判断。

### 消除断点：原生采集不再整块丢样本

设备时钟与 10ms tick 漂移时，旧实现「占用超过 4 帧就 `pop_front` 丢弃」，
在波形中间留下跳变——听感正是「电流声/咔哒」。改为 ±0.5% 的速率伺服
（按占用偏差微调重采样步长），只有真正断流（占用 > 8 帧）才重同步。

---

## 未发布 · 分支 `feat/audio-reliability`

原生播放的可靠性与可观测性修复，以及「设备不配合时也能用」的兜底。

### 原生播放：三处根因

- **AEC 参考错位**：原来把「最近一次输出回调的前 480 帧」复制进固定数组。
  设备回调块长常见 240/480/960，5ms 回调时后半段永远是上一次的陈旧样本，
  参考与采集因此逐帧错位，Speex AEC 永远收敛不了。改为 `EchoRef` FIFO：
  输出回调把单声道混音推入队列，麦克风每 10ms 取一块，固定落后 20ms；
  块长变化只影响队列长度，不影响对齐。诊断面板新增「回声参考积压」，稳定应 ≈960 样本。
- **锁序倒置与回调阻塞**：`encode_mic_frame` 在持有 `Worker` 锁时直接
  `client.send_voice`，而发送要拿协议核的锁；收包线程 meanwhile 在核锁内回调
  `push_packet` 再拿 `Worker` 锁 —— 形成 `worker → core` 与 `core → worker` 的
  反向嵌套，轻则设备回调错过 deadline（周期性哒哒声），重则卡死。
  现在编码只入队，UDP 发送由 tick 线程在锁外完成。
- **设备错误被吞掉**：`DeviceChanged/Xrun/...` 在错误回调里直接 return，
  拔耳机或切默认设备后流已死但 `active` 仍为 true（表现为「播放引擎运行中却没声音」）。
  现在非 Xrun 错误会标记 inactive、请求重建输出流（2 秒退避），并通知前端先回退浏览器播放。

### 播放质量

- 混音输出接软限幅（与采集侧同一算法），三人以上同时说话不再硬削。
- 闭麦时不再解码：清空各客户端 PCM 并跳过 Opus 解码，避免在设备回调里做无用功。
- 发声判定忽略已静音的客户端，不再把静音成员的帧算成欠载。

### 设备兼容

- **任意采样率麦克风**：`pick_input_config` 不再硬性要求 48 kHz。
  优先 48k，其次 44.1k，取不到就接受设备默认值，由新增的线性重采样拉回 48 kHz
  （`resample_into`，480 输出样本消费 `480 × 设备率/48000` 个输入样本）。
  蓝牙耳机与老声卡不再「一开原生麦克风就全静音」。
- **原生采集失败自动回退**：`ts://audio-engine` 的 mic 错误会把本次会话切回
  WebView 采集（`nativeMicActive`），并在通知里说明原因；切换开关或输入设备后重试。

### 可自行验证

- `npm run audio:check`：把 AudioWorklet 的 DSP 源码抽到 Node 里跑 7 项断言
  （门深 −18 dB、门放行、直通、过载 1.000、高通 50Hz/1kHz、参数热更新）。
- `cargo test --lib`：8 项，新增回声参考 FIFO 对齐（含 5ms 回调拼接）、
  44.1k 重采样电平与消费步长、线性插值。
- `rayspeak.exe --audio-self-test`：不启动界面，直接打开默认输入/输出设备各 900ms，
  在**当前目录**输出 `audio-self-test.json`（设备名、采样率、声道、格式、回调次数、
  实际/期望帧数、采集峰值与 RMS）。用于现场排障。

---

## 未发布 · 分支 `feat/denoise-choice`

把降噪从「一个开关」变成「可选择的降噪链」，两条采集链路都有真实的音频处理，
而不是只把开关传给 Chromium。

### 可选降噪方式（5 档）

| 方式 | 实现 | 链路 |
| --- | --- | --- |
| 关闭 | 不处理 | 两条 |
| 噪声门 | 自研门控（阈值 / 深度 / 快开慢关） | 两条 |
| 智能降噪 | Chromium 谱减 | WebView |
| SpeexDSP | `speex_preprocess` 谱减 | 原生 |
| RNNoise | `nnnoiseless`（Xiph RNNoise 纯 Rust 移植） | 原生 |

- 新增 `Settings.noiseSuppressor`，替换原来的布尔 `noiseSuppress`；
  旧配置按「关 → off、开 → chromium」迁移。
- 选中需要原生采集的降噪器但未开启原生麦克风时，自动退化为噪声门，
  设置页明确标注当前实际生效的方式（`effectiveNoiseSuppressor`）。

### 采集侧 DSP（两条链路语义一致）

- **80 Hz 一阶高通**（`highPass`）：去掉直流与桌面震动/空调低频，
  12 dB/oct 的滚降在 50 Hz 约 −5.5 dB、1 kHz 基本无损。
- **软限幅**：0.7 以上用 tanh 压到 1.0，输入增益拉到 200% 也不再硬削。
- **噪声门**：低于发送阈值时把整帧压到 −depth dB（6–36 可调）而不是硬静音，
  开约 5 ms、关约 170 ms，避免“呼吸感”；阈值与 VAD 共用，电平在门之前测量，
  所以门衰减不会改变 VAD 的判定。
- WebView 侧在 AudioWorklet 内实现（`highPass / gateEnabled / gateDepthDb`
  通过 port 消息实时下推）；原生侧在 `MicDsp` 内实现。
- RNNoise 按 480 帧 / ±32768 标定接入，首帧伪影丢弃，切换降噪方式时重建状态。

### 验证

- 新增 4 个 Rust 单元测试：门的衰减与重开、软限幅上界、高通去直流、RNNoise 输出有限
  （`cargo test --lib` → 5 passed）。
- AudioWorklet 的 DSP 另用 Node 抽出来跑了正弦输入：门稳态 −18 dB、门关直通、
  2.4 倍过载峰值 1.000、50 Hz 残余 0.53 / 1 kHz 0.99。
- `nnnoiseless` 关闭默认 feature（不再编译自带的 clap/hound CLI 依赖）。

---

## 未发布 · 分支 `feat/audio-settings-ts3-parity`

按 TeamSpeak 3 / Mumble / Discord 的成熟做法重做「语音与音频」设置页，
并把新增参数接到真实链路（WebView 与原生采集共用同一套语义）。

### 输入灵敏度（自动底噪跟踪）

- 新增 `inputSensitivity`（auto / manual）与 `noiseFloorDb`：自动模式用
  「下降快、回升慢」的 min-tracker 跟踪环境底噪，发送阈值 = 底噪 + 9 dB，
  夹在 −60…−20 dBFS。说话期间只允许底噪下降，避免人声把阈值一路抬高
  之后听不到自己。
- 设置页新增「校准底噪」：采集 1.8 s 后取 20% 分位作为底噪，避免偶发静音帧
  把结果压死；校准结束自动切到自动灵敏度并提示实际阈值。
- 电平条改为参考 TS3 / Discord 的样式：实时电平 + 阈值刻度 + 底噪标记，
  并显示「发送中 / 静音」。已连接时数据来自真实链路（`rayspeak:level` 新增
  `db/thresholdDb/floorDb`），未连接退回本地测试，原生采集读 `ts://mic-activity`。

### 输入方式

- `inputMode` 增加 `open`（常开），与 Mumble 的持续发送一致；原生采集同步支持，
  `NativeAudioConfig.inputMode` 接受 `open`。
- 保持时长可调（`voiceHoldMs`，100–1000 ms，默认 300），替换前端与 Rust 中
  硬编码的 280 ms；PTT 模式下复用为「松键收尾」，避免尾音被切断。

### 语音处理预设

- 新增四档预设（关闭 / 轻度 / 标准 / 音乐），对齐 TS3 的 DSP 预设与
  Discord 的三开关组合；预设只写入 `echoCancel / noiseSuppress / autoGain`，
  未命中任何预设时显示「自定义」。音乐预设同时打开立体声与 96 kbps。

### 设备自检

- 设置页新增「本地测试」与「自听」：使用与真实链路相同的 `getUserMedia` 约束
  （AEC/NS/AGC），可把处理后的人声回放到所选扬声器（建议耳机）。
- 新增「测试扬声器」：三段测试音走所选输出设备（含 `setSinkId`），
  原生播放开启时同样有效。

### 修复

- 前端 VAD/PTT 边界的 12 ms 淡入淡出此前只算在临时数组里，`AudioData` 仍传
  原始缓冲，等于完全没生效；现在把包络写回真正送编码器的缓冲，起停爆音消失。

---

## 未发布 · 分支 `feat/voice-quality-p0`

第一批语音质量修复：不改协议，先把「字被吃掉、忽大忽小、越聊延迟越大」解决。
第二轮针对实测反馈的「首字爆音、音乐中的微量电流声」，对齐 Mumble / ts3j 的做法。

### 原生播放引擎（P1a，可选；**已移除**，见顶部说明）

- 新增 `src-tauri/src/audio.rs`：cpal/WASAPI 输出 + audiopus/libopus 解码，
  独立音频线程完成按 `packetId` 排序、自适应抖动缓冲、丢包 PLC/FEC、淡入淡出与混音。
- 设置 → 播放管线 → 原生音频播放（默认关闭）。开启后语音包直接投递到 Rust，
  不再向前端回传 base64；初始化失败自动回退 WebView 播放。
- 新增每用户增益/静音、总音量、闭麦、输出设备与抖动参数的统一下发。
- 播放设备可在设置中直接选择（`list_native_audio_outputs`，来自 WASAPI），
  留空跟随系统默认；切换后重新打开输出流。
- 新增播放诊断卡片与 `native_audio_stats` 命令：实时显示引擎状态、输出设备、
  采样格式、收包/丢包、隐藏帧、欠载与最大客户端抖动，便于客观验证播放链路。
- 构建：`audiopus_sys` 需要 CMake；`app:dev` / `app:build` 改由
  `scripts/tauri-run.mjs` 包装，自动定位 VS BuildTools 的 CMake。
- 限制：采集仍是浏览器链路（保留 AEC/NS/AGC），原生输出绕过 Chromium AEC，
  外放场景建议保持关闭或使用耳机。

### 原生采集 + SpeexDSP APM（P1b，实验性）

- 设置 → 语音与音频 → 采集管线新增「原生麦克风采集」，默认关闭；开启后
  `useVoice` 不再调用 `getUserMedia`，Rust 侧 cpal/WASAPI 直接采集 48 kHz、
  10 ms 帧并编码 Opus 直接 `send_voice`，不再经过前端 base64。
- APM 使用 SpeexDSP（`aec-rs-sys`，Mumble 同源）：回声消除、噪声抑制、
  自动增益；回声消除需要同时开启原生播放，用播放混音作为参考信号，
  否则只做降噪与 AGC。
- VAD/PTT 门控在 Rust 内完成：保持 280 ms、预滚 12 帧、起止 10 ms 淡入淡出；
  静音/闭麦会立即停止发送。PTT 状态通过 `set_native_ptt` 实时下发。
- 采集侧固定 10 ms 处理节奏，输入缓冲超过 40 ms 时主动裁剪，避免设备与
  定时器时钟漂移积累延迟。
- 新增 `list_native_audio_inputs`、`set_native_ptt` 与 `ts://mic-activity`；
  诊断卡片增加采集状态、输入设备、电平/发送门、已发送帧与输入溢出。
- 构建新增 `libclang`（bindgen）依赖，`scripts/tauri-run.mjs` 会自动探测
  pip 安装的 `libclang.dll`；SpeexDSP 静态链接进 exe。
- 限制：当前无法在开发机上实测麦克风输入，默认保持关闭；SpeexDSP AEC 的
  收敛速度与残留回声抑制弱于 WebRTC AEC3，外放场景仍建议耳机。

### 原生播放切频道修复

- **播放架构改为设备回调拉取**（对齐 Mumble 的输出模型）：删除独立 10ms
  生产线程、环形缓冲与 `producer.push_slice`，改由 WASAPI 回调按设备时钟
  现场从抖动缓冲/Opus 解码器取帧并混音。这样不存在“定时器时钟 vs 设备时钟”
  的漂移，也不会再因为生产/消费不同步产生周期性欠载与卡顿。
- 麦克风采集与统计仍由 10ms 线程负责，但只使用 `try_lock`，抢不到锁就跳过，
  避免与设备回调争锁导致播放中断。
- **PLC 时序**：20ms/60ms 语音包在 10ms 音频 tick 之间会出现短暂空档，原实现
  把它当成丢包并推进包序号，导致随后到达的真实包被丢弃，听感是周期性电流与
  卡顿。现在只有在静音超过抖动窗口后才进入 PLC；起播先预缓冲 1.5 倍窗口，
  PCM 断流恢复时强制淡入。新增回归测试锁定 20ms 包的稳定播放。
- 新增 `channelId` 配置与 `set_native_channel` 命令：自身所在频道变化时立即
  清空全部播放客户端（抖动包、PCM、Opus 解码器），不再出现切频道后继续播放
  上一个频道或叠音。
- 静默超过 5 秒、且没有在播音频的客户端会被回收，避免离开/静默成员长期占用
  解码器。
- 抖动等待从“半个缓冲窗口”改为完整窗口（低延迟 0.6×、均衡 1×、稳定 1.6×），
  与 WebView 路径更接近，减少频繁 PLC/FEC 带来的“碎”感。
- 设置中把原生播放标注为实验性，并建议出现异常时先关闭。

### 爆音与电流声

- **顺序根因**：crate 原来为每个语音包 `tokio::spawn` 一个任务派发事件，多线程
  runtime 会打乱顺序，前端到包即解码，听感就是持续爆音。改为同步派发。
- **包序号**：`VoiceData` 暴露 16 位 `packetId`；前端按序号排序、去重、检测丢包，
  自适应重排窗口（低延迟 30ms / 均衡 60ms / 稳定 100ms）。乱序不再直接进解码器。
- **丢包补偿**：缺失包用上一帧重复并渐弱填充，后续包接上时淡入，避免硬切爆音；
  单次最多补 3 帧，超过则直接续播。
- **边界淡入淡出**：起播/重同步加 8–10ms 淡入；发送端 VAD 开合各加 12ms 淡入淡出，
  预缓冲首帧也走淡入。

### 发送端

- Opus 编码补齐调优参数：`application=voip` / `signal=voice`、`complexity=10`、
  带内 FEC、按帧长设置 `frameDuration`；旧 WebView2 不认这些参数时自动退回最小配置。
- 去掉编码器输出回调里的二次门控——之前会用“当前电平”丢掉已经编码好的帧，
  导致句尾和重音被切。现在只在采集端做一次门控。
- VAD 增加 280ms hold 与 120ms 预缓冲：重新开口时先补发缓冲里的帧，字头不再被切；
  PTT 按下时同样补发预缓冲。
- 默认打开 AGC（`autoGain: true`），并对旧配置做一次迁移，只改仍等于旧默认值的字段。

### 接收端

- 每位说话人独立的抖动估计与自适应缓冲：按到达间隔偏差调整目标延迟；
  延迟超过目标 2.5 倍或静音超过 500ms 时重新对齐，避免越聊延迟越大。
- 按语音包 codec 选择单/立体声解码，平面数据完整写入 AudioBuffer，音乐模式不再只剩左声道。
- 收到 Speex/CELT（codec 0–3）不再误送 Opus 解码器，改为一次明确提示。
- 连接拆除后解码输出不再继续排队播放。

---

## 未发布 · 分支 `feat/ux-polish-batch`

一批「先把能用做对」的修复：成员可见性、加密频道、界面可读性与本地持久化。
四个提交，均在真实 TeamSpeak 服务器上实测。

### 一、成员可见性（协议层根因）

问题：新账号进服后只能看到自己当前频道的人，别人在隔壁频道就永远不出现；
联系人页也因此无法判断对方是否在线。

排查结论（抓真实下行报文得到）：

| 命令 | 语音连接（`client_type=0`）的实际结果 | 归属 |
| --- | --- | --- |
| `servernotifyregister event=...` | `error id=516 invalid client type` | 仅 ServerQuery 会话可用 |
| `clientlist -uid -away -voice -groups` | `error id=2568 insufficient client permissions` | 仅 ServerQuery 会话可用 |
| `channelsubscribeall` | `error id=0 msg=ok` | ✅ 语音连接的正确做法 |

修复：`connect_server` 在欢迎流就绪后发送 `channelsubscribeall`，服务器随即补推
所有频道的 `channelclientlist` / `notifycliententerview`，本地目录即拥有全服成员；
快照循环每 ~30 秒重发一次做无损重同步，`refresh_directory`（刷新按钮）同样先重订阅。
订阅失败只降级为「仅当前频道可见」，不中断连接。

参考实现对照：WebSpeak（`@honeybbq/teamspeak`）在欢迎流之后调用的正是
`channelsubscribeall`，并从 SDK 本地目录读成员，同样不发 `clientlist`。

### 二、加密频道加入失败

现象：密码输入正确仍提示“密码不正确”，服务器回 `781 invalid channel password`。

根因：语音连接的密码字段必须是 `base64(sha1(明文))`，不是明文。crate 原本只对
登录密码与默认频道密码做了哈希，`clientmove` 的 `cpw`（以及文件传输的 `cpw`）漏了。

修复：

- `client_move()` 与 `ftinitupload` / `ftinitdownload` 的 `cpw` 统一走
  `prepare_client_password()`（该函数提升为 `pub(crate)`）
- 781 / 2568 分开映射：前者是密码被拒，后者是加入权限值不足，不再混为一谈
- 密码错误时保留弹窗并显示原因，可直接重试；日志中 `cpw` 一律打码

### 三、协议层清理（回退无效改动）

排查期间在 vendor 里加过三处无效改动，确认从未生效后全部回退：

| 改动 | 为什么无效 |
| --- | --- |
| `Client::refresh_clients()`（`clientlist`） | 语音连接恒回 2568，每次连接与每 30 秒白发一条命令 |
| `Client::refresh_channels()` + `api::list_channels_with_flags()` | 同样 2568；密码位欢迎流本来就带 |
| 两处 `RAYSPEAK_TRACE` 诊断日志 | 定位已完成；`handle_command_str` 每条下行命令查一次环境变量，属热路径开销 |

现状：vendor 与上游 crate 0.2.7 的差异只剩 **3 个文件、17 行**（全部是 `cpw` 哈希），
升级 crate 时的冲突面最小。补丁清单见 [PROTOCOL.md §8](PROTOCOL.md)。

### 四、界面与外观

房间头部（隐藏「共享 / 文件」后重排）：

`布局切换 → 在线状态（在线/离开/勿扰，带下拉菜单）→ 深/浅色互切 → 频道动态 → 邀请 → 房间设置`

- 在线状态复用既有 `presenceStatus` / `dnd`，切换即同步服务器；窄窗口自动隐藏主题按钮避免换行
- 共享与文件只隐藏入口，命令、弹窗、设置项全部保留，恢复只需放回按钮

频道树：

- 人数改为徽章：有人时强调色描边，无人时弱化；悬浮显示「N 人：张三、李四…」
- 父子层级用缩进 + 左侧竖线表达；`[cspacer]` 分隔频道按**真实频道**处理
  （可进入、显示人数与成员，仅行样式更接近分组标题）
- 服务器卡片显示「X 个频道有人」，成员面板头部显示「其他频道 N 人」

联系人页：

- 头像带在线状态圆点（在线/离开/离线）、所在频道标签、在线优先排序
- 「加入 TA 的频道」支持跨频道跳转；离线时禁用私聊 / 邀请 / 戳一戳

外观设置：

- 新增「纯色区域不透明度」：30–100%，默认 80%，统一作用于卡片、侧栏、面板、弹窗
  （`--panel*` 走 `calc(alpha * var(--opacity-k))`）
- 新增快速预设：清爽 / 沉浸 / 高对比，一键切换主题·模糊·面板透明度·对比度
- 新增高对比度模式（`data-contrast="high"`），重定义正文/次要色与描边
- 浅色与深色的次要文字色各收紧一档，改善毛玻璃面板上的小字可读性
- 卡片标题在窄窗口不换行（次要提示按宽度隐藏），键盘焦点环改为强调色

### 五、通知与提示音

- 有人进出频道（含自己换频道）播放短提示音：上行/下行两个音，音量明显低于消息提示
- 900ms 去抖，避免大频道连续进出时响成一片；勿扰模式自动静音
- 设置 → 通知 → 频道提醒 新增「进出提示音」开关
- 系统消息同步写入本地聊天记录（「X 加入了「Y」」「你加入了「Z」」）

### 六、本地持久化与在线判定

新增 `src/utils/localStore.ts`：

- `rayspeak.avatars.v1`：按 `uid+hash` 缓存头像 data URL，48 条上限、LRU 淘汰、去抖写入
- `rayspeak.contacts.v1`：联系人目录（昵称/头像 hash/简介/最后频道），60 天过期

效果：重启后离线联系人与历史私聊仍有头像和昵称；历史消息按当前成员表动态补全头像；
**是否在线只由当前快照推导**，绝不依据本地缓存伪造在线状态；离线时输入框禁用并提示
TS 不保存离线消息。

### 七、设置默认值调整

| 项 | 旧 | 新 |
| --- | --- | --- |
| 麦克风 / 扬声器音量 | 78 / 82 | 100 / 100（单位增益） |
| VAD 阈值 | −38 dBFS | −45 dBFS |
| 抖动缓冲 | 60 ms | 80 ms |
| 连接超时 | 15 s | 20 s |
| 背景模糊 | 18 px | 12 px |
| 背景遮罩 | 40% | 30% |

旧配置通过 `rayspeak.settings.defaults` 版本标记迁移：**只替换仍等于旧默认值的字段**，
用户手动改过的保持不动。

### 八、文档同步

- `docs/PROTOCOL.md`：第 2 节目录与排序、第 3 节改为「成员可见性与事件订阅」能力对照表、
  3.1 节补 `cpw` 哈希规则、第 8 节 vendor 补丁清单新增第 5 条
- `docs/ARCHITECTURE.md`：快照循环改为重订阅、重写「成员可见性」小节
- `AGENTS.md`：陷阱 15/16 记录 `channelsubscribeall` 与 `cpw` 规则、本地缓存键、面板透明度

### 验证记录（真实服务器）

- 跨频道成员：自己在新频道时，频道树里其他频道的人与其人数正常显示；
  成员面板显示「其他频道 N 人」
- 加密频道：密码正确 → `clientmove` 成功、自身 cid 变更、系统消息落地；
  密码错误 → 停在弹窗并提示「频道密码不正确，请重新输入」
- 视觉：浅色/深色、1440 与 1024 宽、演示模式与真实窗口逐页检查；
  不透明度滑杆用 0.2 / 3 两档做过像素 diff，确认 `--opacity-k` 真正生效
- 构建：`npm run typecheck`、`cargo check`、`npm run app:build` 全部通过

### 提交

| 提交 | 内容 |
| --- | --- |
| `258e53e` | 资料同步、频道人数可见性、进出提示音、本地在线状态、外观不透明度 |
| `0c9d97a` | `channelsubscribeall` 取全服成员、781/2568 错误分类、界面与外观细化 |
| `d254e71` | `cpw` 改 `base64(sha1(密码))`，修好加密频道加入 |
| `3964d76` | 回退协议层无效改动，仅保留 `cpw` 哈希 |

### 遗留事项

- 版本号仍为 `0.2.0`，如需区分该批次可同步提升 `package.json` / `tauri.conf.json` / `Cargo.toml`
- 「共享 / 文件」入口仍隐藏（功能完整，仅未暴露按钮）
- 大服务器首次连接仍会为每个成员预取 `clientinfo`，缺少并发限流
- 升级 `tsclient-rs` 时需要重新应用 vendor 补丁（清单见 `docs/PROTOCOL.md §8`）

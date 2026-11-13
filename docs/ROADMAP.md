# 路线图与已知缺口

本文件列出当前实现边界和建议的后续任务。接手时优先处理与真实协议相关、
可验证的问题，不要把“协议做不到”的功能做成假数据。

## 1. 当前确定做不到 / 不伪造

| 项 | 原因 |
| --- | --- |
| 消息历史 | TeamSpeak 3 服务器不提供历史消息接口 |
| 好友系统 / 好友在线状态 | TS 协议没有好友模型 |
| 屏幕共享视频 | TS3 不传输视频，当前仅本地预览 |
| 服务器管理后台 | 受权限限制，访客可用命令很少；无 ServerQuery 登录 |
| 跨服务器 | 客户端只连接单一固定服务器 |
| 消息已读回执 / 输入状态 | 协议不提供 |

这些功能如要做，只能明确标注为本地能力（如本地屏幕预览），不能伪装成服务器同步。

## 2. 高优先级

### 2.1 自动化测试

当前没有测试套件，至少补充纯函数单测：

- `avatar_file_name()`：UID → a-p 文件名（固定向量）
- `parseRayLink()` / `rayInviteLink()`：编码、非法链接、中文频道名
- `utils/tsText`：颜色、粗体、spacer、URL、转义
- `utils/live.toClient/toChannel`：组命名空间、头像 hash 变化时清空 avatarUrl
- 快照去重与消息去重逻辑（建议先抽成纯函数）

Rust 侧可为 `build_snapshot`、`server_info_from_properties`、
`avatar_mime` 增加单测。

### 2.2 头像与离线/历史展示

已完成（`src/utils/localStore.ts`）：

- 头像按 `uid + avatarHash` 持久化到 localStorage（上限 48 条，超出按最久未用淘汰）
- 联系人目录记录昵称/头像 hash/简介/最后所在频道，重启后离线联系人仍有头像与昵称
- 在线状态以当前快照为准在本地判定：快照里的成员为在线，其余为离线，
  私聊对离线成员禁用发送并给出明确提示

仍待补：

- 历史消息没有 `avatarUrl`；可在渲染时按 clientId 动态查表，而不是发送时快照
- 头像缓存目前是 localStorage，条数上限较低；可迁移到 IndexedDB 支持更多联系人

### 2.3 大服务器性能

`applySnapshot()` 会为每个新客户端调用 `clientinfo`。人数多时会瞬时产生大量请求：

- 增加并发上限或队列
- 失败退避，不要每个快照重试
- 头像下载同样限流，仅对可见频道或当前布局加载

### 2.4 资料实时性

简介、平台、版本、频道组只在首次出现或打开资料卡时拉取。
可监听 `notifyclientupdated` 中的相关字段，或对已缓存客户端做低频刷新。

### 2.5 频道目录强制刷新

`refresh_directory` 复用 crate 目录缓存，仅刷新组与 codec quality。
若怀疑错过 `server/channel` 通知，当前没有“强制重拉 channellist”的公开 API。
可在 vendor 中增加安全的目录重建入口，或在刷新时提示用户重连。

### 2.6 语音质量

已完成（分支 `feat/voice-quality-p0`）：Opus 调优、单次 VAD 门控 + hold/预缓冲、
默认 AGC、按人自适应抖动缓冲、单/立体声正确解码、非 Opus 编码提示。
第二轮：语音事件同步派发、16 位 packet id 排序/去重、丢包重复帧补偿、
起播与 VAD 边界淡入淡出。
第三轮（P1a）：可选原生播放引擎（cpal/WASAPI + libopus + 抖动缓冲/PLC/FEC）。
（已在后续批次删除：缺少播放参考导致 AEC 不收敛，设备时钟漂移又会周期性欠载。）
第四轮（P1b）：可选原生采集（cpal/WASAPI + SpeexDSP AEC/NS/AGC + Opus 编码），
默认关闭，采集侧自带 VAD/PTT 门控与诊断；AEC 需要原生播放提供参考信号。
由于开发机无法实测麦克风，P1b 仍按实验特性处理。
第五轮（`feat/denoise-choice`）：降噪五选一（关闭 / 噪声门 / Chromium / SpeexDSP / RNNoise），
前端 Worklet 与 Rust `MicDsp` 同序实现高通、门控、软限幅；自动灵敏度与底噪校准。
第六轮（`feat/audio-reliability`）：回声参考改 FIFO（修复设备块长变化导致的错位）、
发包移出 `Worker` 锁（消除与收包线程的锁序倒置）、设备错误重建输出流、
任意采样率麦克风（线性重采样）、原生采集失败自动回退、混音软限幅。
新增可自行运行的验证：`npm run audio:check`、`cargo test --lib`、
`rayspeak.exe --mic-diag` / `--mic-scan`。

仍待做（按收益排序）：

- **真机听感验收**：AEC 收敛质量、NS 档位主观差异、外放/耳机与 PTT/VAD 的延迟手感。
  本机自检能证明「设备可打开、回调节奏正常、DSP 数值正确」，但听感仍需人耳。
- **WebView 链路的 RNNoise**：把 `nnnoiseless` 编成 WASM 进 Worklet，
  让默认链路也能用神经网络降噪（目前仅原生采集可用）。
- **AEC3 升级**：WebRTC APM 的 bundled 构建在本机 MSVC 工具链下不可用
  （Meson 传 GCC 专用参数），后续可引入 clang/LLVM 构建链替换 SpeexDSP。
- **弱网**：按丢包率动态调码率与 FEC；音乐模式更高码率立体声。
- **兼容性**：解码 Speex/CELT（codec 0–3），覆盖使用旧编码的成员。

## 3. 中优先级

- **消息体验**：时间分组、复制多条、链接跳转、未读定位、发送失败重试 UI
- **文件面板**：上传/下载进度、取消、失败重试、拖拽上传
  （房间头部的「共享 / 文件」入口当前暂时隐藏，逻辑与命令均保留，恢复时只需放回按钮）
- **头像设置体验**：上传进度、大小/格式提示、裁剪预览、权限不足的明确文案
- **设备管理**：设备热插拔、输出设备切换、PTT 按键冲突检测
- **设置导入/导出**：主题、快捷键、屏蔽名单；身份文件已有导出
- **错误分类**：把服务器错误 ID 映射为用户可理解文案，区分权限/网络/协议错误
- **无障碍与键盘操作**：频道树、成员卡、右键菜单的完整键盘导航
- **国际化**：当前文案为中文，可抽 i18n 资源

## 4. 工程化

- 增加 GitHub Actions：`npm ci` + `typecheck` + `cargo check` + `vite build`
- 发布流程：版本号三处同步、打 tag、上传 NSIS 安装包
- 依赖升级：tsclient-rs vendor 补丁需要按 `docs/PROTOCOL.md` 重新应用
- `App.tsx` 体量较大，建议按领域拆 hooks：
  `useConnection`、`useDirectory`、`useMessages`、`useDeepLink`、`useAvatars`
- 为协议命令建立统一错误类型，避免 `String` 到处透传

## 5. 低优先级 / 设计向

- 成员列表虚拟滚动（大频道）
- 频道拖拽排序（需写 `channeledit channel_order` predecessor）
- 频道权限/组管理 UI（先确认当前身份权限）
- 消息中的 `[url]...[/url]` 更细粒度渲染
- 深链支持 `ray://join/<id>` 以外的动作前，先补协议白名单与安全校验

## 6. 验收要求

任何新功能提交前至少满足：

1. `npm run typecheck` 通过
2. `cargo check` 通过
3. `npm run app:build` 成功
4. 真实窗口手工验证主路径和失败路径
5. 不泄露服务器地址/密码/解析后主机
6. 不修改真实用户资料用于测试（头像等使用一次性身份）
7. 更新对应文档（AGENTS / ARCHITECTURE / PROTOCOL）

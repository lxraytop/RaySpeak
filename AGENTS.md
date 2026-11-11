# AGENTS.md — RaySpeak 开发交接

本文件面向后续接手本仓库的 AI Agent。开始修改前请完整阅读，尤其是「硬约束」和「常见陷阱」。

## 项目概览

RaySpeak 是一个 Windows 桌面 TeamSpeak 3 第三方客户端：

- 前端：React 19 + TypeScript 5.6 + Vite 6，单页应用，UI 风格接近 KOOK / 语音房产品
- 桌面壳：Tauri 2（WebView2、无边框透明窗口、NSIS 打包）
- 协议层：Rust + `tsclient-rs 0.2.7`（**仓库内 vendor 了带补丁的副本**）
- 当前版本：`0.2.0`，应用标识 `gg.rayspeak.app`

已实现：真实加密握手、频道目录、成员状态、文字/私聊消息、头像、频道/服务器/组图标、
频道文件传输、成员管理、Opus 语音收发、`ray://` 深链邀请、自定义右键菜单、主题与设置、
成员进出提示音、房间头部在线状态与深浅色快捷键、头像与联系人目录本地持久化。

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
   `.shots/`、临时 CDP 脚本、测试截图、`ws` 临时依赖都不要进 Git。
6. **协议相关改动先读 `src-tauri/vendor/tsclient-rs/`**：这是打过补丁的副本，
   升级 crate 后必须重新应用补丁，见 `docs/DEVELOPMENT.md`。

## 快速命令

```bash
npm install
npm run dev        # 浏览器演示模式（不连服务器）
npm run typecheck  # 每次改 TS 必跑
npm run app:dev    # Tauri 开发窗口
npm run app:build  # 生产构建 + NSIS 安装包
```

本机 Rust 工具链位于非 C 盘，运行 Rust 命令前：

```bash
export PATH="/f/dev/cargo/bin:$PATH"
export RUSTUP_HOME="F:/dev/rustup"
export CARGO_HOME="F:/dev/cargo"
cd src-tauri && cargo check
```

产物：

- `src-tauri/target/release/rayspeak.exe`
- `src-tauri/target/release/bundle/nsis/RaySpeak_0.2.0_x64-setup.exe`

环境基线：Node 20+（当前 20.15.0）、npm 10+、Rust 1.99、WebView2 Runtime、Windows 10/11。

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
  components/          UI 组件（登录、频道树、成员卡、聊天、联系人、设置、资料卡…）
  styles.css           全部样式（主题通过 CSS 变量与 data-* 属性切换）

src-tauri/
  src/lib.rs           Tauri 命令、Bridge、事件、快照循环、头像/图标/文件传输
  vendor/tsclient-rs/  带最小补丁的 tsclient-rs 0.2.7（见下）
  tauri.conf.json      窗口、深链 scheme、打包配置
  Cargo.toml           `[patch.crates-io]` 指向 vendor 副本

docs/                  ARCHITECTURE / PROTOCOL / DEVELOPMENT / ROADMAP
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

## 当前状态与已知缺口

已实测：空密码登录、频道顺序、消息收发（频道/私聊）、左右气泡、ray 深链（含 OS 唤起）、
头像下载与上传/删除、服务器卡片、组图标、右键菜单、exe 图标。

已知限制/可继续做的工作见 [docs/ROADMAP.md](docs/ROADMAP.md)。
其中重要的有：离线联系人头像不持久化、历史消息头像不会动态补全、
无消息历史（TS 协议限制）、无好友系统、屏幕共享仅本地预览、
大服务器 `clientinfo` 预取需要限流、vendor 补丁需要随 crate 升级维护。

## 提交前检查

```bash
npm run typecheck
cd src-tauri && cargo check
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
- [docs/ROADMAP.md](docs/ROADMAP.md) — 已知缺口与建议任务

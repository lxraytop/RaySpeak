# 开发、构建与调试

## 1. 环境

| 工具 | 版本基线 | 备注 |
| --- | --- | --- |
| Windows | 10/11 | WebView2 Runtime 必需 |
| Node.js | 20+ | 当前 20.15.0 |
| npm | 10+ | 当前 10.7.0 |
| Rust | 1.85+ | 当前 1.99.1 |
| CMake | 3.20+ | libopus 静态编译；VS BuildTools 自带 |
| Tauri CLI | 2.x | 由 npm devDependency 提供 |

本机 Rust 安装在非 C 盘，使用前执行：

```bash
export PATH="/f/dev/cargo/bin:$PATH"
export RUSTUP_HOME="F:/dev/rustup"
export CARGO_HOME="F:/dev/cargo"
```

## 2. 安装与开发

```bash
npm install
npm run dev        # 浏览器演示模式，不连接服务器
npm run app:dev    # Tauri 开发窗口，真实协议
npm run typecheck  # TypeScript 检查
```

浏览器模式无 Tauri 运行时，自动使用 `src/data/mock.ts` 的演示数据。
可用 URL 参数直达页面（`?screen=settings&section=appearance`、`?layout=grid` 等）。

## 3. 构建

完整的打包步骤、工具链依赖与常见报错见 [PACKAGING.md](PACKAGING.md)。

```bash
# 前端 + Rust + NSIS
npm run app:build
```

`app:dev` / `app:build` 由 `scripts/tauri-run.mjs` 包装：它会从 `vswhere` 找到
Visual Studio BuildTools 自带的 CMake，并设置 `CMAKE_POLICY_VERSION_MINIMUM=3.5`
（`audiopus_sys` 内置的 Opus 1.3 仍声明 `cmake_minimum_required(VERSION 3.1)`）。
直接运行 cargo 时，把 BuildTools 的
`Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin` 加入 `PATH` 即可。

原生音频依赖（`cpal`、`audiopus`/libopus、`aec-rs-sys`/SpeexDSP）只影响构建，
不需要用户侧安装任何东西；libopus 与 speexdsp 都以静态库链接进 exe。

`aec-rs-sys` 在构建时用 bindgen 生成绑定，需要 `libclang`。`scripts/tauri-run.mjs`
会自动从 pip 的用户目录查找 `libclang.dll`；如果没有，安装一次：

```bash
python -m pip install --user libclang
```

直接运行 `cargo check` 时还需要手动设置 `LIBCLANG_PATH`（指向包含
`libclang.dll` 的目录）与 `CMAKE`，否则构建脚本会失败。

输出：

- `src-tauri/target/release/rayspeak.exe`
- `src-tauri/target/release/bundle/nsis/RaySpeak_0.2.0_x64-setup.exe`

只检查 Rust：

```bash
cd src-tauri && cargo check
```

### 版本号

升级版本需要同时修改：

- `package.json` → `version`
- `src-tauri/Cargo.toml` → `version`
- `src-tauri/tauri.conf.json` → `version`

### 图标

```bash
# 从根目录 logo.png 重新生成 exe / NSIS / 移动端全套图标
npx tauri icon logo.png

# 网页内品牌 logo 是独立资源：public/logo.png（透明圆角 256px）
```

## 4. 调试真实服务器

启动前输入昵称、密码可空；不要在任何日志/截图/文档中记录真实服务器地址或密码。

### CDP 调试（可选）

1. 关闭所有 `rayspeak.exe`（单实例会拦截新进程）。
2. 以远程调试端口启动：

```bash
cd src-tauri/target/release
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" ./rayspeak.exe
```

3. `http://127.0.0.1:9222/json` 获取 WebView 的 `webSocketDebuggerUrl`。
4. 使用临时脚本通过 CDP 执行 `Runtime.evaluate`，可直接调用：

```js
await window.__TAURI_INTERNALS__.invoke('get_snapshot')
await window.__TAURI_INTERNALS__.invoke('send_channel_message', { channelId, message })
```

Node 20 没有全局 `WebSocket`，临时脚本可 `npm install --no-save ws`，
**测试结束后删除 `node_modules/ws` 和脚本，不要把 `ws` 写进 package.json。**

### 测试头像不要污染真实账号

头像上传/删除会修改服务器上的真实资料。联调时使用一次性身份：

```powershell
# 先关闭正常实例
$env:APPDATA = 'F:\temp\rayspeak-test'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9222'
.\rayspeak.exe
```

新 `APPDATA` 会生成新身份；测试完成后关闭进程并删除临时目录。
注意 WebView2 的 localStorage 仍位于统一的用户数据目录，昵称等设置可能沿用。

### 测试消息

- 自己发消息：通过 UI 输入框发送，确认只出现一条且 `is-self`。
- 他人消息：用第二个客户端（或临时 Rust 探针）向同一频道发送，确认左侧显示。
- 私聊：第二客户端向当前 clid 发送 `targetmode=1`。
- 若收不到，先检查连接后是否成功发送了五类 `servernotifyregister`。

## 5. vendor 补丁维护

`src-tauri/Cargo.toml`：

```toml
[patch.crates-io]
tsclient-rs = { path = "vendor/tsclient-rs" }
```

补丁内容见 `docs/PROTOCOL.md` 第 8 节。升级 crate 时：

1. 用新版本覆盖 `src-tauri/vendor/tsclient-rs`（保留 LICENSE）
2. 重新应用补丁：
   - `initserver` 属性保存与访问
   - `notifyserveredited` / `notifyserverupdated` 合并
   - `ClientInfo.avatar` 解析与通知更新
   - `set_own_avatar` 与 `update_client` 可见性
   - `VoiceData.packet_id` 与语音事件同步派发（见 `docs/PROTOCOL.md` 第 8 节）
3. `cargo check` 确认所有 `ClientInfo` / `VoiceData` 构造器都已补新字段
4. 实机验证服务器卡片、头像、消息、图标与文件传输

## 6. 常见问题

| 现象 | 处理 |
| --- | --- |
| `failed to remove rayspeak.exe ... os error 5` | 仍有实例占用，关闭所有 `rayspeak.exe` 后重试；安装/覆盖前同理 |
| `failed to find main binary` | 检查 `src-tauri/src/bin/` 是否有遗留探针文件 |
| 连上但收不到消息 | 检查 `servernotifyregister` 五个事件是否执行 |
| 服务器卡片显示默认名 | 确认 vendor 的 `initserver` 属性补丁是否生效 |
| 频道顺序异常 | 不要按 `order` 数字排序，保持快照数组顺序 |
| 图标显示失败 | 确认使用 `transfer_host()` 解析后的主机；内置组图标没有文件属正常 |
| 头像 404 | 文件按 UID 编码名存储，确认 `avatar_file_name()` 与 UID 一致 |
| 深度链接无反应 | 检查系统 `ray` scheme 注册、单实例插件顺序、`take_deep_link` 冷启动路径 |
| login 页出现旧昵称 | 设置存于 localStorage，属预期 |

## 7. 手工回归清单

- [ ] 空密码登录成功；错误密码回登录门且提示不含地址
- [ ] 频道顺序与官方客户端一致；spacer 与子频道显示正确
- [ ] 频道/私聊消息收发；自己一条、右侧；他人左侧
- [ ] 成员简介、平台、版本、DB ID、UID、服务器组/频道组
- [ ] 成员头像显示；自己设置/删除头像
- [ ] 服务器名称、人数上限、图标；频道/组图标
- [ ] 邀请复制、私聊发送、聊天内 `ray://` 点击、系统级唤起
- [ ] 右键菜单（频道/成员/消息/空白）
- [ ] 语音采集/播放、静音/闭麦、单用户音量
- [ ] 设置页各分区、主题切换、重启后保留
- [ ] 打包安装后 exe/任务栏/开始菜单图标正确

## 8. 提交前

```bash
npm run typecheck
cd src-tauri && cargo check
npm run app:build
```

- 确认没有真实服务器地址进入 UI/错误/日志/文档
- 确认没有临时脚本、截图、`ws`、`target/`、`node_modules/` 被提交
- 协议行为变更同步 `docs/PROTOCOL.md`
- 架构/数据流变更同步 `docs/ARCHITECTURE.md`

# 打包与构建

本文档说明如何在 Windows 上构建、打包 RaySpeak（Tauri 2 + React + Rust），
以及本机工具链、常见报错与验证清单。

---

## 1. 最快的路径

```bash
# 仓库根目录
npm install
npm run app:build
```

产物：

| 文件 | 说明 |
| --- | --- |
| `src-tauri/target/release/rayspeak.exe` | 绿色可执行文件 |
| `src-tauri/target/release/bundle/nsis/RaySpeak_0.2.0_x64-setup.exe` | 安装包（NSIS，currentUser） |

> `app:build` 会先执行 `vite build` 生成 `dist/`，再编译 Rust 并调用 NSIS。
> 不要直接 `npx tauri build`：它会绕过 `scripts/tauri-run.mjs`，导致 CMake 和
> `libclang` 环境变量缺失。

---

## 2. 环境要求

### 2.1 必需

- Windows 10/11 x64
- Node.js 20+、npm 10+
- Rust 1.77.2+（stable，MSVC toolchain）
- Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）
  - 自带 MSVC、Windows SDK、CMake
- WebView2 Runtime（Win10/11 通常已自带）

### 2.2 构建期额外依赖

本项目链接两个 C 库，均由构建脚本静态编译进 exe，最终用户无需安装：

- **libopus**（`audiopus_sys`）：使用 CMake 构建。
- **SpeexDSP**（`aec-rs-sys`）：使用 CMake 构建；bindgen 生成绑定时需要 `libclang`。

> RNNoise 走 `nnnoiseless`（Xiph RNNoise 的纯 Rust 移植，已关闭默认 feature），
> 不引入额外的 C 库或构建期依赖，只是编译时间会多几秒。

安装 `libclang`（只需一次）：

```bash
python -m pip install --user libclang
```

`scripts/tauri-run.mjs` 会自动在 pip 用户目录中查找
`clang/native/libclang.dll` 并设置 `LIBCLANG_PATH`。如果 Python 安装位置特殊，
可手动指定：

```bash
export LIBCLANG_PATH="C:/Users/<you>/AppData/Roaming/Python/Python310/site-packages/clang/native"
```

> 不需要安装 Meson/Ninja：我们使用 SpeexDSP，而不是需要 Meson 的
> `webrtc-audio-processing`。

### 2.3 本机（当前开发机）路径

Rust 工具链不在 C 盘，直接运行 cargo 前需要设置：

```bash
export PATH="/f/dev/cargo/bin:$PATH"
export RUSTUP_HOME="F:/dev/rustup"
export CARGO_HOME="F:/dev/cargo"

# 仅为直接运行 cargo 时需要；npm run app:* 会自动处理
export CMAKE="F:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/Common7/IDE/CommonExtensions/Microsoft/CMake/CMake/bin/cmake.exe"
export CMAKE_POLICY_VERSION_MINIMUM=3.5
export LIBCLANG_PATH="C:/Users/Lenovo/AppData/Roaming/Python/Python310/site-packages/clang/native"
```

---

## 3. 常用命令

```bash
# 浏览器演示模式（不连服务器，使用 mock 数据）
npm run dev

# Tauri 开发窗口（连接真实服务器）
npm run app:dev

# TypeScript 检查（改前端必跑）
npm run typecheck

# 只检查 Rust
cd src-tauri && cargo check

# Rust 单元测试（含语音抖动缓冲回归）
cd src-tauri && cargo test --lib

# 生产构建 + NSIS 安装包
npm run app:build

# 只编译 exe，不生成安装包
npm run app:build -- --no-bundle
```

`app:dev` / `app:build` 由 `scripts/tauri-run.mjs` 包装，负责：

1. 用 `vswhere` 找到 Visual Studio Build Tools 自带的 CMake；
2. 设置 `CMAKE` 与 `CMAKE_POLICY_VERSION_MINIMUM=3.5`；
3. 从 pip 用户目录探测 `libclang.dll` 并设置 `LIBCLANG_PATH`；
4. 以仓库根目录为 cwd 启动 Tauri CLI。

---

## 4. 构建流程

```
npm run app:build
  ├─ vite build                  → dist/
  ├─ cargo build --release       → src-tauri/target/release/rayspeak.exe
  │    ├─ audiopus_sys (CMake)   → 静态 libopus
  │    └─ aec-rs-sys  (CMake)    → 静态 speexdsp
  └─ tauri-bundler + makensis    → bundle/nsis/RaySpeak_0.2.0_x64-setup.exe
```

安装包特性：

- NSIS，`installMode: currentUser`，默认装到用户目录，不需要管理员权限；
- 应用标识 `gg.rayspeak.app`；
- 注册 `ray://` 深链；
- `tauri-plugin-single-instance`：重复启动会把参数/深链转给已运行实例；
- 未做代码签名，首次运行可能出现 SmartScreen 提示。

---

## 5. 版本号

改版本时需要同步三处，保持一致：

- `package.json` → `version`
- `src-tauri/tauri.conf.json` → `version`
- `src-tauri/Cargo.toml` → `[package] version`

改完执行一次构建，`Cargo.lock` 会自动更新。安装包文件名由
`tauri.conf.json` 的 `version` 决定。

---

## 6. 常见问题

### 6.1 `failed to remove file ... rayspeak.exe`（os error 5）

正在运行的 RaySpeak 锁住了 release exe。二选一：

- 关闭正在运行的 RaySpeak（包括旧测试实例）；
- 或把旧 exe 改名后重新构建：

  ```bash
  cd src-tauri/target/release
  mv rayspeak.exe rayspeak.exe.locked-$(date +%s)
  cd /f/ProjectAI/RaySpeak1
  npm run app:build
  ```

### 6.2 `CMake not found` / `cmake_minimum_required` 报错

- 确认安装了 Visual Studio Build Tools 的 C++ 工作负载；
- 通过 npm 脚本构建，不要绕过 `scripts/tauri-run.mjs`；
- Opus 1.3 的 CMakeLists 仍声明 3.1，必须保留
  `CMAKE_POLICY_VERSION_MINIMUM=3.5`。

### 6.3 `libclang` / bindgen 失败

```
Unable to find libclang
```

```bash
python -m pip install --user libclang
```

并确认 `LIBCLANG_PATH` 指向包含 `libclang.dll` 的目录（不是 DLL 本身）。
`npm run app:*` 会自动探测常见 pip 路径。

### 6.4 首次构建很慢

Rust release 首次构建需要编译 Tauri、libopus、SpeexDSP，通常 5–15 分钟；
增量构建约 1 分钟。不要为了“快”删除 `src-tauri/target/`，除非遇到链接缓存问题。

### 6.5 安装包装完打不开 / 黑屏

- 确认系统有 WebView2 Runtime；
- 查看应用数据目录（由 `tauri.conf.json` 的 `identifier` 决定）；
- 用 `npm run app:dev` 对比是否是打包资源缺失。

### 6.6 音频问题怎么取证

先跑诊断把数据拿到手，不要只描述「听着不对」。自检命令都在任意空目录执行，
报告写到当前目录（不会连接服务器，也不会泄露地址）：

```bash
rayspeak.exe --mic-scan     # 逐个输入设备打开，报告 hasSignal / RMS
rayspeak.exe --mic-diag 8   # 默认麦克风录 8 秒，输出 WAV + 指标
```

播放侧不再有独立的自检入口：播放统一在 WebView2（Chromium + WebCodecs），
设备是否可用用设置页的「测试扬声器」三段音确认即可。

前端 DSP 与 Rust DSP 也可以离线验收，不需要任何音频设备：

```bash
npm run audio:check                        # AudioWorklet 的 7 项断言
cd src-tauri && cargo test --lib           # Rust 侧门控/限幅/RNNoise/重采样
```

判断「电流声」来源时用麦克风诊断（会录 WAV，需现场说话）：

```bash
rayspeak.exe --mic-diag 8
```

产出 `mic-diag-raw.wav`（设备原始）、`mic-diag-processed.wav`（过一遍真实 DSP）、
`mic-diag.json`。解读方式：

| 指标 | 含义 | 处理方向 |
| --- | --- | --- |
| `humRatio` 高、`humFreq` 50/60 | 工频哼声 | 换 USB 口/接地/屏蔽线，与软件无关 |
| `highBandRatio` 高、`floorDbfs` > −55 | 宽带嘶声 | 降麦克风增益，再开降噪 |
| `clickBoundaryHits` 占多数 | 断点落在 10ms 帧网格 | 采集链路丢帧，属于代码问题 |
| `clippedSamples` > 0 | 削波 | 下调输入增益 |
| 中位数 < −70 dBFS | 几乎没有持续输入 | 麦克风被静音/禁用或设备选错 |

不确定是哪个设备的问题时先扫描所有输入设备：

```bash
rayspeak.exe --mic-scan
```

每个设备录 1.2 秒，输出 `hasSignal` 与 RMS；`working` 数组里是可以用的设备名。

对比「自听听到的」时，注意选**物理**耳机/扬声器而不是 FxSound 等虚拟增强设备。

---

## 7. 提交前检查

```bash
npm run typecheck
cd src-tauri && cargo test --lib && cargo check
cd .. && npm run app:build
```

确认：

- 界面、错误提示、日志、toast、深链中没有真实服务器地址或解析后的主机；
- 没有提交 `node_modules/`、`dist/`、`src-tauri/target/`、`.shots/`、
  临时 CDP 脚本、测试截图或 `ws` 临时依赖；
- 涉及协议行为时更新 `docs/PROTOCOL.md`；
- 涉及状态流/音频架构时更新 `docs/ARCHITECTURE.md`；
- 涉及构建步骤时更新本文档与 `docs/DEVELOPMENT.md`。

---

## 8. 相关文档

- [AGENTS.md](../AGENTS.md) — 硬约束与常见陷阱
- [DEVELOPMENT.md](DEVELOPMENT.md) — 调试、维护与工具链细节
- [ARCHITECTURE.md](ARCHITECTURE.md) — 模块与音频管线
- [CHANGELOG.md](CHANGELOG.md) — 变更记录

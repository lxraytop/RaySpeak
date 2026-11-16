// EasyTier 网络生命周期。
//
// 创建 TUN 虚拟网卡需要管理员权限，而 RaySpeak 本身以普通用户运行，所以这里
// 用 runas 拉起一个「提权 helper」（同一个 exe 的 `--share-helper` 模式），
// helper 再启动 easytier-core.exe 并把日志回传。app 进程退出或断开连接时，
// helper 会结束子进程，避免留下孤儿 easytier-core。

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

fn resolve_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("RAYSPEAK_EASYTIER_DIR") {
        let dir = PathBuf::from(dir);
        if dir.join("easytier-core.exe").is_file() {
            return Some(dir);
        }
    }
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("easytier"));
        candidates.push(dir.join("resources").join("easytier"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("easytier"));
            candidates.push(dir.join("resources").join("easytier"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("resources").join("easytier"));
        candidates.push(cwd.join("resources").join("easytier"));
    }
    candidates.into_iter().find(|dir| {
        dir.join("easytier-core.exe").is_file() && dir.join("easytier-cli.exe").is_file()
    })
}

type Writer = Arc<tokio::sync::Mutex<tokio::net::tcp::OwnedWriteHalf>>;
type Logs = Arc<Mutex<VecDeque<String>>>;

/// 设置页「屏幕共享网络」的可调参数。全部为可选项：缺省时沿用 EasyTier 的默认值。
#[derive(Debug, Clone, Default, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NetworkOptions {
    /// `auto`（默认，直连优先 + 中继兜底）、`p2p`（仅直连）或 `relay`（仅中继）
    pub transport: Option<String>,
    /// `latency`（默认）或 `shortest`
    pub route_mode: Option<String>,
    /// 虚拟网 MTU；0/缺省表示不传，交给 EasyTier
    pub mtu: Option<u16>,
    /// `none`（默认）或 `zstd`
    pub compression: Option<String>,
    /// false 时只连测速最快的一个中继
    pub multi_relay: Option<bool>,
    /// false 时只转发本房间流量，不帮其他网络中继
    pub relay_foreign: Option<bool>,
    /// info / warn / error，默认 warn
    pub log_level: Option<String>,
}

impl NetworkOptions {
    pub fn multi_relay(&self) -> bool {
        self.multi_relay.unwrap_or(true)
    }

    fn transport(&self) -> &str {
        match self.transport.as_deref() {
            Some("p2p") => "p2p",
            Some("relay") => "relay",
            _ => "auto",
        }
    }

    fn log_level(&self) -> &str {
        match self.log_level.as_deref() {
            Some("info") => "info",
            Some("error") => "error",
            _ => "warn",
        }
    }

    fn mtu(&self) -> Option<u16> {
        self.mtu.filter(|mtu| (1200..=1400).contains(mtu))
    }
}

pub struct HelperClient {
    writer: Writer,
    reader: tokio::task::JoinHandle<()>,
    stopping: Arc<AtomicBool>,
}

impl HelperClient {
    async fn write(&self, value: Value) -> Result<(), String> {
        use tokio::io::AsyncWriteExt;
        let mut guard = self.writer.lock().await;
        let mut line = value.to_string();
        line.push('\n');
        guard
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        guard.flush().await.map_err(|error| error.to_string())
    }

    async fn shutdown(self) {
        // 先关掉日志转发：否则 helper 正常收尾时回传的 exit 会被当成掉线，
        // 把刚刚重启的共享网络误判成离线。
        self.stopping.store(true, Ordering::Release);
        self.reader.abort();
        let _ = self.write(json!({ "type": "stop" })).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn build_args(
    network_name: &str,
    secret: &str,
    hostname: &str,
    instance: &str,
    rpc_arg: &str,
    listener_tcp: &str,
    listener_udp: &str,
    ipv4: &str,
    peers: &[String],
    options: &NetworkOptions,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--network-name".into(),
        network_name.into(),
        "--network-secret".into(),
        secret.into(),
        "--ipv4".into(),
        ipv4.into(),
        "--dhcp".into(),
        "false".into(),
        "--hostname".into(),
        hostname.into(),
        "--instance-name".into(),
        instance.into(),
        "--rpc-portal".into(),
        rpc_arg.into(),
        "--rpc-portal-whitelist".into(),
        "127.0.0.1/32".into(),
        "--listeners".into(),
        listener_tcp.into(),
        listener_udp.into(),
        "--peers".into(),
    ];
    args.extend(peers.iter().cloned());
    args.extend([
        "--disable-ipv6".into(),
        "true".into(),
        "--disable-upnp".into(),
        "true".into(),
        "--latency-first".into(),
        if options.route_mode.as_deref() == Some("shortest") {
            "false".into()
        } else {
            "true".into()
        },
        "--console-log-level".into(),
        options.log_level().into(),
        "--file-log-level".into(),
        "off".into(),
    ]);
    if let Some(mtu) = options.mtu() {
        args.push("--mtu".into());
        args.push(mtu.to_string());
    }
    if options.compression.as_deref() == Some("zstd") {
        args.push("--compression".into());
        args.push("zstd".into());
    }
    match options.transport() {
        // 只和已经建立 P2P 的节点通信：不经中继转发画面，跨 NAT 打洞失败就会断。
        "p2p" => args.extend(["--p2p-only".into(), "true".into()]),
        // 禁用自动 P2P，稳定走公共中继，适合打洞被封锁的网络。
        "relay" => args.extend(["--disable-p2p".into(), "true".into()]),
        _ => {}
    }
    if options.relay_foreign == Some(false) {
        // 白名单只放本房间：仍可替同房间成员转发，但不替其他网络当中继。
        args.push("--relay-network-whitelist".into());
        args.push(network_name.to_string());
    }
    args
}

pub struct Network {
    rpc_port: u16,
    cli: PathBuf,
    logs: Logs,
    helper: Mutex<Option<HelperClient>>,
}

impl Network {
    pub async fn start(
        app: AppHandle,
        network_name: &str,
        secret: &str,
        peer_id: &str,
        ip: &str,
        peers: &[String],
        options: &NetworkOptions,
    ) -> Result<Self, String> {
        let dir = resolve_dir(&app).ok_or_else(|| {
            "未找到 EasyTier 内核。请运行 `npm run easytier:fetch`，或确认安装包内 resources/easytier 完整".to_string()
        })?;
        let core = dir.join("easytier-core.exe");
        let cli = dir.join("easytier-cli.exe");

        let listen_port = super::random_port(20000..40000);
        let rpc_port = super::random_port(40000..60000);
        let hostname = format!("rs-{peer_id}");
        let instance = format!("rayspeak-{peer_id}");
        let rpc_arg = format!("127.0.0.1:{rpc_port}");
        let listener_tcp = format!("tcp://0.0.0.0:{listen_port}");
        let listener_udp = format!("udp://0.0.0.0:{listen_port}");
        // 显式 /24：同频道成员都落在 10.126.126.0/24，TUN 才会为整个子网建路由。
        let ipv4 = format!("{ip}/24");

        let args = build_args(
            network_name,
            secret,
            &hostname,
            &instance,
            &rpc_arg,
            &listener_tcp,
            &listener_udp,
            &ipv4,
            peers,
            options,
        );

        let (helper, logs) = connect_helper(&app, &core, args, secret).await?;

        // EasyTier prints the configured IP before Windows installs it; poll the
        // actual bind instead of trusting log timing.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(25);
        loop {
            match std::net::UdpSocket::bind((ip, 0)) {
                Ok(socket) => {
                    drop(socket);
                    break;
                }
                Err(error) => {
                    if tokio::time::Instant::now() >= deadline {
                        let tail = logs
                            .lock()
                            .unwrap()
                            .iter()
                            .rev()
                            .take(6)
                            .cloned()
                            .collect::<Vec<_>>()
                            .into_iter()
                            .rev()
                            .collect::<Vec<_>>()
                            .join(" | ");
                        let _ = helper.shutdown().await;
                        return Err(format!(
                            "等待 EasyTier 虚拟网卡超时（{error}）。{}",
                            if tail.is_empty() {
                                String::new()
                            } else {
                                format!("最近日志: {tail}")
                            }
                        ));
                    }
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
            }
        }

        Ok(Self {
            rpc_port,
            cli,
            logs,
            helper: Mutex::new(Some(helper)),
        })
    }

    pub fn cli_path(&self) -> PathBuf {
        self.cli.clone()
    }

    pub fn rpc_port(&self) -> u16 {
        self.rpc_port
    }

    pub fn recent_logs(&self) -> Vec<String> {
        self.logs.lock().unwrap().iter().cloned().collect()
    }

    pub async fn stop(&self) {
        let helper = self.helper.lock().unwrap().take();
        if let Some(helper) = helper {
            helper.shutdown().await;
        }
    }
}

async fn connect_helper(
    app: &AppHandle,
    core: &PathBuf,
    args: Vec<String>,
    secret: &str,
) -> Result<(HelperClient, Logs), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let port = free_port()?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    let parameters = format!("--share-helper {port} {token}");
    run_elevated(&parameters)?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(40);
    let mut stream = loop {
        match tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => break stream,
            Err(error) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!(
                        "无法连接提权 helper（{error}）。请确认已允许管理员授权"
                    ));
                }
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };

    stream
        .write_all(format!("{token}\n").as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    let (read_half, write_half) = stream.into_split();
    let writer: Writer = Arc::new(tokio::sync::Mutex::new(write_half));
    let mut lines = BufReader::new(read_half).lines();

    match tokio::time::timeout(Duration::from_secs(10), lines.next_line()).await {
        Ok(Ok(Some(line))) if line.contains("\"ready\"") => {}
        Ok(Ok(Some(line))) => return Err(format!("提权 helper 握手失败: {line}")),
        Ok(Ok(None)) => {
            return Err("提权 helper 已退出（请检查是否拒绝了管理员授权）".into())
        }
        Ok(Err(error)) => return Err(format!("提权 helper 握手失败: {error}")),
        Err(_) => return Err("提权 helper 握手超时".into()),
    }

    let payload = json!({ "type": "start", "program": core, "args": args });
    {
        let mut guard = writer.lock().await;
        let mut line = payload.to_string();
        line.push('\n');
        guard
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())?;
        guard.flush().await.map_err(|error| error.to_string())?;
    }

    let logs: Logs = Arc::new(Mutex::new(VecDeque::new()));
    let started = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match value.get("type").and_then(Value::as_str) {
                Some("started") => return Ok::<(), String>(()),
                Some("error") => {
                    return Err(value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("EasyTier 启动失败")
                        .to_string())
                }
                Some("log") => {
                    push_log(&logs, &value, secret);
                }
                _ => {}
            }
        }
        Err("EasyTier 启动进程已退出".to_string())
    })
    .await;

    match started {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let helper = stub_helper(writer);
            let _ = helper.shutdown().await;
            return Err(error);
        }
        Err(_) => {
            let helper = stub_helper(writer);
            let _ = helper.shutdown().await;
            return Err("启动 EasyTier 超时".into());
        }
    }

    let reader_logs = logs.clone();
    let app_handle = app.clone();
    let reader_secret = secret.to_string();
    let stopping = Arc::new(AtomicBool::new(false));
    let reader_stopping = stopping.clone();
    let reader = tokio::spawn(async move {
        let mut exited = 0;
        let mut reported = false;
        // 日志按 350ms 批量推给前端：EasyTier 正常运行时每秒都有 INFO，
        // 逐行 emit 会让页面每行重渲染一次，纯属浪费。
        let mut pending: Vec<String> = Vec::new();
        let mut repeat = RepeatFilter::new();
        let mut flush = tokio::time::interval(Duration::from_millis(350));
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        flush.tick().await;
        loop {
            tokio::select! {
                line = lines.next_line() => {
                    let Ok(Some(line)) = line else {
                        break;
                    };
                    let Ok(value) = serde_json::from_str::<Value>(&line) else {
                        continue;
                    };
                    match value.get("type").and_then(Value::as_str) {
                        Some("log") => {
                            if let Some(line) = push_log(&reader_logs, &value, &reader_secret) {
                                let (line, note) = repeat.accept(line);
                                if let Some(note) = note {
                                    pending.push(note);
                                }
                                if let Some(line) = line {
                                    pending.push(line);
                                }
                                if pending.len() >= 40 {
                                    flush_logs(&app_handle, &mut pending);
                                }
                            }
                        }
                        Some("exit") => {
                            // stdout and stderr both close when the core exits; wait for
                            // both so a single closed pipe does not fake a disconnect.
                            exited += 1;
                            if exited < 2 || reported || reader_stopping.load(Ordering::Acquire) {
                                continue;
                            }
                            reported = true;
                            emit_offline(&app_handle, &reader_logs, "EasyTier 已退出");
                        }
                        _ => {}
                    }
                }
                _ = flush.tick() => {
                    if let Some(note) = repeat.settle() {
                        pending.push(note);
                    }
                    flush_logs(&app_handle, &mut pending);
                }
            }
        }
        if let Some(note) = repeat.take_note() {
            pending.push(note);
        }
        flush_logs(&app_handle, &mut pending);
        // helper 进程消失（被结束或崩溃）时子进程管道不会发出 exit 事件。
        if !reported && !reader_stopping.load(Ordering::Acquire) {
            emit_offline(&app_handle, &reader_logs, "提权 helper 已断开");
        }
    });

    Ok((
        HelperClient {
            writer,
            reader,
            stopping,
        },
        logs,
    ))
}

fn stub_helper(writer: Writer) -> HelperClient {
    HelperClient {
        writer,
        reader: tokio::spawn(async {}),
        stopping: Arc::new(AtomicBool::new(true)),
    }
}

fn emit_offline(app: &AppHandle, logs: &Logs, fallback: &str) {
    let tail = logs
        .lock()
        .unwrap()
        .back()
        .cloned()
        .unwrap_or_else(|| fallback.to_string());
    let _ = app.emit(
        "ts://share-status",
        json!({ "phase": "offline", "info": null, "error": tail }),
    );
}

fn flush_logs(app: &AppHandle, pending: &mut Vec<String>) {
    if pending.is_empty() {
        return;
    }
    let batch = std::mem::take(pending);
    let _ = app.emit("ts://share-net-log", batch);
}

/// 本机存在已断开的虚拟网卡（TAP、蓝牙 PAN、VMware 等）时，EasyTier 会把它们的
/// 169.254 / 旧 IPv6 地址逐一带上尝试，绑定失败后自动换下一个地址继续；SSDP 组播
/// 包也找不到对应对等节点。这些行每次重连都会重复一遍，属于噪声，不缓存也不推送。
/// `peer rpc transport read aborted` 是 easytier-cli 探活连接关闭时我们自己造成的，
/// 同样没有诊断价值。
fn is_benign_noise(line: &str) -> bool {
    line.contains("bind addr fail")
        || line.contains("bind failed, do not return error")
        || line.contains("can not find interface name by ip")
        || line.contains("no peer id for ip: 239.255.255.250")
        || line.contains("peer rpc transport read aborted")
}

fn push_log(logs: &Logs, value: &Value, secret: &str) -> Option<String> {
    let line = value.get("line").and_then(Value::as_str)?;
    let line = redact(line, secret)?;
    if is_benign_noise(line) {
        return None;
    }
    let mut guard = logs.lock().unwrap();
    if guard.len() >= 60 {
        guard.pop_front();
    }
    guard.push_back(line.to_string());
    Some(line.to_string())
}

const REPEAT_WINDOW: Duration = Duration::from_secs(3);

/// 去掉时间戳后的日志正文，用来识别「同类日志」。
fn log_body(line: &str) -> &str {
    for level in [" ERROR ", " WARN ", " INFO ", " DEBUG ", " TRACE "] {
        if let Some(pos) = line.find(level) {
            return &line[pos + 1..];
        }
    }
    line
}

/// 公共节点掉线重连时，EasyTier 控制面会以约 5Hz 重复同一条
/// `send_msg has error errs=[RouteError(None)]`，直到路由重新同步完成。
/// 这里把 3 秒窗口内正文相同的连续日志折叠成一条计数，避免刷屏；
/// 内容不同或窗口已过则照常输出。
struct RepeatFilter {
    body: String,
    count: u32,
    last_at: Instant,
}

impl RepeatFilter {
    fn new() -> Self {
        Self {
            body: String::new(),
            count: 0,
            last_at: Instant::now(),
        }
    }

    /// 返回 (要立即推送的行, 被折叠批次的摘要)。
    fn accept(&mut self, line: String) -> (Option<String>, Option<String>) {
        let body = log_body(&line).to_string();
        let now = Instant::now();
        if !self.body.is_empty()
            && body == self.body
            && now.duration_since(self.last_at) < REPEAT_WINDOW
        {
            self.count += 1;
            self.last_at = now;
            return (None, None);
        }
        let note = self.take_note();
        self.body = body;
        self.count = 0;
        self.last_at = now;
        (Some(line), note)
    }

    /// 刷屏停止后把计数补出来；仍在 3 秒窗口内时先不打扰。
    fn settle(&mut self) -> Option<String> {
        if self.count > 0 && self.last_at.elapsed() >= REPEAT_WINDOW {
            self.take_note()
        } else {
            None
        }
    }

    fn take_note(&mut self) -> Option<String> {
        if self.count == 0 {
            return None;
        }
        let count = std::mem::take(&mut self.count);
        Some(format!("（相同日志已折叠 ×{count}）{}", self.body))
    }
}

/// easytier-core 启动时会把整份 TOML 配置打进 info 日志，里面就有 `network_secret`。
/// 这些行会进错误提示、也会转发给前端，所以整行丢弃；万一密钥出现在别的行里，
/// 按值再兜一遍。
fn redact<'a>(line: &'a str, secret: &str) -> Option<&'a str> {
    if line.contains("network_secret") || (!secret.is_empty() && line.contains(secret)) {
        return None;
    }
    Some(line)
}

fn free_port() -> Result<u16, String> {
    let listener =
        std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|error| error.to_string())
}

#[cfg(windows)]
fn run_elevated(parameters: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let verb: Vec<u16> = "runas\0".encode_utf16().collect();
    let file: Vec<u16> = exe
        .to_string_lossy()
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let params: Vec<u16> = parameters
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();

    let mut info = SHELLEXECUTEINFOW::default();
    info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
    info.fMask = SEE_MASK_NOCLOSEPROCESS;
    info.lpVerb = PCWSTR(verb.as_ptr());
    info.lpFile = PCWSTR(file.as_ptr());
    info.lpParameters = PCWSTR(params.as_ptr());
    info.nShow = SW_HIDE.0;
    unsafe { ShellExecuteExW(&mut info) }.map_err(|error| {
        if error.code().0 as u32 == 0x8007_04C7 {
            "已取消管理员授权，无法创建 EasyTier 虚拟网卡".to_string()
        } else {
            format!("请求管理员权限失败: {error}")
        }
    })?;
    if !info.hProcess.is_invalid() {
        unsafe {
            let _ = CloseHandle(info.hProcess);
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn run_elevated(_parameters: &str) -> Result<(), String> {
    Err("屏幕共享目前仅支持 Windows".into())
}

/// Elevated side: owns easytier-core.exe and forwards its stdout/stderr.
pub fn helper_main(port: u16, token: &str) -> i32 {
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::process::{Command, Stdio};

    let listener = match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => listener,
        Err(_) => return 1,
    };
    let _ = listener.set_nonblocking(true);
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    let (stream, _) = loop {
        match listener.accept() {
            Ok(pair) => break pair,
            Err(ref error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return 1;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return 1,
        }
    };
    let _ = stream.set_nonblocking(false);
    let writer = match stream.try_clone() {
        Ok(writer) => Arc::new(Mutex::new(writer)),
        Err(_) => return 1,
    };
    let send = {
        let writer = writer.clone();
        move |value: Value| {
            if let Ok(mut guard) = writer.lock() {
                let _ = writeln!(guard, "{value}");
                let _ = guard.flush();
            }
        }
    };

    let mut reader = BufReader::new(stream);
    let mut auth = String::new();
    if reader.read_line(&mut auth).is_err() || auth.trim() != token {
        return 1;
    }
    send(json!({ "type": "ready" }));

    let mut child: Option<std::process::Child> = None;
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let Ok(message) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        match message.get("type").and_then(Value::as_str) {
            Some("start") => {
                let Some(program) = message.get("program").and_then(Value::as_str) else {
                    send(json!({ "type": "error", "message": "缺少程序路径" }));
                    continue;
                };
                let args: Vec<String> = message
                    .get("args")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default();

                #[cfg(windows)]
                let mut command = {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    let mut command = Command::new(program);
                    command.creation_flags(CREATE_NO_WINDOW);
                    command
                };
                #[cfg(not(windows))]
                let mut command = Command::new(program);

                match command
                    .args(&args)
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                {
                    Ok(mut spawned) => {
                        let pid = spawned.id();
                        if let Some(stdout) = spawned.stdout.take() {
                            spawn_log_reader(stdout, send.clone(), "stdout");
                        }
                        if let Some(stderr) = spawned.stderr.take() {
                            spawn_log_reader(stderr, send.clone(), "stderr");
                        }
                        send(json!({ "type": "started", "pid": pid }));
                        child = Some(spawned);
                    }
                    Err(error) => {
                        send(json!({ "type": "error", "message": error.to_string() }));
                    }
                }
            }
            Some("stop") => {
                if let Some(mut running) = child.take() {
                    let _ = running.kill();
                    let _ = running.wait();
                }
                send(json!({ "type": "stopped" }));
                break;
            }
            _ => {}
        }
    }
    if let Some(mut running) = child.take() {
        let _ = running.kill();
        let _ = running.wait();
    }
    0
}

fn spawn_log_reader<R: std::io::Read + Send + 'static>(
    stream: R,
    send: impl Fn(Value) + Send + 'static,
    channel: &'static str,
) {
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            send(json!({ "type": "log", "channel": channel, "line": trimmed }));
        }
        send(json!({ "type": "exit", "channel": channel }));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn forwarded_logs_never_carry_the_network_secret() {
        let logs: Logs = Arc::new(Mutex::new(VecDeque::new()));
        for line in [
            "network_secret = \"s3cr3t-v4lu3\"",
            "handshake failed for s3cr3t-v4lu3",
            "interface created",
        ] {
            push_log(&logs, &json!({ "type": "log", "line": line }), "s3cr3t-v4lu3");
        }
        assert_eq!(
            logs.lock().unwrap().iter().cloned().collect::<Vec<_>>(),
            vec!["interface created".to_string()]
        );
    }

    #[test]
    fn benign_adapter_noise_is_dropped() {
        let logs: Logs = Arc::new(Mutex::new(VecDeque::new()));
        for line in [
            "ERROR easytier::tunnel::tcp: bind addr fail bind_addr=169.254.97.252:0",
            "WARN easytier::tunnel::common: bind failed, do not return error for ipv6",
            "ERROR easytier::tunnel::common: can not find interface name by ip",
            "INFO easytier::peers::peer_manager: no peer id for ip: 239.255.255.250",
            "WARN easytier::proto::rpc_impl::bidirect: peer rpc transport read aborted, exiting",
            "INFO easytier::connector::manual: reconnect succ: 739671336",
        ] {
            push_log(&logs, &json!({ "type": "log", "line": line }), "");
        }
        assert_eq!(
            logs.lock().unwrap().iter().cloned().collect::<Vec<_>>(),
            vec!["INFO easytier::connector::manual: reconnect succ: 739671336".to_string()]
        );
    }

    #[test]
    fn log_body_drops_the_timestamp() {
        assert_eq!(
            log_body("2026-11-15T21:21:25.5313519+08:00  ERROR easytier::peers::peer_manager: send_msg has error"),
            "ERROR easytier::peers::peer_manager: send_msg has error"
        );
        assert_eq!(log_body("plain line"), "plain line");
    }

    #[test]
    fn repeated_route_errors_are_collapsed() {
        let mut filter = RepeatFilter::new();
        let line = || {
            "2026-11-15T21:21:25.5313519+08:00  ERROR easytier::peers::peer_manager: send_msg has error errs=[RouteError(None)]"
                .to_string()
        };
        let (emit, note) = filter.accept(line());
        assert!(emit.is_some(), "第一条必须照常推送");
        assert!(note.is_none());
        for _ in 0..5 {
            let (emit, note) = filter.accept(line());
            assert!(emit.is_none(), "窗口内相同日志必须折叠");
            assert!(note.is_none());
        }
        let note = filter.take_note().expect("刷屏停止后要补一条计数");
        assert!(note.contains("×5"), "{note}");
        assert!(note.contains("send_msg has error"), "{note}");
        assert!(filter.take_note().is_none(), "计数只能输出一次");
    }

    #[test]
    fn different_logs_are_not_collapsed() {
        let mut filter = RepeatFilter::new();
        let (first, _) = filter.accept(
            "2026-11-15T21:21:25.5+08:00  ERROR easytier::peers::peer_manager: one".into(),
        );
        let (second, _) = filter.accept(
            "2026-11-15T21:21:25.7+08:00  ERROR easytier::peers::peer_manager: two".into(),
        );
        assert!(first.is_some());
        assert!(second.is_some());
    }

    #[test]
    fn network_options_are_clamped_and_whitelisted() {
        let options: NetworkOptions = serde_json::from_value(json!({
            "transport": "p2p",
            "routeMode": "shortest",
            "mtu": 9000,
            "compression": "lz4",
            "multiRelay": false,
            "relayForeign": false,
            "logLevel": "debug"
        }))
        .unwrap();
        assert_eq!(options.transport(), "p2p");
        assert_eq!(options.mtu(), None, "MTU 超出 1200–1400 必须丢弃");
        assert_eq!(options.log_level(), "warn", "未知日志级别回落到 warn");
        assert!(!options.multi_relay());
        let small: NetworkOptions = serde_json::from_value(json!({ "mtu": 1200 })).unwrap();
        assert_eq!(small.mtu(), Some(1200));
        assert!(small.multi_relay(), "缺省仍然启用多中继");
        assert_eq!(small.transport(), "auto");
        let bogus: NetworkOptions =
            serde_json::from_value(json!({ "transport": "magic" })).unwrap();
        assert_eq!(bogus.transport(), "auto", "未知连接方式回落到自动");
    }

    #[test]
    fn args_reflect_network_options() {
        let peers = vec!["tcp://a:11010".to_string()];
        let options = NetworkOptions {
            transport: Some("relay".into()),
            route_mode: Some("shortest".into()),
            mtu: Some(1300),
            compression: Some("zstd".into()),
            multi_relay: Some(false),
            relay_foreign: Some(false),
            log_level: Some("error".into()),
        };
        let args = build_args(
            "rayspeak-x",
            "secret",
            "rs-p",
            "inst",
            "127.0.0.1:1",
            "tcp://0.0.0.0:2",
            "udp://0.0.0.0:2",
            "10.126.126.2/24",
            &peers,
            &options,
        );
        let value = |flag: &str| {
            let index = args.iter().position(|arg| arg == flag).expect(flag);
            args[index + 1].clone()
        };
        assert_eq!(value("--latency-first"), "false");
        assert_eq!(value("--console-log-level"), "error");
        assert_eq!(value("--mtu"), "1300");
        assert_eq!(value("--compression"), "zstd");
        assert_eq!(value("--disable-p2p"), "true");
        assert_eq!(value("--relay-network-whitelist"), "rayspeak-x");
        assert!(args.iter().any(|arg| arg == "tcp://a:11010"));

        let mut p2p = options.clone();
        p2p.transport = Some("p2p".into());
        let args = build_args(
            "rayspeak-x",
            "secret",
            "rs-p",
            "inst",
            "127.0.0.1:1",
            "tcp://0.0.0.0:2",
            "udp://0.0.0.0:2",
            "10.126.126.2/24",
            &peers,
            &p2p,
        );
        let value = |flag: &str| {
            let index = args.iter().position(|arg| arg == flag).expect(flag);
            args[index + 1].clone()
        };
        assert_eq!(value("--p2p-only"), "true");
        assert!(!args.iter().any(|arg| arg == "--disable-p2p"));
    }

    #[cfg(windows)]
    #[test]
    fn helper_relays_logs_and_stops_the_child() {
        use std::io::{BufRead, BufReader, Write};
        use std::net::TcpStream;
        use std::time::Instant;

        let port = free_port().unwrap();
        let worker = std::thread::spawn(move || helper_main(port, "test-token"));

        let mut stream = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            match TcpStream::connect(("127.0.0.1", port)) {
                Ok(connected) => {
                    stream = Some(connected);
                    break;
                }
                Err(_) => std::thread::sleep(Duration::from_millis(50)),
            }
        }
        let mut stream = stream.expect("helper did not accept a connection");
        stream.write_all(b"test-token
").unwrap();
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(line.contains("ready"), "{line}");

        stream
            .write_all(
                format!(
                    "{}
",
                    json!({
                        "type": "start",
                        "program": "cmd.exe",
                        "args": ["/c", "echo", "helper-ok"],
                    })
                )
                .as_bytes(),
            )
            .unwrap();

        let mut started = false;
        let mut logged = false;
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline && !(started && logged) {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            started |= line.contains("started");
            logged |= line.contains("helper-ok");
        }
        assert!(started, "helper never reported started");
        assert!(logged, "helper never relayed child output");

        stream.write_all(b"{\"type\":\"stop\"}
").unwrap();
        let mut stopped = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline && !stopped {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 {
                break;
            }
            stopped = line.contains("stopped");
        }
        assert!(stopped, "helper never acknowledged stop");
        assert_eq!(worker.join().unwrap(), 0);
    }
}

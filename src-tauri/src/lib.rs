use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

mod audio;
mod micdiag;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use md5::{Digest as _, Md5};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tsclient_rs::{
    banClient, clientKick, clientMove, download_icon, fileTransferDeleteFile, identityFromString,
    poke, send_plugin_command, sendTextMessage, uploadFileData, downloadFileData,
    Client, ClientOptions, ClientStatus, DirectorySnapshot, Event, Identity, KickReason, Logger,
    PluginCommandTarget, generateIdentity,
};

/// Server address is intentionally private: it is never returned to the UI.
const SERVER_ADDR: &str = "ray.ts3.uno:9987";
const SERVER_HOST: &str = "ray.ts3.uno";
const IDENTITY_LEVEL: i32 = 10;
const ICON_LIMIT: usize = 1024 * 1024;
const AVATAR_LIMIT: usize = 200_000;
const AVATAR_DOWNLOAD_LIMIT: u64 = 2 * 1024 * 1024;

static EXTRA_SECRETS: OnceLock<Mutex<Vec<String>>> = OnceLock::new();

fn register_secret(host: &str) {
    let host = host.trim();
    if host.is_empty() || host == SERVER_HOST {
        return;
    }
    let secrets = EXTRA_SECRETS.get_or_init(|| Mutex::new(Vec::new()));
    let mut list = secrets.lock().unwrap();
    if !list.iter().any(|item| item == host) {
        list.push(host.to_string());
    }
}

/// Captures the address that tsclient resolved through SRV/TSDNS so file
/// transfers can use the same reachable host instead of the bare domain.
struct HostLogger {
    target: Arc<Mutex<Option<String>>>,
}

impl Logger for HostLogger {
    fn debug(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        // RAYSPEAK_TRACE=1 时把下行命令序列写入临时文件，便于排查可见性问题。
        if std::env::var_os("RAYSPEAK_TRACE").is_none() {
            return;
        }
        let path = std::env::temp_dir().join("rayspeak_trace.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            use std::io::Write;
            let _ = writeln!(file, "{msg}");
        }
    }
    fn info(&self, msg: &str, _args: &[&dyn std::fmt::Display]) {
        let Some(rest) = msg.strip_prefix("connecting to server: ") else {
            return;
        };
        let target = rest.trim();
        let host = if let Some(stripped) = target.strip_prefix('[') {
            stripped.split(']').next().unwrap_or("")
        } else {
            target.rsplit_once(':').map(|(host, _)| host).unwrap_or(target)
        };
        if host.is_empty() {
            return;
        }
        register_secret(host);
        *self.target.lock().unwrap() = Some(host.to_string());
    }
    fn warn(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
    fn error(&self, _msg: &str, _args: &[&dyn std::fmt::Display]) {}
}

fn transfer_host(bridge: &Bridge) -> String {
    bridge
        .resolved_host
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| SERVER_HOST.to_string())
}

struct Bridge {
    runtime: Arc<tokio::runtime::Runtime>,
    client: Mutex<Option<Arc<Client>>>,
    generation: AtomicU64,
    self_clid: AtomicI32,
    groups: Mutex<Vec<GroupDto>>,
    icon_cache: Mutex<HashMap<u32, String>>,
    avatar_cache: Mutex<HashMap<String, String>>,
    last_snapshot: Mutex<String>,
    voice_enabled: AtomicBool,
    permissions: Mutex<Option<Vec<String>>>,
    resolved_host: Arc<Mutex<Option<String>>>,
    channel_quality: Mutex<HashMap<u64, u32>>,
    pending_deep_link: Mutex<Option<String>>,
    audio: Mutex<Option<Arc<audio::AudioEngine>>>,
}

impl Bridge {
    fn new() -> Self {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .expect("failed to create protocol runtime");
        Self {
            runtime: Arc::new(runtime),
            client: Mutex::new(None),
            generation: AtomicU64::new(0),
            self_clid: AtomicI32::new(0),
            groups: Mutex::new(Vec::new()),
            icon_cache: Mutex::new(HashMap::new()),
            avatar_cache: Mutex::new(HashMap::new()),
            last_snapshot: Mutex::new(String::new()),
            voice_enabled: AtomicBool::new(false),
            permissions: Mutex::new(None),
            resolved_host: Arc::new(Mutex::new(None)),
            channel_quality: Mutex::new(HashMap::new()),
            pending_deep_link: Mutex::new(None),
            audio: Mutex::new(None),
        }
    }
}

/// tsclient-rs futures are not `Send`, so they are polled on a blocking
/// thread against the bridge-owned runtime instead of Tauri's executor.
async fn run_proto<T: Send + 'static>(
    bridge: Arc<Bridge>,
    job: impl FnOnce(Arc<tokio::runtime::Runtime>) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let runtime = bridge.runtime.clone();
    tauri::async_runtime::spawn_blocking(move || job(runtime))
        .await
        .map_err(clean_error)?
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChannelDto {
    id: String,
    parent_id: String,
    name: String,
    description: String,
    order: u64,
    password: bool,
    max_clients: Option<u16>,
    codec: Option<i32>,
    bitrate: u32,
    icon_id: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClientDto {
    id: String,
    clid: i32,
    name: String,
    avatar_hash: Option<String>,
    channel_id: String,
    server_groups: Vec<String>,
    mic_muted: bool,
    output_muted: bool,
    away: bool,
    away_message: Option<String>,
    channel_commander: bool,
    client_type: i32,
    is_self: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GroupDto {
    id: String,
    name: String,
    kind: String,
    /// Signed: TS uses negative values for built-in group icons.
    icon_id: Option<i64>,
    order: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SnapshotDto {
    channels: Vec<ChannelDto>,
    clients: Vec<ClientDto>,
    groups: Vec<GroupDto>,
    self_clid: i32,
    truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ConnectResult {
    self_clid: i32,
    snapshot: SnapshotDto,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ClientDetailsDto {
    clid: i32,
    description: Option<String>,
    avatar_hash: Option<String>,
    platform: Option<String>,
    version: Option<String>,
    database_id: Option<String>,
    channel_group_id: Option<String>,
    channel_group_name: Option<String>,
    uid: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FileDto {
    name: String,
    size: String,
    datetime: String,
    directory: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StatsDto {
    ping: f64,
    packet_loss: f64,
    bandwidth_sent: f64,
    bandwidth_received: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ServerInfoDto {
    name: String,
    platform: String,
    version: String,
    max_clients: u32,
    online_clients: u32,
    uptime: u64,
    icon_id: Option<u32>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AppInfoDto {
    version: String,
    data_dir: String,
}

fn clean_error(message: impl std::fmt::Display) -> String {
    let mut text = message.to_string();
    let mut secrets = vec![SERVER_ADDR.to_string(), SERVER_HOST.to_string()];
    if let Some(extra) = EXTRA_SECRETS.get() {
        secrets.extend(extra.lock().unwrap().iter().cloned());
    }
    for secret in secrets {
        text = text.replace(&secret, "服务器");
    }
    // 只有服务器登录密码的错误才改写成登录提示：频道密码错误同样带有
    // "password" 字样，曾因此被误报成“服务器密码错误”，掩盖了真实原因。
    let lower = text.to_lowercase();
    if lower.contains("server password") || lower.contains("serverpassword") {
        text = "服务器密码错误或已失效".to_string();
    }
    if text.is_empty() {
        "操作失败".to_string()
    } else {
        text
    }
}

/// TS3 服务器错误 → 面向用户的提示。`clientmove` 的失败原因分成“密码不对”和
/// “权限不足”两类，混在一起会让人误以为是服务器密码错误。
///
/// 实测（RaySpeak 服务器）：频道密码被拒返回 `invalid channel password (id=781)`，
/// 而权限不足返回的是 `insufficient client permissions (id=2568)`——两者必须分开，
/// 否则非管理员会被“密码错误”误导着反复重输。
fn join_error_text(message: impl std::fmt::Display) -> String {
    let text = message.to_string();
    let lower = text.to_lowercase();
    let id = text
        .rsplit_once("id=")
        .map(|(_, tail)| tail.trim_end_matches(')').trim().to_string())
        .and_then(|value| value.parse::<i32>().ok());
    if lower.contains("invalid channel password") || matches!(id, Some(781)) {
        return "频道密码不正确，请重新输入".to_string();
    }
    if matches!(id, Some(2568))
        || lower.contains("insufficient client permissions")
        || lower.contains("join power")
    {
        return "当前身份没有加入该频道的权限（频道提高了加入权限值），需要管理员调整"
            .to_string();
    }
    if lower.contains("full") || lower.contains("maxclients") || matches!(id, Some(783)) {
        return "频道人数已满，暂时无法加入".to_string();
    }
    if lower.contains("invalid channelid")
        || lower.contains("invalid channel id")
        || matches!(id, Some(768))
    {
        return "频道不存在或已被删除".to_string();
    }
    clean_error(text)
}

fn get_client(bridge: &Bridge) -> Result<Arc<Client>, String> {
    bridge
        .client
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "尚未连接到服务器".to_string())
}

fn build_snapshot(
    snapshot: &DirectorySnapshot,
    groups: Vec<GroupDto>,
    self_clid: i32,
    quality: &HashMap<u64, u32>,
) -> SnapshotDto {
    SnapshotDto {
        channels: snapshot
            .channels
            .iter()
            .map(|channel| ChannelDto {
                id: channel.id.to_string(),
                parent_id: if channel.parent_id == 0 {
                    String::new()
                } else {
                    channel.parent_id.to_string()
                },
                name: channel.name.clone(),
                description: channel.description.clone(),
                order: channel.order,
                password: channel.password_protected.unwrap_or(false),
                max_clients: channel.max_clients,
                codec: channel.codec,
                bitrate: quality
                    .get(&channel.id)
                    .map(|value| (value.saturating_mul(12)).clamp(8, 510))
                    .unwrap_or(64),
                icon_id: channel.icon_id.filter(|id| *id > 0),
            })
            .collect(),
        clients: snapshot
            .clients
            .iter()
            .map(|client| ClientDto {
                id: if client.uid.is_empty() {
                    format!("clid-{}", client.id)
                } else {
                    client.uid.clone()
                },
                clid: client.id,
                name: client.nickname.clone(),
                avatar_hash: client.avatar.clone(),
                channel_id: client.channel_id.to_string(),
                server_groups: client
                    .server_groups
                    .iter()
                    .map(|id| format!("s{id}"))
                    .collect(),
                mic_muted: client.input_muted.unwrap_or(false),
                output_muted: client.output_muted.unwrap_or(false),
                away: client.away.unwrap_or(false),
                away_message: client.away_message.clone(),
                channel_commander: client.channel_commander.unwrap_or(false),
                client_type: client.r#type,
                is_self: client.id == self_clid,
            })
            .collect(),
        groups,
        self_clid,
        truncated: snapshot.truncated,
    }
}

fn value_of(row: &HashMap<String, String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| row.get(*key))
        .filter(|value| !value.is_empty())
        .cloned()
}

async fn fetch_groups(client: &Client) -> Vec<GroupDto> {
    let mut groups = Vec::new();
    if let Ok(rows) = client
        .exec_command_with_response("servergrouplist", 5000)
        .await
    {
        for (index, row) in rows.iter().enumerate() {
            let Some(raw_id) = value_of(row, &["sgid", "id"]) else {
                continue;
            };
            let name = value_of(row, &["name", "group_name"]).unwrap_or_else(|| raw_id.clone());
            if name.is_empty() {
                continue;
            }
            groups.push(GroupDto {
                id: format!("s{raw_id}"),
                name,
                kind: "server".to_string(),
                icon_id: value_of(row, &["iconid", "icon_id"])
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|id| *id != 0),
                order: index,
            });
        }
    }
    if let Ok(rows) = client
        .exec_command_with_response("channelgrouplist", 5000)
        .await
    {
        for (index, row) in rows.iter().enumerate() {
            let Some(raw_id) = value_of(row, &["cgid", "id"]) else {
                continue;
            };
            let name = value_of(row, &["name", "group_name"]).unwrap_or_else(|| raw_id.clone());
            if name.is_empty() {
                continue;
            }
            groups.push(GroupDto {
                id: format!("c{raw_id}"),
                name,
                kind: "channel".to_string(),
                icon_id: value_of(row, &["iconid", "icon_id"])
                    .and_then(|v| v.parse::<i64>().ok())
                    .filter(|id| *id != 0),
                order: index,
            });
        }
    }
    groups
}

async fn fetch_channel_quality(client: &Client) -> HashMap<u64, u32> {
    let mut quality = HashMap::new();
    if let Ok(rows) = client
        .exec_command_with_response("channellist -voice", 7000)
        .await
    {
        for row in rows {
            let Some(cid) = value_of(&row, &["cid"]).and_then(|value| value.parse::<u64>().ok())
            else {
                continue;
            };
            if let Some(value) = value_of(&row, &["channel_codec_quality", "codec_quality"])
                .and_then(|value| value.parse::<u32>().ok())
            {
                quality.insert(cid, value);
            }
        }
    }
    quality
}

fn attach_handlers(client: &Client, app: &AppHandle, bridge: Arc<Bridge>) {
    let text_app = app.clone();
    client.on_text_message(Arc::new(move |event| {
        if let Event::TextMessage(message) = event {
            let _ = text_app.emit(
                "ts://message",
                serde_json::json!({
                    "invokerClid": message.invoker_id,
                    "invokerUid": message.invoker_uid,
                    "invokerName": message.invoker_name,
                    "message": message.message,
                    "targetMode": message.target_mode,
                    "targetId": message.target_id.to_string(),
                    "invokerGroups": message.invoker_groups,
                }),
            );
        }
    }));

    let poke_app = app.clone();
    client.on_poked(Arc::new(move |event| {
        if let Event::Poked(poke) = event {
            let _ = poke_app.emit(
                "ts://poke",
                serde_json::json!({
                    "invokerClid": poke.invoker_id,
                    "invokerUid": poke.invoker_uid,
                    "invokerName": poke.invoker_name,
                    "message": poke.message,
                }),
            );
        }
    }));

    let kick_app = app.clone();
    client.on_kicked(Arc::new(move |event| {
        if let Event::Kicked(reason) = event {
            let _ = kick_app.emit("ts://kicked", serde_json::json!({ "reason": reason }));
        }
    }));

    let disconnect_app = app.clone();
    client.on_disconnected(Arc::new(move |event| {
        if let Event::Disconnected(error) = event {
            let _ = disconnect_app.emit(
                "ts://disconnected",
                serde_json::json!({ "error": error.map(clean_error) }),
            );
        }
    }));

    let plugin_app = app.clone();
    client.on_plugin_command(Arc::new(move |event| {
        if let Event::PluginCommand(command) = event {
            let _ = plugin_app.emit(
                "ts://plugin",
                serde_json::json!({
                    "name": command.name,
                    "data": command.data,
                    "invokerClid": command.invoker_id,
                    "invokerName": command.invoker_name,
                }),
            );
        }
    }));

    let voice_app = app.clone();
    let voice_bridge = bridge.clone();
    client.on_voice_data(Arc::new(move |event| {
        if let Event::VoiceData(voice) = event {
            // 播放统一在 WebView（Chromium + WebCodecs），这里只负责转发。
            if !voice_bridge.voice_enabled.load(Ordering::Relaxed) {
                return;
            }
            let _ = voice_app.emit(
                "ts://voice",
                serde_json::json!({
                    "packetId": voice.packet_id,
                    "clientId": voice.client_id,
                    "codec": voice.codec,
                    "data": BASE64.encode(voice.data),
                }),
            );
        }
    }));

    let perm_app = app.clone();
    client.on_own_permissions_changed(Arc::new(move |_| {
        let _ = perm_app.emit("ts://permissions", serde_json::json!({ "changed": true }));
    }));
}

fn identity_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| clean_error(error))?;
    std::fs::create_dir_all(&dir).map_err(|error| clean_error(error))?;
    Ok(dir.join("identity.dat"))
}

fn load_identity(app: &AppHandle) -> Result<Identity, String> {
    let path = identity_path(app)?;
    if let Ok(raw) = std::fs::read_to_string(&path) {
        if let Ok(identity) = identityFromString(raw.trim()) {
            return Ok(identity);
        }
    }
    let identity = generateIdentity(IDENTITY_LEVEL);
    let _ = std::fs::write(&path, identity.to_string());
    Ok(identity)
}

#[tauri::command]
fn get_identity_string(app: AppHandle) -> Result<String, String> {
    let path = identity_path(&app)?;
    let raw = std::fs::read_to_string(path).map_err(clean_error)?;
    Ok(raw.trim().to_string())
}

#[tauri::command]
fn export_identity(app: AppHandle, destination: String) -> Result<(), String> {
    let path = identity_path(&app)?;
    std::fs::copy(path, destination)
        .map(|_| ())
        .map_err(clean_error)
}

fn spawn_snapshot_loop(app: AppHandle, bridge: Arc<Bridge>, generation: u64) {
    tauri::async_runtime::spawn(async move {
        let mut ticks: u64 = 0;
        loop {
            tokio::time::sleep(Duration::from_millis(650)).await;
            ticks = ticks.wrapping_add(1);
            if bridge.generation.load(Ordering::SeqCst) != generation {
                break;
            }
            let client = bridge.client.lock().unwrap().clone();
            let Some(client) = client else {
                break;
            };
            if matches!(client.status(), ClientStatus::Disconnected) {
                bridge.client.lock().unwrap().take();
                let _ = app.emit(
                    "ts://disconnected",
                    serde_json::json!({ "error": "与服务器的连接已断开" }),
                );
                break;
            }
            if !client.directory_ready() {
                continue;
            }
            // 每 ~30 秒重新订阅一次整棵频道树：订阅可能因权限调整、重连或
            // 丢包漏掉成员事件，重新 `channelsubscribeall` 会让服务器把全部
            // 频道的成员再推一遍，等价于一次无损重同步。
            if ticks % 46 == 0 {
                let client = Arc::clone(&client);
                tauri::async_runtime::spawn(async move {
                    let _ = client.exec_command("channelsubscribeall", 5000).await;
                });
            }
            let Some(snapshot) = client.directory_snapshot() else {
                continue;
            };
            let groups = bridge.groups.lock().unwrap().clone();
            let quality = bridge.channel_quality.lock().unwrap().clone();
            let self_clid = bridge.self_clid.load(Ordering::Relaxed);
            let dto = build_snapshot(&snapshot, groups, self_clid, &quality);
            let json = serde_json::to_string(&dto).unwrap_or_default();
            let changed = {
                let mut last = bridge.last_snapshot.lock().unwrap();
                if *last == json {
                    false
                } else {
                    *last = json;
                    true
                }
            };
            if changed {
                let _ = app.emit("ts://snapshot", dto);
            }
        }
    });
}

#[tauri::command]
async fn connect_server(
    app: AppHandle,
    state: State<'_, Arc<Bridge>>,
    nickname: String,
    password: String,
    timeout: Option<u64>,
) -> Result<ConnectResult, String> {
    let nickname = nickname.trim().to_string();
    if nickname.is_empty() {
        return Err("请输入昵称".to_string());
    }
    if nickname.chars().count() > 30 {
        return Err("昵称不能超过 30 个字符".to_string());
    }
    let connect_timeout = timeout.unwrap_or(25).clamp(5, 60);
    let directory_timeout = connect_timeout.saturating_add(10);
    let bridge = state.inner().clone();
    let generation = bridge.generation.fetch_add(1, Ordering::SeqCst) + 1;

    if let Some(previous) = bridge.client.lock().unwrap().take() {
        spawn_disconnect(previous);
    }
    if let Some(engine) = bridge.audio.lock().unwrap().clone() {
        engine.set_client(None);
    }
    bridge.last_snapshot.lock().unwrap().clear();
    bridge.permissions.lock().unwrap().take();
    bridge.icon_cache.lock().unwrap().clear();
    bridge.avatar_cache.lock().unwrap().clear();
    bridge.self_clid.store(0, Ordering::Relaxed);
    *bridge.resolved_host.lock().unwrap() = None;
    bridge.channel_quality.lock().unwrap().clear();

    let job_app = app.clone();
    let job_bridge = bridge.clone();
    let resolved_host = bridge.resolved_host.clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let identity = load_identity(&job_app)?;
            let mut client = Client::new(
                identity,
                SERVER_ADDR.to_string(),
                nickname,
                ClientOptions {
                    server_password: if password.is_empty() {
                        None
                    } else {
                        Some(password)
                    },
                    logger: Arc::new(HostLogger {
                        target: resolved_host,
                    }),
                    ..Default::default()
                },
            );
            attach_handlers(&client, &job_app, job_bridge.clone());

            client.connect().await.map_err(clean_error)?;
            tokio::time::timeout(
                Duration::from_secs(connect_timeout),
                client.wait_connected(None),
            )
            .await
            .map_err(|_| "连接超时，请检查网络后重试".to_string())?
            .map_err(clean_error)?;
            tokio::time::timeout(
                Duration::from_secs(directory_timeout),
                client.wait_directory_ready(None),
            )
            .await
            .map_err(|_| "服务器频道目录加载超时".to_string())?
            .map_err(clean_error)?;

            let self_clid = client.client_id();
            // 关键：语音连接（client_type=0）的欢迎流只带当前频道的成员，
            // 服务器要等客户端订阅整棵频道树后才会推送其余频道的
            // channelclientlist / notifycliententerview。不发这条命令，新登录
            // 的账号永远只看得见自己频道里的人（哪怕别人就在隔壁频道）。
            // 失败只降级为「仅当前频道可见」，不能中断连接。
            if let Err(error) = client.exec_command("channelsubscribeall", 5000).await {
                eprintln!("channelsubscribeall 失败，成员可见范围将限制在当前频道: {error}");
            }
            // 说明：这里不要在语音连接上发 servernotifyregister / clientlist。
            // 前者对 client_type=0 一律返回 516 invalid client type，后者对
            // 普通身份返回 2568 权限不足；成员与事件都来自上面的订阅。
            let groups = fetch_groups(&client).await;
            let quality = fetch_channel_quality(&client).await;
            let snapshot = client
                .directory_snapshot()
                .map(|snapshot| build_snapshot(&snapshot, groups.clone(), self_clid, &quality))
                .ok_or_else(|| "无法读取服务器频道列表".to_string())?;

            *job_bridge.groups.lock().unwrap() = groups;
            *job_bridge.channel_quality.lock().unwrap() = quality;
            job_bridge.self_clid.store(self_clid, Ordering::Relaxed);
            let client = Arc::new(client);
            *job_bridge.client.lock().unwrap() = Some(client.clone());
            if let Some(engine) = job_bridge.audio.lock().unwrap().clone() {
                engine.set_client(Some(client));
            }
            *job_bridge.last_snapshot.lock().unwrap() =
                serde_json::to_string(&snapshot).unwrap_or_default();

            spawn_snapshot_loop(job_app.clone(), job_bridge.clone(), generation);
            let _ = job_app.emit("ts://connected", serde_json::json!({ "selfClid": self_clid }));

            Ok(ConnectResult {
                self_clid,
                snapshot,
            })
        })
    })
    .await
}

#[tauri::command]
async fn disconnect_server(state: State<'_, Arc<Bridge>>) -> Result<(), String> {
    let bridge = state.inner().clone();
    bridge.generation.fetch_add(1, Ordering::SeqCst);
    bridge.voice_enabled.store(false, Ordering::Relaxed);
    bridge.permissions.lock().unwrap().take();
    if let Some(engine) = bridge.audio.lock().unwrap().clone() {
        engine.set_client(None);
    }
    if let Some(client) = bridge.client.lock().unwrap().take() {
        spawn_disconnect(client);
    }
    Ok(())
}

fn spawn_disconnect(client: Arc<Client>) {
    std::thread::spawn(move || {
        if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            let _ = runtime.block_on(client.disconnect());
        }
    });
}

#[tauri::command]
fn get_snapshot(state: State<'_, Arc<Bridge>>) -> Result<SnapshotDto, String> {
    let bridge = state.inner();
    let client = get_client(bridge)?;
    let snapshot = client
        .directory_snapshot()
        .ok_or_else(|| "频道目录尚未就绪".to_string())?;
    Ok(build_snapshot(
        &snapshot,
        bridge.groups.lock().unwrap().clone(),
        bridge.self_clid.load(Ordering::Relaxed),
        &bridge.channel_quality.lock().unwrap().clone(),
    ))
}

#[tauri::command]
async fn refresh_directory(state: State<'_, Arc<Bridge>>) -> Result<SnapshotDto, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let job_bridge = bridge.clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            // `clientlist` 对普通身份不可用（2568），刷新目录时重新订阅整棵
            // 频道树，服务器会把所有频道的成员重新推一遍。
            let _ = client.exec_command("channelsubscribeall", 5000).await;
            let groups = fetch_groups(&client).await;
            let quality = fetch_channel_quality(&client).await;
            let self_clid = client.client_id();
            let snapshot = client
                .directory_snapshot()
                .ok_or_else(|| "频道目录尚未就绪".to_string())?;
            *job_bridge.groups.lock().unwrap() = groups.clone();
            *job_bridge.channel_quality.lock().unwrap() = quality.clone();
            let dto = build_snapshot(&snapshot, groups, self_clid, &quality);
            *job_bridge.last_snapshot.lock().unwrap() =
                serde_json::to_string(&dto).unwrap_or_default();
            Ok(dto)
        })
    })
    .await
}

#[tauri::command]
fn take_deep_link(state: State<'_, Arc<Bridge>>) -> Option<String> {
    state.inner().pending_deep_link.lock().unwrap().take()
}

#[tauri::command]
async fn join_channel(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    password: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    let password = password.unwrap_or_default();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            clientMove(&client, client.client_id(), channel_id, &password)
                .await
                .map_err(join_error_text)
        })
    })
    .await
}

#[tauri::command]
async fn send_channel_message(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    message: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            sendTextMessage(&client, 2, channel_id, &message)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn send_private_message(
    state: State<'_, Arc<Bridge>>,
    target_clid: i32,
    message: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            sendTextMessage(&client, 1, target_clid as u64, &message)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn send_server_message(
    state: State<'_, Arc<Bridge>>,
    message: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            sendTextMessage(&client, 3, 0, &message)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn poke_client(
    state: State<'_, Arc<Bridge>>,
    target_clid: i32,
    message: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            poke(&client, target_clid, &message)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn move_client(
    state: State<'_, Arc<Bridge>>,
    target_clid: i32,
    channel_id: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            clientMove(&client, target_clid, channel_id, "")
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn kick_client(
    state: State<'_, Arc<Bridge>>,
    target_clid: i32,
    reason: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let reason = reason.unwrap_or_else(|| "被管理员移出服务器".to_string());
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            clientKick(&client, target_clid, KickReason::Server, &reason)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn ban_client(
    state: State<'_, Arc<Bridge>>,
    target_clid: i32,
    seconds: Option<u64>,
    reason: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let seconds = seconds.unwrap_or(0);
    let reason = reason.unwrap_or_else(|| "违反服务器规则".to_string());
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            banClient(&client, target_clid, seconds, &reason)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

fn escaped(value: &str) -> String {
    tsclient_rs::escape(value).0
}

fn codec_number(codec: &str) -> &'static str {
    if codec.to_lowercase().contains("music") {
        "4"
    } else {
        "5"
    }
}

fn codec_quality(bitrate: u32) -> String {
    ((bitrate as f32 / 12.0).round() as i32).clamp(0, 10).to_string()
}

#[tauri::command]
async fn create_channel(
    state: State<'_, Arc<Bridge>>,
    name: String,
    description: String,
    parent_id: Option<String>,
    max_clients: u32,
    codec: String,
    bitrate: u32,
    password: Option<String>,
) -> Result<String, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let parent = parent_id
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let max_clients = if max_clients == 0 {
        "-1".to_string()
    } else {
        max_clients.to_string()
    };
    let quality = codec_quality(bitrate);
    let codec_num = codec_number(&codec);
    let mut command = format!(
        "channelcreate channel_name={} cpid={} channel_flag_permanent=1 channel_maxclients={} channel_codec={} channel_codec_quality={} channel_topic={} channel_description={}",
        escaped(&name),
        parent,
        max_clients,
        codec_num,
        quality,
        escaped(&description),
        escaped(&description)
    );
    if let Some(password) = password.filter(|value| !value.is_empty()) {
        command.push_str(&format!(" channel_password={}", escaped(&password)));
    }
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let rows = client
                .exec_command_with_response(&command, 7000)
                .await
                .map_err(clean_error)?;
            let new_id = rows
                .first()
                .and_then(|row| value_of(row, &["cid"]))
                .ok_or_else(|| "频道已创建，但服务器未返回频道 ID".to_string())?;
            if let Ok(channel_id) = new_id.parse::<u64>() {
                let _ = clientMove(&client, client.client_id(), channel_id, "").await;
            }
            Ok(new_id)
        })
    })
    .await
}

#[tauri::command]
async fn edit_channel(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    name: String,
    description: String,
    parent_id: Option<String>,
    max_clients: u32,
    codec: String,
    bitrate: u32,
    password: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let parent = parent_id
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let max_clients = if max_clients == 0 {
        "-1".to_string()
    } else {
        max_clients.to_string()
    };
    let mut command = format!(
        "channeledit cid={} channel_name={} cpid={} channel_maxclients={} channel_codec={} channel_codec_quality={} channel_topic={} channel_description={}",
        channel_id,
        escaped(&name),
        parent,
        max_clients,
        codec_number(&codec),
        codec_quality(bitrate),
        escaped(&description),
        escaped(&description)
    );
    if let Some(password) = password {
        command.push_str(&format!(" channel_password={}", escaped(&password)));
    }
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            client
                .exec_command(&command, 7000)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn delete_channel(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let command = format!("channeldelete cid={} force=1", channel_id);
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            client
                .exec_command(&command, 7000)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn update_self(
    state: State<'_, Arc<Bridge>>,
    nickname: Option<String>,
    description: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let self_clid = bridge.self_clid.load(Ordering::Relaxed);
    let mut commands: Vec<String> = Vec::new();
    if let Some(nickname) = nickname {
        let trimmed = nickname.trim();
        if !trimmed.is_empty() {
            commands.push(format!("clientupdate client_nickname={}", escaped(trimmed)));
        }
    }
    if let Some(description) = description {
        // clientupdate 不接受 client_description；改自己的简介必须走 clientedit
        // （服务器权限 b_client_modify_own_description）。
        if self_clid <= 0 {
            return Err("尚未连接到服务器".to_string());
        }
        commands.push(format!(
            "clientedit clid={} client_description={}",
            self_clid,
            escaped(description.trim())
        ));
    }
    if commands.is_empty() {
        return Ok(());
    }
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            for command in commands {
                client
                    .exec_command(&command, 5000)
                    .await
                    .map_err(clean_error)?;
            }
            Ok(())
        })
    })
    .await
}

#[tauri::command]
async fn get_client_details(
    state: State<'_, Arc<Bridge>>,
    clid: i32,
) -> Result<ClientDetailsDto, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let groups = bridge.groups.lock().unwrap().clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let rows = client
                .exec_command_with_response(&format!("clientinfo clid={clid}"), 5000)
                .await
                .map_err(clean_error)?;
            let row = rows.first().ok_or_else(|| "未找到该用户".to_string())?;
            let channel_group_id = value_of(row, &["client_channel_group_id"])
                .map(|id| format!("c{id}"));
            let channel_group_name = channel_group_id.as_ref().and_then(|id| {
                groups
                    .iter()
                    .find(|group| group.kind == "channel" && &group.id == id)
                    .map(|group| group.name.clone())
            });
            Ok(ClientDetailsDto {
                clid,
                description: value_of(row, &["client_description"]),
                avatar_hash: value_of(row, &["client_flag_avatar"]),
                platform: value_of(row, &["client_platform"]),
                version: value_of(row, &["client_version"]),
                database_id: value_of(row, &["client_database_id"]),
                channel_group_id,
                channel_group_name,
                uid: value_of(row, &["client_unique_identifier"]),
            })
        })
    })
    .await
}

#[tauri::command]
async fn get_my_permissions(state: State<'_, Arc<Bridge>>) -> Result<Vec<String>, String> {
    let bridge = state.inner().clone();
    if let Some(cached) = bridge.permissions.lock().unwrap().clone() {
        return Ok(cached);
    }
    let client = get_client(&bridge)?;
    let job_bridge = bridge.clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let self_clid = client.client_id();
            let info = client
                .exec_command_with_response(&format!("clientinfo clid={self_clid}"), 5000)
                .await
                .map_err(clean_error)?;
            let dbid = info
                .first()
                .and_then(|row| value_of(row, &["client_database_id"]))
                .ok_or_else(|| "无法读取当前身份".to_string())?;
            let permission_rows = client
                .exec_command_with_response("permissionlist", 5000)
                .await
                .map_err(clean_error)?;
            let names: HashMap<String, String> = permission_rows
                .iter()
                .filter_map(|row| {
                    Some((
                        value_of(row, &["permid", "id"])?,
                        value_of(row, &["permname", "name"])?,
                    ))
                })
                .collect();
            let rows = client
                .exec_command_with_response(&format!("clientpermlist cldbid={dbid}"), 7000)
                .await
                .map_err(clean_error)?;
            let mut granted = Vec::new();
            for row in &rows {
                let Some(permid) = value_of(row, &["permid", "id"]) else {
                    continue;
                };
                let value: i32 = value_of(row, &["permvalue", "value"])
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                let negated = value_of(row, &["permnegated"]).as_deref() == Some("1");
                let skip = value_of(row, &["permskip"]).as_deref() == Some("1");
                if value > 0 && !negated && !skip {
                    if let Some(name) = names.get(&permid) {
                        granted.push(name.clone());
                    }
                }
            }
            *job_bridge.permissions.lock().unwrap() = Some(granted.clone());
            Ok(granted)
        })
    })
    .await
}

#[tauri::command]
async fn get_stats(state: State<'_, Arc<Bridge>>) -> Result<StatsDto, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let rows = client
                .exec_command_with_response("serverrequestconnectioninfo", 4000)
                .await
                .map_err(clean_error)?;
            let row = rows.first().ok_or_else(|| "无法读取连接信息".to_string())?;
            let number = |keys: &[&str]| -> f64 {
                value_of(row, keys)
                    .and_then(|value| value.parse::<f64>().ok())
                    .unwrap_or(0.0)
            };
            Ok(StatsDto {
                ping: number(&["connection_ping", "ping"]),
                packet_loss: number(&["connection_packetloss_total", "packetloss"]),
                bandwidth_sent: number(&["connection_bandwidth_sent_last_second_total"]),
                bandwidth_received: number(&["connection_bandwidth_received_last_second_total"]),
            })
        })
    })
    .await
}

fn server_info_from_properties(client: &Client) -> Option<ServerInfoDto> {
    let props = client.server_properties();
    let name = props.get("virtualserver_name")?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let number = |key: &str| -> u64 {
        props
            .get(key)
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
    };
    Some(ServerInfoDto {
        name,
        platform: props
            .get("virtualserver_platform")
            .cloned()
            .unwrap_or_default(),
        version: props
            .get("virtualserver_version")
            .cloned()
            .unwrap_or_default(),
        max_clients: number("virtualserver_maxclients") as u32,
        online_clients: number("virtualserver_clientsonline") as u32,
        uptime: number("virtualserver_uptime"),
        icon_id: props
            .get("virtualserver_icon_id")
            .and_then(|value| value.parse::<i64>().ok())
            .map(|id| id as u32)
            .filter(|id| *id != 0),
    })
}

#[tauri::command]
async fn get_server_info(state: State<'_, Arc<Bridge>>) -> Result<ServerInfoDto, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    if let Some(info) = server_info_from_properties(&client) {
        return Ok(info);
    }
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let rows = client
                .exec_command_with_response("serverinfo", 4000)
                .await
                .map_err(clean_error)?;
            let row = rows.first().ok_or_else(|| "无法读取服务器信息".to_string())?;
            let number = |keys: &[&str]| -> u64 {
                value_of(row, keys)
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(0)
            };
            Ok(ServerInfoDto {
                name: value_of(row, &["virtualserver_name"]).unwrap_or_default(),
                platform: value_of(row, &["virtualserver_platform"]).unwrap_or_default(),
                version: value_of(row, &["virtualserver_version"]).unwrap_or_default(),
                max_clients: number(&["virtualserver_maxclients"]) as u32,
                online_clients: number(&["virtualserver_clientsonline"]) as u32,
                uptime: number(&["virtualserver_uptime"]),
                icon_id: value_of(row, &["virtualserver_icon_id"])
                    .and_then(|value| value.parse::<u32>().ok())
                    .filter(|id| *id > 0),
            })
        })
    })
    .await
}

#[tauri::command]
fn get_app_info(app: AppHandle) -> Result<AppInfoDto, String> {
    let data_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| clean_error(error))?;
    Ok(AppInfoDto {
        version: app.package_info().version.to_string(),
        data_dir: data_dir.to_string_lossy().to_string(),
    })
}

#[tauri::command]
fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| clean_error(error))?;
    std::fs::create_dir_all(&dir).map_err(|error| clean_error(error))?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|error| clean_error(error))?;
    }
    #[cfg(not(target_os = "windows"))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|error| clean_error(error))?;
    }
    Ok(())
}

#[tauri::command]
async fn list_files(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
) -> Result<Vec<FileDto>, String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let command = format!("ftgetfilelist cid={} cpw= path=/", channel_id);
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let rows = client
                .exec_command_with_response(&command, 7000)
                .await
                .map_err(clean_error)?;
            Ok(rows
                .iter()
                .filter_map(|row| {
                    let name = value_of(row, &["name"])?;
                    Some(FileDto {
                        name,
                        size: value_of(row, &["size"]).unwrap_or_else(|| "0".to_string()),
                        datetime: value_of(row, &["datetime"]).unwrap_or_default(),
                        directory: value_of(row, &["type"]).as_deref() == Some("1"),
                    })
                })
                .filter(|file| !file.directory)
                .collect())
        })
    })
    .await
}

#[tauri::command]
async fn upload_file(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    local_path: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    let host = transfer_host(&bridge);
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let path = Path::new(&local_path);
            let metadata = tokio::fs::metadata(path)
                .await
                .map_err(|error| clean_error(error))?;
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "无法读取文件名".to_string())?;
            let info = client
                .file_transfer_init_upload(
                    channel_id,
                    &format!("/{name}"),
                    "",
                    metadata.len(),
                    true,
                )
                .await
                .map_err(clean_error)?;
            let file = tokio::fs::File::open(path)
                .await
                .map_err(|error| clean_error(error))?;
            uploadFileData(&host, &info, file)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn download_file(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    file_name: String,
    destination: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    let host = transfer_host(&bridge);
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let info = client
                .file_transfer_init_download(channel_id, &format!("/{file_name}"), "")
                .await
                .map_err(clean_error)?;
            let mut file = tokio::fs::File::create(&destination)
                .await
                .map_err(|error| clean_error(error))?;
            downloadFileData(&host, &info, &mut file)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn delete_file(
    state: State<'_, Arc<Bridge>>,
    channel_id: String,
    file_name: String,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let channel_id: u64 = channel_id
        .parse()
        .map_err(|_| "无效的频道".to_string())?;
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            fileTransferDeleteFile(&client, channel_id, &[format!("/{file_name}")])
                .await
                .map_err(clean_error)
        })
    })
    .await
}

fn image_mime(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.starts_with(b"GIF8") {
        "image/gif"
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        "image/webp"
    } else {
        "image/png"
    }
}

#[tauri::command]
async fn fetch_channel_icon(
    state: State<'_, Arc<Bridge>>,
    icon_id: u32,
) -> Result<String, String> {
    let bridge = state.inner().clone();
    if let Some(cached) = bridge.icon_cache.lock().unwrap().get(&icon_id).cloned() {
        return Ok(cached);
    }
    let client = get_client(&bridge)?;
    let job_bridge = bridge.clone();
    let host = transfer_host(&bridge);
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let bytes = download_icon(&client, &host, icon_id, ICON_LIMIT)
                .await
                .map_err(clean_error)?;
            let data_url = format!(
                "data:{};base64,{}",
                image_mime(&bytes),
                BASE64.encode(bytes)
            );
            job_bridge
                .icon_cache
                .lock()
                .unwrap()
                .insert(icon_id, data_url.clone());
            Ok(data_url)
        })
    })
    .await
}

fn avatar_file_name(uid: &str) -> Result<String, String> {
    let bytes = BASE64
        .decode(uid)
        .map_err(|_| "无法解析用户标识".to_string())?;
    if bytes.is_empty() {
        return Err("无法解析用户标识".to_string());
    }
    let mut letters = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        letters.push((b'a' + (byte >> 4)) as char);
        letters.push((b'a' + (byte & 0x0f)) as char);
    }
    Ok(format!("/avatar_{letters}"))
}

fn avatar_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, 0x50, 0x4e, 0x47]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

#[tauri::command]
async fn fetch_client_avatar(
    state: State<'_, Arc<Bridge>>,
    uid: String,
    avatar_hash: String,
) -> Result<String, String> {
    if uid.is_empty() || avatar_hash.is_empty() {
        return Err("该用户没有头像".to_string());
    }
    let bridge = state.inner().clone();
    let key = format!("{uid}:{avatar_hash}");
    if let Some(cached) = bridge.avatar_cache.lock().unwrap().get(&key).cloned() {
        return Ok(cached);
    }
    let client = get_client(&bridge)?;
    let path = avatar_file_name(&uid)?;
    let host = transfer_host(&bridge);
    let job_bridge = bridge.clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let info = client
                .file_transfer_init_download(0, &path, "")
                .await
                .map_err(clean_error)?;
            if info.size == 0 || info.size > AVATAR_DOWNLOAD_LIMIT {
                return Err("头像文件大小异常".to_string());
            }
            let mut data = Vec::with_capacity(info.size as usize);
            client
                .download_file_data(&host, &info, &mut data)
                .await
                .map_err(clean_error)?;
            let mime = avatar_mime(&data).ok_or_else(|| "头像不是有效的图片".to_string())?;
            let url = format!("data:{};base64,{}", mime, BASE64.encode(&data));
            job_bridge
                .avatar_cache
                .lock()
                .unwrap()
                .insert(key, url.clone());
            Ok(url)
        })
    })
    .await
}

#[tauri::command]
async fn upload_avatar(state: State<'_, Arc<Bridge>>, data: String) -> Result<String, String> {
    let bridge = state.inner().clone();
    let bytes = BASE64
        .decode(data)
        .map_err(|_| "无法读取头像数据".to_string())?;
    if bytes.is_empty() {
        return Err("头像文件为空".to_string());
    }
    if bytes.len() > AVATAR_LIMIT {
        return Err(format!("头像不能超过 {} KB", AVATAR_LIMIT / 1000));
    }
    avatar_mime(&bytes).ok_or_else(|| "请选择 PNG、JPEG、GIF 或 WebP 图片".to_string())?;
    let client = get_client(&bridge)?;
    let host = transfer_host(&bridge);
    let mut hasher = Md5::new();
    hasher.update(&bytes);
    let md5_hex = format!("{:x}", hasher.finalize());
    let path = format!("/avatar_{md5_hex}");
    let upload_md5 = md5_hex.clone();
    let job_bridge = bridge.clone();
    let job_client = client.clone();
    let result = run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            let info = client
                .file_transfer_init_upload(0, &path, "", bytes.len() as u64, true)
                .await
                .map_err(clean_error)?;
            client
                .upload_file_data(&host, &info, bytes.as_slice())
                .await
                .map_err(clean_error)?;
            client
                .exec_command(&format!("clientupdate client_flag_avatar={upload_md5}"), 6000)
                .await
                .map_err(clean_error)
        })
    })
    .await;
    result?;
    job_client.set_own_avatar(Some(md5_hex.clone()));
    job_bridge.avatar_cache.lock().unwrap().clear();
    Ok(md5_hex)
}

#[tauri::command]
async fn delete_avatar(state: State<'_, Arc<Bridge>>) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let job_client = client.clone();
    let job_bridge = bridge.clone();
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            fileTransferDeleteFile(&client, 0, &["/avatar_".to_string()])
                .await
                .map_err(clean_error)?;
            let _ = client
                .exec_command("clientupdate client_flag_avatar=", 4000)
                .await;
            Ok(())
        })
    })
    .await?;
    job_client.set_own_avatar(None);
    job_bridge.avatar_cache.lock().unwrap().clear();
    Ok(())
}

#[tauri::command]
fn set_voice_enabled(state: State<'_, Arc<Bridge>>, enabled: bool) {
    state.inner().voice_enabled.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
fn apply_native_audio(state: State<'_, Arc<Bridge>>, config: audio::NativeAudioConfig) {
    let engine = state.inner().audio.lock().unwrap().clone();
    if let Some(engine) = engine {
        engine.apply_config(config);
    }
}

#[tauri::command]
fn list_native_audio_inputs() -> Vec<String> {
    audio::list_input_devices()
}

#[tauri::command]
fn set_native_ptt(state: State<'_, Arc<Bridge>>, active: bool) {
    if let Some(engine) = state.inner().audio.lock().unwrap().clone() {
        engine.set_ptt(active);
    }
}

#[tauri::command]
fn native_audio_stats(state: State<'_, Arc<Bridge>>) -> audio::AudioStats {
    state
        .inner()
        .audio
        .lock()
        .unwrap()
        .as_ref()
        .map(|engine| engine.snapshot())
        .unwrap_or_default()
}

#[tauri::command]
fn send_voice_data(
    state: State<'_, Arc<Bridge>>,
    data: String,
    codec: u32,
) -> Result<(), String> {
    let bridge = state.inner();
    let client = get_client(bridge)?;
    let bytes = BASE64.decode(data).map_err(clean_error)?;
    client.send_voice(bytes, codec as i32);
    Ok(())
}

#[tauri::command]
async fn set_audio_state(
    state: State<'_, Arc<Bridge>>,
    input_muted: bool,
    output_muted: bool,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let command = format!(
        "clientupdate client_input_muted={} client_output_muted={}",
        input_muted as i32, output_muted as i32
    );
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            client
                .exec_command(&command, 3000)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn set_away(
    state: State<'_, Arc<Bridge>>,
    away: bool,
    message: Option<String>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let command = if away {
        format!(
            "clientupdate client_away=1 client_away_message={}",
            escaped(message.as_deref().unwrap_or("离开"))
        )
    } else {
        "clientupdate client_away=0".to_string()
    };
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            client
                .exec_command(&command, 3000)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

#[tauri::command]
async fn send_plugin_command_backend(
    state: State<'_, Arc<Bridge>>,
    name: String,
    data: String,
    target: i32,
    target_id: Option<i32>,
) -> Result<(), String> {
    let bridge = state.inner().clone();
    let client = get_client(&bridge)?;
    let target = match target {
        1 => PluginCommandTarget::Server,
        2 => PluginCommandTarget::Client,
        _ => PluginCommandTarget::CurrentChannel,
    };
    run_proto(bridge, move |runtime| {
        runtime.block_on(async move {
            send_plugin_command(&client, &name, &data, target, target_id)
                .await
                .map_err(clean_error)
        })
    })
    .await
}

/// 麦克风诊断：录 WAV + 客观指标，供 `rayspeak.exe --mic-diag` 使用。
pub fn mic_diag(seconds: f32) -> String {
    micdiag::run(seconds)
}

/// 逐个探测输入设备是否有信号，供 `rayspeak.exe --mic-scan` 使用。
pub fn mic_scan() -> String {
    micdiag::scan()
}

/// 设置页的「检测麦克风输入」：每个设备只录 0.8 秒，避免占用设备太久。
#[tauri::command]
fn probe_mic_devices() -> Result<String, String> {
    Ok(micdiag::scan_devices(0.8))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // 单实例必须保持“第一个注册”（深链转发依赖它）。本地联调需要同时运行两个
    // 客户端来验证跨频道成员可见性时，可用 RAYSPEAK_ALLOW_MULTI_INSTANCE=1
    // 启动第二个实例；正常用户启动路径不受影响。
    let builder = if std::env::var_os("RAYSPEAK_ALLOW_MULTI_INSTANCE").is_some() {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
    };
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let _ = handle.emit("ts://deep-link", url.to_string());
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    if let Some(url) = urls.first() {
                        let bridge = app.state::<Arc<Bridge>>();
                        *bridge.pending_deep_link.lock().unwrap() = Some(url.to_string());
                    }
                }
                let _ = app.deep_link().register_all();
            }
            let bridge = app.state::<Arc<Bridge>>();
            let engine = Arc::new(audio::AudioEngine::start(app.handle().clone()));
            *bridge.audio.lock().unwrap() = Some(engine);
            Ok(())
        })
        .manage(Arc::new(Bridge::new()))
        .invoke_handler(tauri::generate_handler![
            connect_server,
            disconnect_server,
            get_identity_string,
            export_identity,
            get_snapshot,
            refresh_directory,
            take_deep_link,
            join_channel,
            send_channel_message,
            send_private_message,
            send_server_message,
            poke_client,
            move_client,
            kick_client,
            ban_client,
            create_channel,
            edit_channel,
            delete_channel,
            update_self,
            get_client_details,
            get_my_permissions,
            get_stats,
            get_server_info,
            get_app_info,
            open_data_dir,
            list_files,
            upload_file,
            download_file,
            delete_file,
            fetch_channel_icon,
            fetch_client_avatar,
            upload_avatar,
            delete_avatar,
            set_voice_enabled,
            apply_native_audio,
            list_native_audio_inputs,
            set_native_ptt,
            native_audio_stats,
            probe_mic_devices,
            send_voice_data,
            set_audio_state,
            set_away,
            send_plugin_command_backend
        ])
        .run(tauri::generate_context!())
        .expect("error while running RaySpeak");
}

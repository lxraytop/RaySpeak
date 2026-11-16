// 屏幕共享：EasyTier 组网 + 虚拟网内自建信令 + WebRTC。
//
// 媒体与信令都不经过 TeamSpeak 服务器：共享页会按「当前 TS 频道」在本地派生一个
// EasyTier 网络，同频道的 RaySpeak 客户端加入同一虚拟网，再用虚拟网地址直接
// 交换 SDP/ICE，WebRTC 画面走 EasyTier 的 P2P 或公共节点中继。
//
// 房间密钥只在本机由服务器地址与频道派生，不落地、不返回前端，也不写入日志。

pub mod capture_math;
#[cfg(not(test))]
pub mod capture;
#[cfg(test)]
#[path = "capture_stub.rs"]
pub mod capture;
pub mod audio;
pub mod easytier;
pub mod nodes;
pub mod signal;
pub mod stun;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex as AsyncMutex;

use easytier::Network;
use signal::SignalMesh;
use stun::StunServer;

const SIGNAL_PORT: u16 = 47654;
const VIRTUAL_SUBNET: [u8; 3] = [10, 126, 126];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkInfo {
    pub room_id: String,
    pub network: String,
    pub peer_id: String,
    pub nickname: String,
    pub ip: String,
    pub signal_port: u16,
    /// 本次房间实际使用的主中继节点（邀请码会带上它）。
    pub node_id: String,
    pub node_label: String,
    /// 主节点 URI；自定义节点没有 id，邀请码需要用它让好友加入同一节点。
    pub node_uri: String,
    pub node_latency_ms: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SharePeer {
    pub peer_id: String,
    pub nickname: String,
    pub ip: String,
    pub connected: bool,
    pub latency_ms: Option<f64>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NetworkStatus {
    pub phase: String,
    pub info: Option<NetworkInfo>,
    pub error: Option<String>,
}

pub struct ShareManager {
    app: AppHandle,
    info: Mutex<Option<NetworkInfo>>,
    network: Mutex<Option<Network>>,
    signal: Mutex<Option<SignalMesh>>,
    stun: Mutex<Option<StunServer>>,
    capture: Mutex<Option<Arc<capture::CaptureSession>>>,
    audio: Mutex<Option<Arc<audio::AudioSession>>>,
    start_guard: AsyncMutex<()>,
    capture_guard: AsyncMutex<()>,
    /// 递增用于取消进行中的启动流程：停止网络时旧启动必须自行回滚。
    generation: AtomicU64,
    capture_generation: AtomicU64,
}

impl ShareManager {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            info: Mutex::new(None),
            network: Mutex::new(None),
            signal: Mutex::new(None),
            stun: Mutex::new(None),
            capture: Mutex::new(None),
            audio: Mutex::new(None),
            start_guard: AsyncMutex::new(()),
            capture_guard: AsyncMutex::new(()),
            generation: AtomicU64::new(0),
            capture_generation: AtomicU64::new(0),
        }
    }

    fn emit_status(&self, phase: &str, info: Option<NetworkInfo>, error: Option<String>) {
        let _ = self.app.emit(
            "ts://share-status",
            NetworkStatus {
                phase: phase.to_string(),
                info,
                error,
            },
        );
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Derives the EasyTier network and secret from the TS server + channel id.
/// The server address never leaves this process; only the resulting hash is used.
fn derive_room(channel_id: u64, pin: &str) -> (String, String, String) {
    let mut room = Sha256::new();
    room.update(b"rayspeak-screen-share-v1");
    room.update(crate::SERVER_ADDR.as_bytes());
    room.update(channel_id.to_le_bytes());
    let room_id = hex(&room.finalize()[..16]);

    let mut secret = Sha256::new();
    secret.update(b"rayspeak-screen-share-secret-v1");
    secret.update(room_id.as_bytes());
    secret.update(pin.trim().as_bytes());
    let secret = hex(&secret.finalize());

    (format!("rayspeak-{}", &room_id[..12]), room_id, secret)
}

fn random_peer_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn random_ip(peer_id: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(peer_id.as_bytes());
    hasher.update(uuid::Uuid::new_v4().as_bytes());
    let digest = hasher.finalize();
    format!(
        "{}.{}.{}.{}",
        VIRTUAL_SUBNET[0],
        VIRTUAL_SUBNET[1],
        VIRTUAL_SUBNET[2],
        2 + (digest[0] as u16 % 253) as u8
    )
}

fn random_port(range: std::ops::Range<u16>) -> u16 {
    let span = (range.end - range.start) as u32;
    let seed = uuid::Uuid::new_v4().as_u128() as u32;
    range.start + (seed % span) as u16
}

fn sanitize_nickname(value: &str) -> String {
    let trimmed: String = value
        .chars()
        .filter(|ch| !ch.is_control())
        .take(32)
        .collect();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        "RaySpeak".to_string()
    } else {
        trimmed.to_string()
    }
}

#[tauri::command]
pub async fn share_network_start(
    app: AppHandle,
    state: State<'_, Arc<ShareManager>>,
    channel_id: u64,
    nickname: String,
    pin: Option<String>,
    node: Option<String>,
    peers: Option<Vec<String>>,
    options: Option<easytier::NetworkOptions>,
) -> Result<NetworkInfo, String> {
    let options = options.unwrap_or_default();
    let _start = state.start_guard.lock().await;
    if state.network.lock().unwrap().is_some() {
        return Err("屏幕共享网络已在运行".into());
    }
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let cancelled = || state.generation.load(Ordering::SeqCst) != generation;

    let nickname = sanitize_nickname(&nickname);
    let (network_name, room_id, secret) = derive_room(channel_id, pin.as_deref().unwrap_or(""));
    let peer_id = random_peer_id();
    let ip = random_ip(&peer_id);
    let signal_port = SIGNAL_PORT;

    state.emit_status("starting", None, None);

    // 启动阶段不再联网测速（页面里由用户手动测速并提供可达节点顺序），
    // 这样点击「开启共享网络」会立即进入 UAC，而不是先等几秒 TCP 探测。
    let peers = nodes::collect_peers(node.as_deref(), peers.as_deref().unwrap_or(&[]), options.multi_relay());
    if peers.is_empty() {
        state.emit_status("offline", None, Some("没有可用的中继节点".into()));
        return Err("没有可用的中继节点".into());
    }
    if cancelled() {
        state.emit_status("offline", None, Some("屏幕共享网络启动已取消".into()));
        return Err("屏幕共享网络启动已取消".into());
    }
    let primary = peers[0].clone();
    let (node_id, node_label) = nodes::describe_uri(&primary);
    // 启动不再测速，延迟由前端用上次手动测速的结果显示。
    let node_uri = primary;
    let node_latency_ms = None;

    let network = match Network::start(
        app.clone(),
        &network_name,
        &secret,
        &peer_id,
        &ip,
        &peers,
        &options,
    )
    .await
    {
        Ok(network) => network,
        Err(error) => {
            state.emit_status("offline", None, Some(error.clone()));
            return Err(error);
        }
    };
    if cancelled() {
        network.stop().await;
        state.emit_status("offline", None, Some("屏幕共享网络启动已取消".into()));
        return Err("屏幕共享网络启动已取消".into());
    }

    let stun = match StunServer::start(&ip).await {
        Ok(server) => server,
        Err(error) => {
            let _ = network.stop().await;
            state.emit_status("offline", None, Some(error.clone()));
            return Err(error);
        }
    };
    if cancelled() {
        stun.stop().await;
        network.stop().await;
        state.emit_status("offline", None, Some("屏幕共享网络启动已取消".into()));
        return Err("屏幕共享网络启动已取消".into());
    }

    let info = NetworkInfo {
        room_id,
        network: network_name,
        peer_id: peer_id.clone(),
        nickname: nickname.clone(),
        ip: ip.clone(),
        signal_port,
        node_id,
        node_label,
        node_uri,
        node_latency_ms,
    };

    let mesh = match SignalMesh::start(
        app.clone(),
        network.cli_path(),
        network.rpc_port(),
        info.clone(),
    )
    .await
    {
        Ok(mesh) => mesh,
        Err(error) => {
            stun.stop().await;
            network.stop().await;
            state.emit_status("offline", None, Some(error.clone()));
            return Err(error);
        }
    };
    if cancelled() {
        mesh.stop().await;
        stun.stop().await;
        network.stop().await;
        state.emit_status("offline", None, Some("屏幕共享网络启动已取消".into()));
        return Err("屏幕共享网络启动已取消".into());
    }

    *state.network.lock().unwrap() = Some(network);
    *state.stun.lock().unwrap() = Some(stun);
    *state.signal.lock().unwrap() = Some(mesh);
    *state.info.lock().unwrap() = Some(info.clone());
    state.emit_status("online", Some(info.clone()), None);
    Ok(info)
}

#[tauri::command]
pub async fn share_network_stop(state: State<'_, Arc<ShareManager>>) -> Result<(), String> {
    stop_everything(state.inner()).await;
    Ok(())
}

async fn stop_everything(state: &ShareManager) {
    // 先作废进行中的启动/采集，再关闭已经建立的部分。
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
    let mesh = state.signal.lock().unwrap().take();
    let stun = state.stun.lock().unwrap().take();
    let capture = state.capture.lock().unwrap().take();
    let network = state.network.lock().unwrap().take();
    *state.info.lock().unwrap() = None;

    if let Some(mesh) = mesh {
        mesh.stop().await;
    }
    if let Some(stun) = stun {
        stun.stop().await;
    }
    if let Some(capture) = capture {
        capture.stop().await;
    }
    if let Some(network) = network {
        network.stop().await;
    }
    state.emit_status("offline", None, None);
}

#[tauri::command]
pub fn share_network_status(state: State<'_, Arc<ShareManager>>) -> Option<NetworkStatus> {
    let info = state.info.lock().unwrap().clone();
    info.map(|info| NetworkStatus {
        phase: "online".into(),
        info: Some(info),
        error: None,
    })
}

/// 共享前测速：并发探测所有内置公共节点，返回可达性与延迟。
#[tauri::command]
pub fn share_node_options() -> Vec<nodes::NodeOption> {
    nodes::catalog_options()
}

#[tauri::command]
pub async fn share_probe_nodes(custom: Option<Vec<String>>) -> Vec<nodes::NodeProbe> {
    nodes::probe_catalog(custom.as_deref().unwrap_or(&[])).await
}

#[tauri::command]
pub async fn share_probe_node(target: String) -> Option<nodes::NodeProbe> {
    nodes::probe_target(&target).await
}

/// 最近已脱敏的 EasyTier 日志，供页面诊断面板展示。
#[tauri::command]
pub fn share_network_logs(state: State<'_, Arc<ShareManager>>) -> Vec<String> {
    state
        .network
        .lock()
        .unwrap()
        .as_ref()
        .map(|network| network.recent_logs())
        .unwrap_or_default()
}

#[tauri::command]
pub fn share_peers(state: State<'_, Arc<ShareManager>>) -> Vec<SharePeer> {
    state
        .signal
        .lock()
        .unwrap()
        .as_ref()
        .map(|mesh| mesh.peers_snapshot())
        .unwrap_or_default()
}

#[tauri::command]
pub async fn share_send_signal(
    state: State<'_, Arc<ShareManager>>,
    to: String,
    message: String,
) -> Result<(), String> {
    let mesh = {
        let guard = state.signal.lock().unwrap();
        guard.as_ref().map(|mesh| mesh.clone())
    };
    match mesh {
        Some(mesh) => mesh.send(&to, &message).await,
        None => Err("屏幕共享网络尚未连接".into()),
    }
}

#[tauri::command]
pub async fn share_connect_peer(
    state: State<'_, Arc<ShareManager>>,
    ip: String,
) -> Result<(), String> {
    let mesh = {
        let guard = state.signal.lock().unwrap();
        guard.as_ref().map(|mesh| mesh.clone())
    };
    match mesh {
        Some(mesh) => mesh.connect_ip(&ip).await,
        None => Err("屏幕共享网络尚未连接".into()),
    }
}

/// Local STUN keeps Chromium's ICE socket on the EasyTier interface. Without it
/// host candidates are mDNS-obfuscated and the peer cannot route to them.
#[tauri::command]
pub fn share_ice_servers(state: State<'_, Arc<ShareManager>>) -> Vec<String> {
    state
        .stun
        .lock()
        .unwrap()
        .as_ref()
        .map(|stun| vec![stun.url()])
        .unwrap_or_default()
}

#[tauri::command]
pub async fn share_capture_sources() -> Result<Vec<capture::CaptureSource>, String> {
    capture::sources()
}

#[tauri::command]
pub async fn share_capture_start(
    state: State<'_, Arc<ShareManager>>,
    source_id: String,
    resolution: u32,
    frame_rate: u32,
) -> Result<capture::CaptureInfo, String> {
    let _start = state.capture_guard.lock().await;
    if state.capture.lock().unwrap().is_some() {
        return Err("已有进行中的屏幕采集".into());
    }
    let generation = state.capture_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let app = state.app.clone();
    let session =
        capture::CaptureSession::start(Some(app), &source_id, resolution, frame_rate).await?;
    if state.capture_generation.load(Ordering::SeqCst) != generation {
        session.stop().await;
        return Err("屏幕采集启动已取消".into());
    }
    let info = session.info();
    *state.capture.lock().unwrap() = Some(Arc::new(session));
    Ok(info)
}

#[tauri::command]
pub async fn share_capture_frame(
    state: State<'_, Arc<ShareManager>>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let session = {
        let guard = state.capture.lock().unwrap();
        match guard.as_ref() {
            Some(session) if session.id() == id => session.clone(),
            _ => return Err("屏幕采集已停止".into()),
        }
    };
    let bytes = session.take_frame().await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn share_capture_stats(
    state: State<'_, Arc<ShareManager>>,
    id: String,
) -> Option<capture::CaptureStats> {
    let session = state.capture.lock().unwrap().clone()?;
    (session.id() == id).then(|| session.stats())
}

#[tauri::command]
pub async fn share_audio_start(
    state: State<'_, Arc<ShareManager>>,
) -> Result<audio::AudioInfo, String> {
    if state.audio.lock().unwrap().is_some() {
        return Err("系统音频已在采集".into());
    }
    let session = audio::AudioSession::start().await?;
    let info = session.info();
    if state.audio.lock().unwrap().is_some() {
        session.stop().await;
        return Err("系统音频已在采集".into());
    }
    *state.audio.lock().unwrap() = Some(Arc::new(session));
    Ok(info)
}

#[tauri::command]
pub fn share_audio_read(
    state: State<'_, Arc<ShareManager>>,
    max_frames: u32,
) -> Result<tauri::ipc::Response, String> {
    let session = state
        .audio
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "系统音频未启动".to_string())?;
    // 前端按 ~20ms 拉取；上限 200ms，避免一次分配过大。
    let frames = (max_frames as usize).clamp(1, 9_600);
    Ok(tauri::ipc::Response::new(session.read(frames)))
}

#[tauri::command]
pub async fn share_audio_stop(state: State<'_, Arc<ShareManager>>) -> Result<(), String> {
    let session = state.audio.lock().unwrap().take();
    if let Some(session) = session {
        session.stop().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn share_capture_stop(
    state: State<'_, Arc<ShareManager>>,
    id: String,
) -> Result<(), String> {
    state.capture_generation.fetch_add(1, Ordering::SeqCst);
    let session = {
        let mut guard = state.capture.lock().unwrap();
        match guard.as_ref() {
            Some(session) if session.id() == id => guard.take(),
            _ => None,
        }
    };
    if let Some(session) = session {
        session.stop().await;
    }
    Ok(())
}

pub fn setup(app: &tauri::App) {
    let share = Arc::new(ShareManager::new(app.handle().clone()));
    app.manage(share);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_derivation_is_stable_and_channel_scoped() {
        let a = derive_room(7, "");
        let b = derive_room(7, "");
        let c = derive_room(8, "");
        assert_eq!(a.0, b.0);
        assert_eq!(a.2, b.2);
        assert_ne!(a.0, c.0);
        assert!(a.0.starts_with("rayspeak-"));
        assert_eq!(a.1.len(), 32);
    }

    #[test]
    fn pin_changes_the_network_secret() {
        assert_ne!(derive_room(3, "").2, derive_room(3, "1234").2);
        assert_eq!(derive_room(3, "").0, derive_room(3, "1234").0);
    }

    #[test]
    fn virtual_ip_stays_inside_the_subnet() {
        for _ in 0..64 {
            let ip = random_ip(&random_peer_id());
            let parts: Vec<u8> = ip.split('.').map(|p| p.parse().unwrap()).collect();
            assert_eq!(&parts[..3], &VIRTUAL_SUBNET);
            assert!(parts[3] >= 2);
        }
    }

    #[test]
    fn nicknames_are_trimmed_and_bounded() {
        assert_eq!(sanitize_nickname("   "), "RaySpeak");
        assert_eq!(sanitize_nickname("  Alice\n "), "Alice");
        assert_eq!(sanitize_nickname(&"x".repeat(64)).len(), 32);
    }
}

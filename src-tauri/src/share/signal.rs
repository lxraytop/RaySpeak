// 虚拟网内的信令 mesh。
//
// 每个 RaySpeak 客户端在 EasyTier 虚拟 IP 上监听 TCP 信令端口，用 EasyTier 的
// 节点列表（easytier-cli peer -o json）发现同房间成员，再两两建立连接交换
// WebRTC 的 SDP / ICE。信令流量只经过 EasyTier 虚拟网，不经过 TeamSpeak 服务器，
// 也不需要任何第三方信令服务。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Mutex as AsyncMutex;

use super::{NetworkInfo, SharePeer};

const DISCOVERY_TICK: Duration = Duration::from_secs(3);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone)]
struct PeerState {
    peer_id: String,
    nickname: String,
    ip: String,
    connected: bool,
    latency_ms: Option<f64>,
}

type Writer = Arc<AsyncMutex<OwnedWriteHalf>>;

struct Inner {
    app: AppHandle,
    info: NetworkInfo,
    conns: Mutex<HashMap<String, Writer>>,
    peers: Mutex<HashMap<String, PeerState>>,
    dialing: Mutex<HashSet<String>>,
    tasks: Mutex<Vec<tokio::task::JoinHandle<()>>>,
    running: AtomicBool,
}

impl Inner {
    fn emit_peers(&self) {
        let mut list: Vec<SharePeer> = self
            .peers
            .lock()
            .unwrap()
            .values()
            .map(|peer| SharePeer {
                peer_id: peer.peer_id.clone(),
                nickname: peer.nickname.clone(),
                ip: peer.ip.clone(),
                connected: peer.connected,
                latency_ms: peer.latency_ms,
            })
            .collect();
        list.sort_by(|a, b| a.ip.cmp(&b.ip));
        let _ = self.app.emit("ts://share-peers", list);
    }

    fn mark_connected(&self, peer_id: &str, nickname: &str, ip: &str) {
        let mut peers = self.peers.lock().unwrap();
        let entry = peers
            .entry(peer_id.to_string())
            .or_insert_with(|| PeerState {
                peer_id: peer_id.to_string(),
                nickname: nickname.to_string(),
                ip: ip.to_string(),
                connected: false,
                latency_ms: None,
            });
        entry.connected = true;
        if !nickname.is_empty() {
            entry.nickname = nickname.to_string();
        }
        if !ip.is_empty() {
            entry.ip = ip.to_string();
        }
    }

    fn mark_disconnected(&self, peer_id: &str) {
        if let Some(peer) = self.peers.lock().unwrap().get_mut(peer_id) {
            peer.connected = false;
        }
    }
}

#[derive(Clone)]
pub struct SignalMesh {
    inner: Arc<Inner>,
}

impl SignalMesh {
    pub async fn start(
        app: AppHandle,
        cli: std::path::PathBuf,
        rpc_port: u16,
        info: NetworkInfo,
    ) -> Result<Self, String> {
        let listener = bind_with_retry(&info.ip, info.signal_port).await?;
        let mesh = Self {
            inner: Arc::new(Inner {
                app,
                info,
                conns: Mutex::new(HashMap::new()),
                peers: Mutex::new(HashMap::new()),
                dialing: Mutex::new(HashSet::new()),
                tasks: Mutex::new(Vec::new()),
                running: AtomicBool::new(true),
            }),
        };

        let accept = tokio::spawn(accept_loop(mesh.inner.clone(), listener));
        let discovery = tokio::spawn(discovery_loop(mesh.inner.clone(), cli, rpc_port));
        mesh.inner.tasks.lock().unwrap().extend([accept, discovery]);
        mesh.inner.emit_peers();
        Ok(mesh)
    }

    pub fn peers_snapshot(&self) -> Vec<SharePeer> {
        let mut list: Vec<SharePeer> = self
            .inner
            .peers
            .lock()
            .unwrap()
            .values()
            .map(|peer| SharePeer {
                peer_id: peer.peer_id.clone(),
                nickname: peer.nickname.clone(),
                ip: peer.ip.clone(),
                connected: peer.connected,
                latency_ms: peer.latency_ms,
            })
            .collect();
        list.sort_by(|a, b| a.ip.cmp(&b.ip));
        list
    }

    pub async fn send(&self, to: &str, message: &str) -> Result<(), String> {
        let targets: Vec<Writer> = {
            let conns = self.inner.conns.lock().unwrap();
            if to == "*" {
                conns.values().cloned().collect()
            } else {
                match conns.get(to) {
                    Some(writer) => vec![writer.clone()],
                    None => return Err("对方不在线".into()),
                }
            }
        };
        if targets.is_empty() {
            return Err("房间内还没有其他成员".into());
        }
        let payload = json!({
            "type": "signal",
            "from": self.inner.info.peer_id,
            "to": to,
            "message": message,
        });
        for writer in targets {
            write_json(&writer, &payload).await?;
        }
        Ok(())
    }

    /// Manual fallback when EasyTier's peer list is unavailable: dial a
    /// teammate's virtual IP directly. The room handshake still applies.
    pub async fn connect_ip(&self, ip: &str) -> Result<(), String> {
        let ip = ip.trim();
        if ip.parse::<std::net::Ipv4Addr>().is_err() {
            return Err("请输入有效的虚拟 IP".into());
        }
        let stream = tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect((ip, self.inner.info.signal_port)),
        )
        .await
        .map_err(|_| "连接虚拟 IP 超时".to_string())?
        .map_err(|error| format!("连接虚拟 IP 失败: {error}"))?;
        let inner = self.inner.clone();
        let remote_ip = ip.to_string();
        tokio::spawn(async move {
            handle_conn(inner, stream, false, remote_ip).await;
        });
        Ok(())
    }

    pub async fn stop(&self) {
        self.inner.running.store(false, Ordering::Release);
        for task in self.inner.tasks.lock().unwrap().drain(..) {
            task.abort();
        }
        self.inner.conns.lock().unwrap().clear();
        self.inner.peers.lock().unwrap().clear();
        self.inner.dialing.lock().unwrap().clear();
        let _ = self.inner.app.emit("ts://share-peers", Vec::<SharePeer>::new());
    }
}

async fn bind_with_retry(ip: &str, port: u16) -> Result<TcpListener, String> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        match TcpListener::bind((ip, port)).await {
            Ok(listener) => return Ok(listener),
            Err(error) => {
                if tokio::time::Instant::now() >= deadline {
                    return Err(format!("无法在虚拟网卡上监听信令端口 {port}: {error}"));
                }
                tokio::time::sleep(Duration::from_millis(300)).await;
            }
        }
    }
}

async fn accept_loop(inner: Arc<Inner>, listener: TcpListener) {
    while inner.running.load(Ordering::Acquire) {
        match listener.accept().await {
            Ok((stream, _)) => {
                let inner = inner.clone();
                let remote_ip = stream
                    .peer_addr()
                    .map(|addr| addr.ip().to_string())
                    .unwrap_or_default();
                tokio::spawn(async move {
                    handle_conn(inner, stream, false, remote_ip).await;
                });
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
        }
    }
}

async fn write_json(writer: &Writer, value: &Value) -> Result<(), String> {
    let mut guard = writer.lock().await;
    let mut line = value.to_string();
    line.push('\n');
    guard
        .write_all(line.as_bytes())
        .await
        .map_err(|error| error.to_string())?;
    guard.flush().await.map_err(|error| error.to_string())
}

async fn handle_conn(
    inner: Arc<Inner>,
    stream: TcpStream,
    outbound: bool,
    remote_ip_hint: String,
) {
    let (read_half, write_half) = stream.into_split();
    let writer: Writer = Arc::new(AsyncMutex::new(write_half));
    let hello = json!({
        "type": "hello",
        "peer": inner.info.peer_id,
        "name": inner.info.nickname,
        "room": inner.info.room_id,
    });
    if write_json(&writer, &hello).await.is_err() {
        return;
    }

    let mut lines = BufReader::new(read_half).lines();
    let Some((remote_peer, remote_name)) = read_hello(&mut lines, &inner).await else {
        return;
    };
    if remote_peer == inner.info.peer_id {
        return;
    }
    let mut remote_ip = peer_ip(&inner, &remote_peer);
    if remote_ip.is_empty() {
        remote_ip = remote_ip_hint;
    }
    // Both sides may dial at once. Converge on the socket initiated by the
    // lexicographically smaller peer id so a race cannot close both links.
    let preferred = (inner.info.peer_id < remote_peer) == outbound;
    let replaced = {
        let mut conns = inner.conns.lock().unwrap();
        let existing = conns.get(&remote_peer).cloned();
        if existing.is_some() && !preferred {
            return;
        }
        conns.insert(remote_peer.clone(), writer.clone());
        existing
    };
    if let Some(replaced) = replaced {
        drop(replaced);
    }
    inner.mark_connected(&remote_peer, &remote_name, &remote_ip);
    inner.emit_peers();

    let my_id = inner.info.peer_id.clone();
    while let Ok(Some(line)) = lines.next_line().await {
        if !inner.running.load(Ordering::Acquire) {
            break;
        }
        let Ok(value) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if value.get("type").and_then(Value::as_str) != Some("signal") {
            continue;
        }
        let to = value.get("to").and_then(Value::as_str).unwrap_or("*");
        if to != "*" && to != my_id {
            continue;
        }
        // 发送者身份以握手中的 peer id 为准，不信任消息里自报的 from。
        let from = remote_peer.clone();
        let message = value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let _ = inner.app.emit(
            "ts://share-signal",
            json!({ "from": from, "message": message }),
        );
    }

    let removed = {
        let mut conns = inner.conns.lock().unwrap();
        let current_is_ours = conns
            .get(&remote_peer)
            .map(|current| Arc::ptr_eq(current, &writer))
            .unwrap_or(false);
        if current_is_ours {
            conns.remove(&remote_peer);
        }
        current_is_ours
    };
    inner.dialing.lock().unwrap().remove(&remote_peer);
    if removed {
        inner.mark_disconnected(&remote_peer);
        inner.emit_peers();
    }
}

fn peer_ip(inner: &Inner, peer_id: &str) -> String {
    inner
        .peers
        .lock()
        .unwrap()
        .get(peer_id)
        .map(|peer| peer.ip.clone())
        .unwrap_or_default()
}

async fn read_hello(
    lines: &mut tokio::io::Lines<BufReader<OwnedReadHalf>>,
    inner: &Arc<Inner>,
) -> Option<(String, String)> {
    let line = tokio::time::timeout(HANDSHAKE_TIMEOUT, lines.next_line())
        .await
        .ok()?
        .ok()??;
    let value: Value = serde_json::from_str(&line).ok()?;
    if value.get("type").and_then(Value::as_str) != Some("hello") {
        return None;
    }
    if value.get("room").and_then(Value::as_str) != Some(inner.info.room_id.as_str()) {
        return None;
    }
    let peer = value.get("peer").and_then(Value::as_str)?.to_string();
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("RaySpeak")
        .to_string();
    Some((peer, name))
}

#[derive(Deserialize)]
struct CliPeer {
    #[serde(default)]
    ipv4: String,
    #[serde(default)]
    hostname: String,
    #[serde(default)]
    cost: String,
    #[serde(default)]
    lat_ms: String,
}

async fn discovery_loop(inner: Arc<Inner>, cli: std::path::PathBuf, rpc_port: u16) {
    while inner.running.load(Ordering::Acquire) {
        let peers = query_peers(&cli, rpc_port).await;
        if let Some(peers) = peers {
            apply_discovery(&inner, peers);
            inner.emit_peers();
            dial_missing(&inner).await;
        }
        tokio::time::sleep(DISCOVERY_TICK).await;
    }
}

async fn query_peers(cli: &std::path::PathBuf, rpc_port: u16) -> Option<Vec<CliPeer>> {
    let mut command = tokio::process::Command::new(cli);
    command
        .arg("-p")
        .arg(format!("127.0.0.1:{rpc_port}"))
        .arg("-o")
        .arg("json")
        .arg("peer")
        .kill_on_drop(true);
    // release 构建没有控制台；不设置 CREATE_NO_WINDOW 时，每 3 秒一次的子进程
    // 都会弹出一个终端窗口。
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = tokio::time::timeout(Duration::from_secs(6), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    serde_json::from_slice(&output.stdout).ok()
}

fn apply_discovery(inner: &Arc<Inner>, list: Vec<CliPeer>) {
    let mut seen = HashSet::new();
    let mut updates: Vec<(String, String, Option<f64>)> = Vec::new();
    for item in list {
        if item.cost == "Local" || !item.hostname.starts_with("rs-") {
            continue;
        }
        let peer_id = item.hostname.trim_start_matches("rs-").to_string();
        if peer_id.is_empty() || peer_id == inner.info.peer_id || item.ipv4.is_empty() {
            continue;
        }
        let latency = item.lat_ms.trim().parse::<f64>().ok();
        seen.insert(peer_id.clone());
        updates.push((peer_id, item.ipv4, latency));
    }

    {
        let mut peers = inner.peers.lock().unwrap();
        let keep: HashSet<String> = peers
            .iter()
            .filter(|(_, peer)| peer.connected)
            .map(|(id, _)| id.clone())
            .collect();
        peers.retain(|id, _| seen.contains(id) || keep.contains(id));
        for (peer_id, ip, latency) in updates {
            let entry = peers.entry(peer_id.clone()).or_insert_with(|| PeerState {
                peer_id: peer_id.clone(),
                nickname: format!("rs-{peer_id}"),
                ip: ip.clone(),
                connected: false,
                latency_ms: latency,
            });
            entry.ip = ip;
            entry.latency_ms = latency;
        }
    }
}

async fn dial_missing(inner: &Arc<Inner>) {
    let targets: Vec<(String, String)> = {
        let peers = inner.peers.lock().unwrap();
        let conns = inner.conns.lock().unwrap();
        let mut dialing = inner.dialing.lock().unwrap();
        let mut targets = Vec::new();
        for (peer_id, peer) in peers.iter() {
            if peer.connected || conns.contains_key(peer_id) || peer.ip.is_empty() {
                continue;
            }
            if dialing.insert(peer_id.clone()) {
                targets.push((peer_id.clone(), peer.ip.clone()));
            }
        }
        targets
    };

    for (peer_id, ip) in targets {
        let inner = inner.clone();
        tokio::spawn(async move {
            let port = inner.info.signal_port;
            match tokio::time::timeout(Duration::from_secs(5), TcpStream::connect((ip.as_str(), port)))
                .await
            {
                Ok(Ok(stream)) => {
                    handle_conn(inner.clone(), stream, true, ip.clone()).await;
                }
                _ => {}
            }
            inner.dialing.lock().unwrap().remove(&peer_id);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_easytier_cli_peer_json() {
        let raw = r#"[
          {"cidr":"","ipv4":"","hostname":"rs-deadbeef","cost":"Local","lat_ms":"-","loss_rate":"-","rx_bytes":"-","tx_bytes":"-","tunnel_proto":"-","nat_type":"PortRestricted","id":"1","version":"2.6.4"},
          {"cidr":"10.126.126.7/24","ipv4":"10.126.126.7","hostname":"rs-0a1b2c3d","cost":"p2p","lat_ms":"18.20","loss_rate":"0.0%","rx_bytes":"1 kB","tx_bytes":"1 kB","tunnel_proto":"tcp","nat_type":"PortRestricted","id":"2","version":"2.6.4"},
          {"cidr":"","ipv4":"","hostname":"PublicServer_x_server","cost":"p2p","lat_ms":"580.90","loss_rate":"0.0%","rx_bytes":"1 kB","tx_bytes":"1 kB","tunnel_proto":"tcp","nat_type":"Unknown","id":"3","version":"2.7.0"}
        ]"#;
        let peers: Vec<CliPeer> = serde_json::from_str(raw).unwrap();
        assert_eq!(peers.len(), 3);
        assert_eq!(peers[1].hostname, "rs-0a1b2c3d");
        assert_eq!(peers[1].ipv4, "10.126.126.7");
        assert_eq!(peers[1].lat_ms, "18.20");
        assert_eq!(peers[2].cost, "p2p");
    }
}

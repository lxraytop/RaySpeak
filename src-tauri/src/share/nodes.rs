// 公共中继节点池与测速。
//
// EasyTier 的公共节点是社区维护的，经常被攻击或下线（官方 public.easytier.top
// 早已不可用）。所以不写死一条，而是内置一组候选，共享前并发测 TCP 连接延迟，
// 按延迟排序：第一条作为本次房间的主节点，其余可达节点作为发现兜底。
// 两端只要有一条节点交集就能互相发现；邀请码会带上主节点，让好友优先走同一条。

use std::time::{Duration, Instant};

use serde::Serialize;

const PROBE_TIMEOUT: Duration = Duration::from_millis(1200);
const PROBE_ATTEMPTS: usize = 3;
const MAX_PEERS: usize = 4;
const MAX_CUSTOM_NODES: usize = 8;

/// (id, 展示名, URI)。顺序只是展示顺序，实际以测速结果为准。
pub const CATALOG: &[(&str, &str, &str)] = &[
    ("sz-tencent", "47.108.52.1 · 腾讯云", "tcp://47.108.52.1:11012"),
    ("us-225284", "us01.225284.xyz · 美国", "udp://us01.225284.xyz:11010"),
    ("cd-tencent", "47.92.208.217 · 腾讯云", "tcp://47.92.208.217:11010"),
    ("gbc", "et.gbc.moe", "tcp://et.gbc.moe:11011"),
    ("hz-aliyun", "47.103.35.100 · 阿里云", "tcp://47.103.35.100:11010"),
    ("sh-vomiku", "sh.vomiku.com", "tcp://sh.vomiku.com:7910"),
    ("us-96", "96.9.229.212", "tcp://96.9.229.212:11010"),
    ("hk-225284", "225284.xyz · 香港", "tcp://225284.xyz:11010"),
    ("hk-clickor", "et-hk.clickor.click · 香港", "tcp://et-hk.clickor.click:11010"),
    ("official-cn", "public.easytier.cn · 官方", "tcp://public.easytier.cn:11010"),
    ("official-top", "public.easytier.top · 官方", "tcp://public.easytier.top:11010"),
    ("sh-993555", "sh.993555.xyz", "tcp://sh.993555.xyz:11010"),
    ("bj-629957", "turn.bj.629957.xyz", "tcp://turn.bj.629957.xyz:11010"),
    ("sh-suhoan", "et.sh.suhoan.cn", "tcp://et.sh.suhoan.cn:11010"),
    // 以下来自 upt.qicwken.cn 的公共节点监控（只收录带真实地址的条目）。
    ("xm-weiai", "easytier.weiai.org.cn · 厦门电信", "tcp://easytier.weiai.org.cn:11010"),
    ("cq-mobile", "183.230.36.171 · 重庆移动专线", "tcp://183.230.36.171:11010"),
    ("sd-bgp", "et.basd1.de · 枣庄BGP", "tcp://et.basd1.de:11010"),
    ("sy-yqst", "mc.yqst.top · 邵阳电信", "tcp://mc.yqst.top:11010"),
    ("us-0612", "et.0612.fun · 美国", "tcp://et.0612.fun:11010"),
    ("edgeone-kou", "et.chinokou.cn · EdgeOne", "wss://et.chinokou.cn"),
];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeProbe {
    pub id: String,
    pub label: String,
    pub uri: String,
    pub protocol: String,
    pub latency_ms: Option<f64>,
    /// 多次握手延迟的最大差值；越小越稳定，用于画质建议
    pub jitter_ms: Option<f64>,
    pub reachable: bool,
}

/// 内置节点目录：不带任何测速结果，页面首次打开即可展示和选择。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NodeOption {
    pub id: String,
    pub label: String,
    pub uri: String,
    pub protocol: String,
}

pub fn catalog_options() -> Vec<NodeOption> {
    CATALOG
        .iter()
        .map(|(id, label, uri)| NodeOption {
            id: (*id).to_string(),
            label: (*label).to_string(),
            uri: (*uri).to_string(),
            protocol: uri.split("://").next().unwrap_or("tcp").to_string(),
        })
        .collect()
}

pub fn catalog_entry(id: &str) -> Option<(&'static str, &'static str, &'static str)> {
    CATALOG
        .iter()
        .find(|(node_id, _, _)| *node_id == id)
        .copied()
}

/// 自定义节点允许的协议与 `parse_uri` 保持一致；启动前必须再校验一次。
pub fn valid_uri(uri: &str) -> bool {
    parse_uri(uri.trim()).is_some()
}

fn host_label(uri: &str) -> String {
    parse_uri(uri)
        .map(|(host, port)| format!("{host}:{port}"))
        .unwrap_or_else(|| uri.to_string())
}

/// 前端可以传内置 id，也可以直接传 `tcp://host:port` 形式的自定义节点。
pub fn resolve_node(node: &str) -> Option<(String, String, String)> {
    if let Some((id, label, uri)) = catalog_entry(node) {
        return Some((id.to_string(), label.to_string(), uri.to_string()));
    }
    if valid_uri(node) {
        let uri = node.trim().to_string();
        return Some((String::new(), host_label(&uri), uri));
    }
    None
}

/// 节点列表里的 URI 反查展示信息（启动后不再测速，主节点信息靠它补齐）。
pub fn describe_uri(uri: &str) -> (String, String) {
    if let Some((id, label, _)) = CATALOG.iter().find(|(_, _, item)| *item == uri) {
        return ((*id).to_string(), (*label).to_string());
    }
    (String::new(), host_label(uri))
}

/// 解析成可测速的 (host, port)。`ws`/`wss` 节点按 80/443 测 TCP 握手，
/// 路径部分（wss://host/path）不参与探测。
fn parse_uri(uri: &str) -> Option<(String, u16)> {
    let (scheme, rest) = uri.split_once("://")?;
    let default_port = match scheme {
        "tcp" | "udp" => None,
        "ws" => Some(80),
        "wss" => Some(443),
        _ => return None,
    };
    let authority = rest.split('/').next()?;
    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) => (host, port.parse().ok()?),
        None => (authority, default_port?),
    };
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

/// UDP 节点通常也监听同一端口的 TCP，用 TCP 握手测延迟即可；完全不支持 TCP 的
/// 节点会被标记为不可达，但仍保留在目录里供手动选择。多次握手还能看出抖动。
async fn probe_one(id: &str, label: &str, uri: &str) -> NodeProbe {
    let protocol = uri.split("://").next().unwrap_or("tcp").to_string();
    let mut samples: Vec<f64> = Vec::new();
    if let Some((host, port)) = parse_uri(uri) {
        for _ in 0..PROBE_ATTEMPTS {
            let started = Instant::now();
            let attempt = tokio::time::timeout(
                PROBE_TIMEOUT,
                tokio::net::TcpStream::connect((host.as_str(), port)),
            )
            .await;
            if let Ok(Ok(stream)) = attempt {
                drop(stream);
                samples.push(started.elapsed().as_secs_f64() * 1000.0);
            }
        }
    }
    let latency = samples.iter().copied().fold(f64::INFINITY, f64::min);
    let jitter = if samples.len() >= 2 {
        let max = samples.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        Some(max - latency)
    } else {
        None
    };
    NodeProbe {
        id: id.to_string(),
        label: label.to_string(),
        uri: uri.to_string(),
        protocol,
        latency_ms: latency.is_finite().then_some(latency),
        jitter_ms: jitter,
        reachable: latency.is_finite(),
    }
}

/// 并发探测内置目录 + 自定义节点。自定义节点用 URI 本身作为 id，
/// 前端选中后可以直接把 URI 传回启动命令。
pub async fn probe_catalog(custom: &[String]) -> Vec<NodeProbe> {
    let mut tasks = tokio::task::JoinSet::new();
    for (id, label, uri) in CATALOG {
        tasks.spawn(probe_one(id, label, uri));
    }
    let mut seen = std::collections::HashSet::new();
    let mut added = 0usize;
    for item in custom {
        let uri = item.trim();
        if added >= MAX_CUSTOM_NODES {
            break;
        }
        if uri.is_empty() {
            continue;
        }
        if !valid_uri(uri) || !seen.insert(uri.to_string()) {
            continue;
        }
        added += 1;
        let owned = uri.to_string();
        let label = host_label(&owned);
        tasks.spawn(async move { probe_one(&owned, &label, &owned).await });
    }
    let mut list = Vec::with_capacity(CATALOG.len() + custom.len());
    while let Some(result) = tasks.join_next().await {
        if let Ok(probe) = result {
            list.push(probe);
        }
    }
    sort_probes(&mut list);
    list
}

fn sort_probes(list: &mut [NodeProbe]) {
    list.sort_by(|a, b| {
        b.reachable
            .cmp(&a.reachable)
            .then_with(|| a.latency_ms.unwrap_or(f64::MAX).total_cmp(&b.latency_ms.unwrap_or(f64::MAX)))
            .then_with(|| a.label.cmp(&b.label))
    });
}

/// 只测一个节点：内置 id 或自定义 URI 都行。返回值只用于更新该行，
/// 不会触发整个目录的探测。
pub async fn probe_target(target: &str) -> Option<NodeProbe> {
    let (id, label, uri) = resolve_node(target.trim())?;
    Some(probe_one(&id, &label, &uri).await)
}

/// 组装本次房间实际使用的节点列表。启动时不再联网测速：优先节点（内置 id 或
/// 自定义 URI）排第一，其后是前端上次手动测速得到的可达节点。全部无效时按目录
/// 顺序取前三个，交给 EasyTier 自己重试。
pub fn collect_peers(preferred: Option<&str>, peers: &[String], multi_relay: bool) -> Vec<String> {
    fn push_unique(list: &mut Vec<String>, uri: &str) {
        if valid_uri(uri) && !list.iter().any(|item| item == uri.trim()) {
            list.push(uri.trim().to_string());
        }
    }
    let mut list: Vec<String> = Vec::new();
    if let Some(node) = preferred {
        if let Some((_, _, uri)) = resolve_node(node) {
            push_unique(&mut list, &uri);
        }
    }
    for uri in peers {
        push_unique(&mut list, uri);
    }
    if list.is_empty() {
        for (_, _, uri) in CATALOG.iter() {
            push_unique(&mut list, uri);
            if list.len() >= 3 {
                break;
            }
        }
    }
    list.truncate(if multi_relay { MAX_PEERS } else { 1 });
    list
}

#[cfg(test)]
mod tests {
    use super::*;

    fn probe(id: &str, uri: &str, latency: Option<f64>) -> NodeProbe {
        NodeProbe {
            id: id.to_string(),
            label: id.to_string(),
            uri: uri.to_string(),
            protocol: "tcp".into(),
            latency_ms: latency,
            jitter_ms: latency.map(|_| 4.0),
            reachable: latency.is_some(),
        }
    }

    #[test]
    fn catalog_ids_are_unique_and_uris_parse() {
        let mut ids = std::collections::HashSet::new();
        for (id, _, uri) in CATALOG {
            assert!(ids.insert(*id), "duplicate id {id}");
            assert!(parse_uri(uri).is_some(), "bad uri {uri}");
        }
    }

    #[test]
    fn parses_websocket_uris_with_default_ports() {
        assert_eq!(
            parse_uri("wss://et.chinokou.cn"),
            Some(("et.chinokou.cn".to_string(), 443))
        );
        assert_eq!(
            parse_uri("wss://host:8443/path"),
            Some(("host".to_string(), 8443))
        );
        assert_eq!(parse_uri("ws://host/"), Some(("host".to_string(), 80)));
        assert_eq!(parse_uri("https://host"), None);
    }

    #[test]
    fn preferred_node_stays_first_and_invalid_peers_are_dropped() {
        let peers = vec![
            "tcp://a:11010".to_string(),
            "not-a-uri".to_string(),
            "tcp://a:11010".to_string(),
            "udp://b:11010".to_string(),
        ];
        let list = collect_peers(Some("sz-tencent"), &peers, true);
        assert_eq!(list[0], "tcp://47.108.52.1:11012");
        assert!(list.contains(&"tcp://a:11010".to_string()));
        assert!(list.contains(&"udp://b:11010".to_string()));
        assert!(!list.contains(&"not-a-uri".to_string()));
        assert_eq!(
            list.iter().filter(|item| *item == "tcp://a:11010").count(),
            1,
            "重复节点必须去重"
        );
        assert!(list.len() <= MAX_PEERS);
    }

    #[test]
    fn custom_node_uri_is_accepted_as_preference() {
        let list = collect_peers(Some("tcp://relay.example:11010"), &[], false);
        assert_eq!(list, vec!["tcp://relay.example:11010".to_string()]);
        assert_eq!(
            resolve_node("tcp://relay.example:11010").map(|(id, label, _)| (id, label)),
            Some((String::new(), "relay.example:11010".to_string()))
        );
    }

    #[test]
    fn probe_list_is_sorted_by_reachability_then_latency() {
        let mut list = vec![
            probe("dead", "tcp://c:11010", None),
            probe("slow", "tcp://b:11010", Some(80.0)),
            probe("fast", "tcp://a:11010", Some(9.0)),
        ];
        sort_probes(&mut list);
        assert_eq!(list[0].id, "fast");
        assert_eq!(list[1].id, "slow");
        assert_eq!(list[2].id, "dead");
    }

    #[test]
    fn falls_back_to_catalog_when_nothing_is_usable() {
        let list = collect_peers(Some("dead"), &["bad".to_string()], true);
        assert_eq!(list.len(), 3);
        assert_eq!(list[0], CATALOG[0].2);
    }

    #[test]
    fn catalog_options_are_available_without_probing() {
        let options = catalog_options();
        assert_eq!(options.len(), CATALOG.len());
        assert_eq!(options[0].id, CATALOG[0].0);
        assert_eq!(options[0].protocol, "tcp");
    }

    #[test]
    fn probe_target_rejects_unknown_nodes_without_network() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        assert!(runtime.block_on(probe_target("not-a-node")).is_none());
        assert_eq!(
            resolve_node("udp://relay.example:11010").map(|(id, label, _)| (id, label)),
            Some((String::new(), "relay.example:11010".to_string()))
        );
    }
}

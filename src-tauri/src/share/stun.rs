// 本地 STUN：让 Chromium 的 ICE 套接字发现 EasyTier 虚拟网卡地址。
//
// WebView2 没有摄像头/麦克风授权时，Chromium 会把 host candidate 混淆成
// mDNS `.local`，对端无法解析。把 STUN 绑定在虚拟 IP 上，Chromium 用它做
// srflx 探测时就会得到虚拟网地址，WebRTC 才能真正走 EasyTier。
// 这里只应答来自虚拟网卡自身地址的 Binding Request，不转发任何媒体。

use std::net::Ipv4Addr;
use std::time::Duration;

use tokio::net::UdpSocket;

pub struct StunServer {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

impl StunServer {
    pub async fn start(ip: &str) -> Result<Self, String> {
        let socket = std::net::UdpSocket::bind((ip, 0)).map_err(|error| error.to_string())?;
        socket
            .set_nonblocking(true)
            .map_err(|error| error.to_string())?;
        let local = socket.local_addr().map_err(|error| error.to_string())?;
        let local_ip: Ipv4Addr = ip
            .parse()
            .map_err(|_| "虚拟网卡地址不是 IPv4".to_string())?;
        let socket = UdpSocket::from_std(socket).map_err(|error| error.to_string())?;

        let task = tokio::spawn(async move {
            let mut buffer = [0u8; 2048];
            loop {
                let Ok((length, source)) = socket.recv_from(&mut buffer).await else {
                    break;
                };
                if let Some(reply) = binding_response(&buffer[..length], source, local_ip) {
                    let _ = socket.send_to(&reply, source).await;
                }
            }
        });

        Ok(Self {
            url: format!("stun:{ip}:{}", local.port()),
            task,
        })
    }

    pub fn url(&self) -> String {
        self.url.clone()
    }

    pub async fn stop(self) {
        self.task.abort();
        let _ = tokio::time::timeout(Duration::from_millis(200), self.task).await;
    }
}

fn binding_response(request: &[u8], source: std::net::SocketAddr, local_ip: Ipv4Addr) -> Option<[u8; 32]> {
    let std::net::SocketAddr::V4(source) = source else {
        return None;
    };
    if *source.ip() != local_ip
        || request.len() < 20
        || request.len() > 2048
        || request[0..2] != [0, 1]
        || request[4..8] != [0x21, 0x12, 0xa4, 0x42]
    {
        return None;
    }
    let length = u16::from_be_bytes([request[2], request[3]]) as usize;
    if length % 4 != 0 || length + 20 != request.len() {
        return None;
    }
    let mut response = [0u8; 32];
    response[0..4].copy_from_slice(&[1, 1, 0, 12]);
    response[4..20].copy_from_slice(&request[4..20]);
    response[20..26].copy_from_slice(&[0, 0x20, 0, 8, 0, 1]);
    response[26..28].copy_from_slice(&(source.port() ^ 0x2112).to_be_bytes());
    for (index, byte) in source.ip().octets().iter().enumerate() {
        response[28 + index] = byte ^ request[4 + index];
    }
    Some(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> [u8; 20] {
        let mut request = [0u8; 20];
        request[1] = 1;
        request[4..8].copy_from_slice(&[0x21, 0x12, 0xa4, 0x42]);
        request[8..20].fill(7);
        request
    }

    #[test]
    fn maps_source_address_and_keeps_transaction() {
        let ip = Ipv4Addr::new(10, 126, 126, 42);
        let request = request();
        let response = binding_response(&request, (ip, 52341).into(), ip).unwrap();
        assert_eq!(&response[4..20], &request[4..20]);
        assert_eq!(
            u16::from_be_bytes([response[26], response[27]]) ^ 0x2112,
            52341
        );
        let decoded: Vec<u8> = (0..4).map(|index| response[28 + index] ^ request[4 + index]).collect();
        assert_eq!(decoded, ip.octets());
    }

    #[test]
    fn ignores_foreign_sources_and_truncated_requests() {
        let ip = Ipv4Addr::new(10, 126, 126, 42);
        let request = request();
        assert!(binding_response(&request, (Ipv4Addr::new(10, 126, 126, 9), 5000).into(), ip).is_none());
        for length in 0..20 {
            assert!(binding_response(&request[..length], (ip, 5000).into(), ip).is_none());
        }
    }
}

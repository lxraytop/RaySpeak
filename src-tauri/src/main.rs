#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 现场排障入口：逐个探测输入设备是否有信号。
    if std::env::args().any(|arg| arg == "--mic-scan") {
        let report = rayspeak_lib::mic_scan();
        let _ = std::fs::write("mic-scan.json", &report);
        println!("{report}");
        return;
    }
    // 麦克风诊断：录 8 秒（可传秒数），输出 WAV + 客观指标。
    if let Some(index) = std::env::args().position(|arg| arg == "--mic-diag") {
        let seconds = std::env::args()
            .nth(index + 1)
            .and_then(|value| value.parse::<f32>().ok())
            .unwrap_or(8.0);
        let report = rayspeak_lib::mic_diag(seconds);
        let _ = std::fs::write("mic-diag.json", &report);
        println!("{report}");
        return;
    }
    rayspeak_lib::run()
}

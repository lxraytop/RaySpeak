#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 提权 helper：由屏幕共享通过 runas 拉起，负责以管理员权限运行 EasyTier
    // 并回传日志。必须在 Tauri 初始化之前分流，不能再创建主窗口。
    let args: Vec<String> = std::env::args().collect();
    if let Some(index) = args.iter().position(|arg| arg == "--share-helper") {
        // 调试构建是控制台子系统；helper 由 runas 拉起时不希望出现黑框。
        #[cfg(all(windows, debug_assertions))]
        unsafe {
            let _ = windows::Win32::System::Console::FreeConsole();
        }
        let port = args
            .get(index + 1)
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(0);
        let token = args.get(index + 2).cloned().unwrap_or_default();
        std::process::exit(rayspeak_lib::share_helper_main(port, &token));
    }
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

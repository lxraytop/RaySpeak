// 测试构建里的采集替身。
//
// 真实实现链接 Windows Graphics Capture 与 TaskDialogIndirect（comctl32 v6）。
// cargo 的 lib 单测二进制不带应用清单，加载阶段会以 0xC0000139 退出，所以
// 单元测试改用这组空实现，保持与 capture.rs 相同的公开接口。
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CaptureInfo {
    pub id: String,
    pub source: CaptureSource,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    pub arrived: u64,
    pub built: u64,
    pub capture_ms: f64,
    pub build_ms: f64,
    pub minimized: bool,
    pub last_error: Option<String>,
}

pub fn sources() -> Result<Vec<CaptureSource>, String> {
    Err("测试构建不提供屏幕采集".into())
}

pub struct CaptureSession {
    id: String,
    info: CaptureInfo,
}

impl CaptureSession {
    pub async fn start(
        _app: Option<tauri::AppHandle>,
        _source_id: &str,
        _resolution: u32,
        _frame_rate: u32,
    ) -> Result<Self, String> {
        Err("测试构建不提供屏幕采集".into())
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn info(&self) -> CaptureInfo {
        self.info.clone()
    }

    pub fn stats(&self) -> CaptureStats {
        CaptureStats::default()
    }

    pub async fn take_frame(&self) -> Result<Vec<u8>, String> {
        Err("测试构建不提供屏幕采集".into())
    }

    pub async fn stop(&self) {}
}

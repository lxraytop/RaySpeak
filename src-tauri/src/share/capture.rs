// Windows Graphics Capture（WGC）采集。
//
// 不经过 WebView2 的 getDisplayMedia / 选屏器：Rust 侧枚举显示器与窗口、
// 用 D3D11 抓帧，缩放后编码成 JPEG，再经二进制 IPC 交给前端 WebRTC
// （原始 RGBA 走同一条 IPC 只有 ~106MB/s，1080p 帧会把采集压到个位数帧率）。
// 帧采用「前端请求、原生应答」的拉取模型，最多只有一个未完成请求；
// 没人要帧时连像素拷贝和编码都跳过。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::Notify;
use windows_capture::capture::{CaptureControl, Context, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use super::capture_math::{output_size, scale_rgba, validate};

/// JPEG 质量：q80/4:2:0 在 1728×1080 的桌面内容上约 183KB，
/// 文字仍清晰，编码 ~13ms。
const JPEG_QUALITY: u8 = 80;

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

/// 采集侧计数，用来分诊「采集 / IPC / 编码」哪一段在掉帧。
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct CaptureStats {
    /// WGC 回调送来的帧数。桌面完全静止时它本来就不会产帧。
    pub arrived: u64,
    /// 完成 JPEG 编码、发布给前端的帧数。
    pub built: u64,
    /// 最近一次 GPU 读回 + 缩放的耗时（毫秒）。
    pub capture_ms: f64,
    /// 最近一次 JPEG 编码的耗时（毫秒）。
    pub build_ms: f64,
    /// 采集的是窗口且已被最小化：WGC 对最小化窗口不产帧，画面会停住。
    pub minimized: bool,
    /// 最近一次采集/编码错误，用来在界面上解释「为什么卡住」。
    pub last_error: Option<String>,
}

/// 采集线程 → 编码线程的一帧原始像素。
struct EncodeJob {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

struct HandlerState {
    app: Option<AppHandle>,
    capture_id: String,
    stop: AtomicBool,
    /// 最新一帧（版本号 + 已缩放的 RGBA 帧）。消费者慢时直接覆盖，不排队。
    latest: Mutex<Option<(u64, Vec<u8>)>>,
    version: AtomicU64,
    /// 已经交给前端的版本；命令侧只在有新版本时返回数据。
    delivered: Mutex<u64>,
    wake: Notify,
    /// 原生命中率：超过 2 秒没人取帧就跳过像素拷贝，避免无人观看时空转。
    last_request: Mutex<Instant>,
    /// 一次性错误：`take_frame` 取走后采集可以继续重试。
    last_error: Mutex<Option<String>>,
    /// 保留最近一次错误供诊断面板展示，不参与恢复流程。
    recent_error: Mutex<Option<String>>,
    /// 目标间隔：显示器刷新率可能高于共享帧率，避免按 144Hz 白白缩放。
    min_interval: Duration,
    last_build: Mutex<Option<Instant>>,
    arrived: AtomicU64,
    built: AtomicU64,
    capture_last_us: AtomicU64,
    build_last_us: AtomicU64,
    /// 采集线程只投递、不等待：编码跟不上时这一帧直接丢弃，latest 仍是最新的。
    encode_tx: Mutex<Option<std::sync::mpsc::SyncSender<EncodeJob>>>,
    out_width: u32,
    out_height: u32,
}

impl HandlerState {
    /// 读回 → 缩放。JPEG 编码在独立线程里做（见 `spawn_encoder`）：
    /// 两者串在 WGC 回调里要 ~40ms，比 33ms 的帧间隔还长，采集会被拖到 24fps。
    fn build_pixels(&self, frame: &mut Frame) -> Result<EncodeJob, String> {
        let buffer = frame.buffer().map_err(|error| error.to_string())?;
        let src_width = buffer.width();
        let src_height = buffer.height();
        if src_width == 0 || src_height == 0 {
            return Err("采集帧尺寸无效".into());
        }
        let mut scratch = Vec::new();
        let data = buffer.as_nopadding_buffer(&mut scratch);
        let (width, height) = (self.out_width, self.out_height);
        let src_size = src_width as usize * src_height as usize * 4;
        if data.len() < src_size {
            return Err("采集帧数据不完整".into());
        }
        let pixels = if width == src_width && height == src_height {
            data[..src_size].to_vec()
        } else {
            scale_rgba(data, src_width, src_height, width, height)
        };
        if pixels.len() != width as usize * height as usize * 4 {
            return Err("缩放结果尺寸错误".into());
        }
        Ok(EncodeJob {
            width,
            height,
            pixels,
        })
    }
}

/// 头 8 字节（宽、高，小端）+ JPEG。
///
/// 必须压缩：Tauri IPC 走 WebView2 自定义协议，实测吞吐只有 ~106MB/s
/// （1MB≈9µs，另有 ~2.6ms 固定开销），1728×1080 的原始 RGBA 一帧 7.3MB
/// 单趟就要 ~70ms，采集循环被压到 9fps。q80/4:2:0 约 200KB，往返 ~5ms。
fn encode_jpeg(job: &EncodeJob) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(256 * 1024);
    out.extend_from_slice(&job.width.to_le_bytes());
    out.extend_from_slice(&job.height.to_le_bytes());
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, JPEG_QUALITY);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_2_2);
    encoder
        .encode(
            &job.pixels,
            job.width as u16,
            job.height as u16,
            jpeg_encoder::ColorType::Rgba,
        )
        .map_err(|error| error.to_string())?;
    Ok(out)
}

fn spawn_encoder(
    state: Arc<HandlerState>,
    jobs: std::sync::mpsc::Receiver<EncodeJob>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        while let Ok(job) = jobs.recv() {
            if state.stop.load(Ordering::Acquire) {
                break;
            }
            let started = Instant::now();
            match encode_jpeg(&job) {
                Ok(bytes) => {
                    state
                        .build_last_us
                        .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
                    state.built.fetch_add(1, Ordering::Relaxed);
                    let version = state.version.fetch_add(1, Ordering::SeqCst) + 1;
                    *state.latest.lock().unwrap() = Some((version, bytes));
                }
                Err(error) => {
                    *state.recent_error.lock().unwrap() = Some(error.clone());
                    *state.last_error.lock().unwrap() = Some(error);
                }
            }
            state.wake.notify_waiters();
        }
    })
}

struct CaptureHandler {
    state: Arc<HandlerState>,
}

impl GraphicsCaptureApiHandler for CaptureHandler {
    type Flags = Arc<HandlerState>;
    type Error = String;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self { state: ctx.flags })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        capture_control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.state.stop.load(Ordering::Acquire) {
            capture_control.stop();
            return Ok(());
        }
        self.state.arrived.fetch_add(1, Ordering::Relaxed);
        // 没人取帧时连像素拷贝都跳过。
        if self.state.last_request.lock().unwrap().elapsed() > Duration::from_secs(2) {
            return Ok(());
        }
        {
            let mut last = self.state.last_build.lock().unwrap();
            // 留 25% 余量：显示器 120/144Hz 时按硬间隔会因量化掉到 40fps 左右。
            let threshold = self.state.min_interval.mul_f64(0.75);
            if last.is_some_and(|t| t.elapsed() < threshold) {
                return Ok(());
            }
            *last = Some(Instant::now());
        }
        let started = Instant::now();
        match self.state.build_pixels(frame) {
            Ok(job) => {
                self.state
                    .capture_last_us
                    .store(started.elapsed().as_micros() as u64, Ordering::Relaxed);
                // 编码器忙就丢这一帧：等它只会把采集线程也拖慢。
                if let Some(tx) = self.state.encode_tx.lock().unwrap().as_ref() {
                    let _ = tx.try_send(job);
                }
                Ok(())
            }
            Err(error) => {
                *self.state.recent_error.lock().unwrap() = Some(error.clone());
                *self.state.last_error.lock().unwrap() = Some(error);
                self.state.wake.notify_waiters();
                Ok(())
            }
        }
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        if let Some(app) = self.state.app.as_ref() {
            let _ = app.emit(
                "ts://share-capture-ended",
                serde_json::json!({ "id": self.state.capture_id }),
            );
        }
        Ok(())
    }
}


pub fn sources() -> Result<Vec<CaptureSource>, String> {
    let mut list = Vec::new();
    let primary = Monitor::primary()
        .ok()
        .and_then(|monitor| monitor.index().ok());
    for (index, monitor) in Monitor::enumerate()
        .map_err(|error| error.to_string())?
        .into_iter()
        .enumerate()
    {
        let width = monitor.width().unwrap_or(0);
        let height = monitor.height().unwrap_or(0);
        let name = monitor
            .name()
            .unwrap_or_else(|_| format!("显示器 {}", index + 1));
        list.push(CaptureSource {
            id: format!("monitor:{index}"),
            name,
            kind: "monitor".into(),
            width,
            height,
            primary: Some(index) == primary,
        });
    }
    for window in Window::enumerate().map_err(|error| error.to_string())? {
        let Ok(title) = window.title() else {
            continue;
        };
        let width = window.width().unwrap_or(0).max(0) as u32;
        let height = window.height().unwrap_or(0).max(0) as u32;
        if title.trim().is_empty() || width < 64 || height < 64 {
            continue;
        }
        list.push(CaptureSource {
            id: format!("window:{}", window.as_raw_hwnd() as usize),
            name: title,
            kind: "window".into(),
            width,
            height,
            primary: false,
        });
    }
    Ok(list)
}

pub struct CaptureSession {
    id: String,
    info: CaptureInfo,
    state: Arc<HandlerState>,
    control: Mutex<Option<CaptureControl<CaptureHandler, String>>>,
    encoder: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// 窗口采集时记住 HWND，用来判断是否被最小化。
    hwnd: Option<isize>,
}

impl CaptureSession {
    pub async fn start(
        app: Option<AppHandle>,
        source_id: &str,
        resolution: u32,
        frame_rate: u32,
    ) -> Result<Self, String> {
        validate(resolution, frame_rate)?;
        let source = sources()?
            .into_iter()
            .find(|source| source.id == source_id)
            .ok_or_else(|| "共享目标已关闭，请刷新列表".to_string())?;
        let (width, height) = output_size(source.width, source.height, resolution);
        let id = uuid::Uuid::new_v4().to_string();
        let (encode_tx, jobs) = std::sync::mpsc::sync_channel::<EncodeJob>(1);
        let state = Arc::new(HandlerState {
            app,
            capture_id: id.clone(),
            stop: AtomicBool::new(false),
            latest: Mutex::new(None),
            version: AtomicU64::new(0),
            delivered: Mutex::new(0),
            wake: Notify::new(),
            last_request: Mutex::new(Instant::now() - Duration::from_secs(5)),
            last_error: Mutex::new(None),
            recent_error: Mutex::new(None),
            min_interval: Duration::from_millis((1000 / frame_rate.max(1)) as u64),
            last_build: Mutex::new(None),
            arrived: AtomicU64::new(0),
            built: AtomicU64::new(0),
            capture_last_us: AtomicU64::new(0),
            build_last_us: AtomicU64::new(0),
            encode_tx: Mutex::new(Some(encode_tx)),
            out_width: width,
            out_height: height,
        });
        let encoder = spawn_encoder(state.clone(), jobs);

        let (item, hwnd) = if let Some(index) = source_id.strip_prefix("monitor:") {
            let index: usize = index.parse().map_err(|_| "无效的显示器".to_string())?;
            let monitors = Monitor::enumerate().map_err(|error| error.to_string())?;
            let monitor = monitors
                .into_iter()
                .nth(index)
                .ok_or_else(|| "显示器已断开".to_string())?;
            (CaptureItem::Monitor(monitor), None)
        } else {
            let hwnd: usize = source_id
                .strip_prefix("window:")
                .and_then(|value| value.parse().ok())
                .ok_or_else(|| "无效的窗口".to_string())?;
            let window = Window::enumerate()
                .map_err(|error| error.to_string())?
                .into_iter()
                .find(|window| window.as_raw_hwnd() as usize == hwnd)
                .ok_or_else(|| "共享窗口已关闭".to_string())?;
            (CaptureItem::Window(window), Some(hwnd as isize))
        };

        let flags = state.clone();
        let interval = MinimumUpdateIntervalSettings::Custom(Duration::from_millis(
            (1000 / frame_rate.max(1)) as u64,
        ));
        let control = match item {
            CaptureItem::Monitor(monitor) => {
                let settings = Settings::new(
                    monitor,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags,
                );
                CaptureHandler::start_free_threaded(settings)
                    .map_err(|error| error.to_string())?
            }
            CaptureItem::Window(window) => {
                let settings = Settings::new(
                    window,
                    CursorCaptureSettings::Default,
                    DrawBorderSettings::WithoutBorder,
                    SecondaryWindowSettings::Default,
                    interval,
                    DirtyRegionSettings::Default,
                    ColorFormat::Rgba8,
                    flags,
                );
                CaptureHandler::start_free_threaded(settings)
                    .map_err(|error| error.to_string())?
            }
        };

        Ok(Self {
            info: CaptureInfo {
                id: id.clone(),
                source,
            },
            id,
            state,
            control: Mutex::new(Some(control)),
            encoder: Mutex::new(Some(encoder)),
            hwnd,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn info(&self) -> CaptureInfo {
        self.info.clone()
    }

    pub fn stats(&self) -> CaptureStats {
        let minimized = self.hwnd.is_some_and(|hwnd| unsafe {
            windows::Win32::UI::WindowsAndMessaging::IsIconic(
                windows::Win32::Foundation::HWND(hwnd as *mut core::ffi::c_void),
            )
            .as_bool()
        });
        CaptureStats {
            arrived: self.state.arrived.load(Ordering::Relaxed),
            built: self.state.built.load(Ordering::Relaxed),
            capture_ms: self.state.capture_last_us.load(Ordering::Relaxed) as f64 / 1000.0,
            build_ms: self.state.build_last_us.load(Ordering::Relaxed) as f64 / 1000.0,
            minimized,
            last_error: self.state.recent_error.lock().unwrap().clone(),
        }
    }

    /// 等待「比上次交付更新」的一帧；1 秒内没有新帧就返回空（画面静止）。
    /// 采集线程只保留最新一帧，消费端慢时旧帧直接覆盖，不会累积延迟。
    pub async fn take_frame(&self) -> Result<Vec<u8>, String> {
        *self.state.last_request.lock().unwrap() = Instant::now();
        loop {
            // 先注册等待再检查，避免 notify_waiters 落在检查与 await 之间丢掉唤醒。
            let notified = self.state.wake.notified();
            if self.state.stop.load(Ordering::Acquire) {
                return Err("屏幕采集已停止".into());
            }
            if let Some(error) = self.state.last_error.lock().unwrap().take() {
                return Err(error);
            }
            let frame = {
                let mut delivered = self.state.delivered.lock().unwrap();
                let mut latest = self.state.latest.lock().unwrap();
                match latest.as_ref() {
                    Some((version, _)) if *version > *delivered => {
                        let (version, bytes) = latest.take().unwrap();
                        *delivered = version;
                        Some(bytes)
                    }
                    _ => None,
                }
            };
            if let Some(bytes) = frame {
                return Ok(bytes);
            }
            match tokio::time::timeout(Duration::from_millis(1000), notified).await {
                Ok(()) => {}
                Err(_) => return Ok(Vec::new()),
            }
        }
    }

    pub async fn stop(&self) {
        self.state.stop.store(true, Ordering::Release);
        self.state.wake.notify_waiters();
        // 丢掉发送端，编码线程会在处理完当前帧后退出。
        self.state.encode_tx.lock().unwrap().take();
        let control = self.control.lock().unwrap().take();
        let encoder = self.encoder.lock().unwrap().take();
        if control.is_some() || encoder.is_some() {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                if let Some(control) = control {
                    let _ = control.stop();
                }
                if let Some(encoder) = encoder {
                    let _ = encoder.join();
                }
            })
            .await;
        }
    }
}

impl Drop for CaptureSession {
    fn drop(&mut self) {
        // 防止异常路径下遗留还在等任务的编码线程。
        self.state.stop.store(true, Ordering::Release);
        self.state.encode_tx.lock().unwrap().take();
        self.state.wake.notify_waiters();
    }
}

enum CaptureItem {
    Monitor(Monitor),
    Window(Window),
}


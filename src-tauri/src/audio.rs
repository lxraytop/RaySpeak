// 原生麦克风采集。
//
// 播放已统一走 WebView（Chromium 音频栈 + WebCodecs Opus），不再有第二套
// WASAPI 输出、抖动缓冲与解码器：两套播放路径的行为差异与设备时钟问题，
// 是之前「原生播放表现异常」的根源。
//
// 这里只负责：
//   设备采集（任意采样率）→ 重采样到 48k → SpeexDSP(NS/AGC) → 高通
//   → RNNoise/噪声门 → 软限幅 → VAD/PTT 门控 → Opus 编码 → tick 线程锁外发包

use std::collections::VecDeque;
use std::os::raw::c_void;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use audiopus::coder::Encoder;
use audiopus::{Application, Bitrate, Channels, SampleRate, Signal};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SupportedStreamConfig};
use ringbuf::traits::{Consumer, Producer, Split};
use ringbuf::HeapRb;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tsclient_rs::Client as VoiceClient;

pub(crate) const RATE: u32 = 48_000;
const FRAME_MS: u64 = 10;
const FRAME_FRAMES: usize = 480;
const MIC_PREROLL: usize = 12;
const MIC_FADE_SAMPLES: usize = 480;

// Windows 默认 15.6ms 定时器粒度会让 10ms 采集节奏抖动，临时提到 1ms。
#[cfg(target_os = "windows")]
#[allow(non_snake_case)]
#[link(name = "winmm")]
extern "system" {
    fn timeBeginPeriod(period: u32) -> u32;
}

fn default_volume() -> f32 {
    1.0
}

fn default_input_mode() -> String {
    "vad".to_string()
}

fn default_vad() -> i32 {
    -45
}

fn default_voice_hold() -> u32 {
    300
}

fn default_suppressor() -> String {
    "chromium".to_string()
}

fn default_true() -> bool {
    true
}

fn default_gate_depth() -> i32 {
    18
}

fn default_bitrate() -> u32 {
    64
}

fn default_frame_size() -> u32 {
    20
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeAudioConfig {
    #[serde(default)]
    pub mic_enabled: bool,
    #[serde(default)]
    pub input_device: Option<String>,
    #[serde(default = "default_volume")]
    pub input_volume: f32,
    #[serde(default)]
    pub input_muted: bool,
    #[serde(default = "default_input_mode")]
    pub input_mode: String,
    #[serde(default = "default_vad")]
    pub vad_threshold: i32,
    #[serde(default = "default_voice_hold")]
    pub voice_hold_ms: u32,
    #[serde(default)]
    pub music_mode: bool,
    #[serde(default = "default_bitrate")]
    pub bitrate: u32,
    #[serde(default = "default_frame_size")]
    pub frame_size: u32,
    #[serde(default)]
    pub stereo: bool,
    /// off / gate / chromium / speex / rnnoise
    #[serde(default = "default_suppressor")]
    pub noise_suppressor: String,
    #[serde(default = "default_true")]
    pub high_pass: bool,
    #[serde(default = "default_gate_depth")]
    pub gate_depth: i32,
    #[serde(default)]
    pub auto_gain: bool,
}

impl Default for NativeAudioConfig {
    fn default() -> Self {
        Self {
            mic_enabled: false,
            input_device: None,
            input_volume: 1.0,
            input_muted: false,
            input_mode: "vad".to_string(),
            vad_threshold: -45,
            voice_hold_ms: 300,
            music_mode: false,
            bitrate: 64,
            frame_size: 20,
            stereo: false,
            noise_suppressor: "chromium".to_string(),
            high_pass: true,
            gate_depth: 18,
            auto_gain: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioStats {
    pub mic_active: bool,
    pub mic_device: Option<String>,
    pub mic_rate: u32,
    pub mic_level_db: f32,
    pub mic_gate: bool,
    pub mic_frames: u64,
    pub mic_overruns: u64,
}

pub struct AudioEngine {
    worker: Arc<Mutex<Worker>>,
    stats: Arc<Mutex<AudioStats>>,
}

impl AudioEngine {
    pub fn start(app: AppHandle) -> Self {
        let stats = Arc::new(Mutex::new(AudioStats::default()));
        let tick_app = app.clone();
        let worker = Arc::new(Mutex::new(Worker::new(app, stats.clone())));
        let tick_worker = worker.clone();
        let _ = thread::Builder::new()
            .name("rayspeak-mic-tick".to_string())
            .spawn(move || {
                #[cfg(target_os = "windows")]
                unsafe {
                    timeBeginPeriod(1);
                }
                loop {
                    thread::sleep(Duration::from_millis(FRAME_MS));
                    // 抢不到锁就跳过这一轮：环形缓冲会兜住采集样本，
                    // 下一拍由速率伺服平滑追平，绝不整块丢样本。
                    let Ok(mut guard) = tick_worker.try_lock() else {
                        continue;
                    };
                    let output = guard.tick();
                    drop(guard);
                    // 发包与事件都在锁外：send_voice 会拿协议核的锁，
                    // 在锁内调用会与收包线程形成反向嵌套。
                    if let Some(client) = output.client {
                        for (data, codec) in output.packets {
                            client.send_voice(data, codec);
                        }
                    }
                    if let Some((talking, level_db)) = output.mic_event {
                        let _ = tick_app.emit(
                            "ts://mic-activity",
                            json!({ "talking": talking, "levelDb": level_db }),
                        );
                    }
                }
            });
        Self { worker, stats }
    }

    pub fn snapshot(&self) -> AudioStats {
        self.stats
            .lock()
            .map(|stats| stats.clone())
            .unwrap_or_default()
    }

    pub fn apply_config(&self, config: NativeAudioConfig) {
        if let Ok(mut worker) = self.worker.lock() {
            worker.apply_config(config);
        }
    }

    pub fn set_ptt(&self, active: bool) {
        if let Ok(mut worker) = self.worker.lock() {
            worker.ptt = active;
        }
    }

    pub fn set_client(&self, client: Option<Arc<VoiceClient>>) {
        if let Ok(mut worker) = self.worker.lock() {
            worker.client = client;
        }
    }
}

pub fn list_input_devices() -> Vec<String> {
    let host = cpal::default_host();
    host.input_devices()
        .map(|devices| devices.map(|device| device.to_string()).collect())
        .unwrap_or_default()
}

struct TickOutput {
    mic_event: Option<(bool, f32)>,
    client: Option<Arc<VoiceClient>>,
    packets: Vec<(Vec<u8>, i32)>,
}

struct Worker {
    app: AppHandle,
    stats: Arc<Mutex<AudioStats>>,
    config: NativeAudioConfig,
    client: Option<Arc<VoiceClient>>,
    ptt: bool,
    mic: Option<MicCapture>,
    apm: Option<SpeexApm>,
    encoder: Option<MicEncoder>,
    dsp: MicDsp,
    mic_accum: Vec<f32>,
    mic_preroll: VecDeque<Vec<f32>>,
    mic_gate_until: Option<Instant>,
    mic_gate_open: bool,
    mic_emit_at: Option<Instant>,
    mic_level_db: f32,
    mic_frames: u64,
    mic_buf: VecDeque<f32>,
    mic_step: f64,
    mic_pos: f64,
    pending_send: Vec<(Vec<u8>, i32)>,
    stats_at: Instant,
}

impl Worker {
    fn new(app: AppHandle, stats: Arc<Mutex<AudioStats>>) -> Self {
        Self {
            app,
            stats,
            config: NativeAudioConfig::default(),
            client: None,
            ptt: false,
            mic: None,
            apm: None,
            encoder: None,
            dsp: MicDsp::new(),
            mic_accum: Vec::with_capacity(FRAME_FRAMES * 6),
            mic_preroll: VecDeque::new(),
            mic_gate_until: None,
            mic_gate_open: false,
            mic_emit_at: None,
            mic_level_db: -90.0,
            mic_frames: 0,
            mic_buf: VecDeque::with_capacity(RATE as usize / 4),
            mic_step: 1.0,
            mic_pos: 0.0,
            pending_send: Vec::new(),
            stats_at: Instant::now(),
        }
    }

    fn apply_config(&mut self, config: NativeAudioConfig) {
        let device_changed = config.input_device != self.config.input_device;
        let mic_toggled = config.mic_enabled != self.config.mic_enabled;
        let apm_changed = config.noise_suppressor != self.config.noise_suppressor
            || config.auto_gain != self.config.auto_gain;
        let encoder_changed = config.music_mode != self.config.music_mode
            || config.stereo != self.config.stereo
            || config.bitrate != self.config.bitrate
            || config.frame_size != self.config.frame_size;
        self.config = config;
        self.config.input_volume = self.config.input_volume.clamp(0.0, 2.0);
        self.config.bitrate = self.config.bitrate.clamp(8, 256);
        self.config.frame_size = match self.config.frame_size {
            10 | 20 | 40 | 60 => self.config.frame_size,
            _ => 20,
        };
        if self.config.input_mode != "ptt" && self.config.input_mode != "open" {
            self.config.input_mode = "vad".to_string();
        }
        self.config.voice_hold_ms = self.config.voice_hold_ms.clamp(100, 1000);
        if !matches!(
            self.config.noise_suppressor.as_str(),
            "off" | "gate" | "chromium" | "speex" | "rnnoise"
        ) {
            self.config.noise_suppressor = "chromium".to_string();
        }
        self.config.gate_depth = self.config.gate_depth.clamp(0, 40);

        if !self.config.mic_enabled {
            self.close_mic();
        } else {
            if mic_toggled || device_changed || self.mic.is_none() {
                self.open_mic();
            }
            if apm_changed || self.apm.is_none() {
                // 原生采集没有播放参考信号，因此不启用回声消除，
                // 只做谱减降噪（speex/chromium）与 AGC。
                let speex_ns =
                    matches!(self.config.noise_suppressor.as_str(), "speex" | "chromium");
                self.apm = SpeexApm::new(speex_ns, self.config.auto_gain);
            }
            self.dsp.configure(&self.config.noise_suppressor);
            if encoder_changed || self.encoder.is_none() {
                self.encoder = MicEncoder::new(&self.config);
            }
        }
        self.update_stats();
    }

    fn tick(&mut self) -> TickOutput {
        let now = Instant::now();
        let mic_event = self.process_mic(now);
        if self.stats_at.elapsed() >= Duration::from_millis(500) {
            self.update_stats();
        }
        TickOutput {
            mic_event,
            client: self.client.clone(),
            packets: std::mem::take(&mut self.pending_send),
        }
    }

    fn open_mic(&mut self) {
        self.mic = None;
        match open_input_stream(self.app.clone(), &self.config) {
            Ok(capture) => {
                // 设备采样率 → 48 kHz 的重采样步长（1.0 表示本来就一致）。
                self.mic_step = capture.rate as f64 / RATE as f64;
                self.mic_buf.clear();
                self.mic_pos = 0.0;
                self.mic = Some(capture);
            }
            Err(error) => {
                let _ = self
                    .app
                    .emit("ts://audio-engine", json!({ "mic": true, "error": error }));
            }
        }
    }

    fn close_mic(&mut self) {
        self.mic = None;
        self.mic_level_db = -90.0;
        self.mic_gate_open = false;
        self.mic_gate_until = None;
        self.mic_emit_at = None;
        self.apm = None;
        self.encoder = None;
        self.dsp.reset();
        self.mic_buf.clear();
        self.mic_pos = 0.0;
        self.mic_accum.clear();
        self.mic_preroll.clear();
        self.pending_send.clear();
    }

    fn update_stats(&mut self) {
        self.stats_at = Instant::now();
        if let Ok(mut stats) = self.stats.lock() {
            stats.mic_active = self.mic.is_some();
            stats.mic_device = self.mic.as_ref().map(|mic| mic.device.clone());
            stats.mic_rate = self.mic.as_ref().map(|mic| mic.rate).unwrap_or(0);
            stats.mic_level_db = self.mic_level_db;
            stats.mic_gate = self.mic_gate_open;
            stats.mic_frames = self.mic_frames;
            stats.mic_overruns = self
                .mic
                .as_ref()
                .map(|mic| mic.overruns.load(Ordering::Relaxed))
                .unwrap_or(0);
        }
    }

    fn process_mic(&mut self, now: Instant) -> Option<(bool, f32)> {
        if self.mic.is_none() || self.apm.is_none() || self.encoder.is_none() {
            self.mic_level_db = -90.0;
            return None;
        }
        let mut frame = [0.0f32; FRAME_FRAMES];
        let base_step = self.mic_step.max(0.01);
        let need = ((FRAME_FRAMES as f64 - 1.0) * base_step + 2.0).ceil() as usize;
        while self.mic_buf.len() < need {
            let mut chunk = [0.0f32; 1024];
            let read = match self.mic.as_mut() {
                Some(mic) => mic.consumer.pop_slice(&mut chunk),
                None => 0,
            };
            if read == 0 {
                break;
            }
            self.mic_buf.extend(chunk[..read].iter().copied());
        }
        // 设备时钟与 10ms tick 不完全一致，占用会缓慢漂移。
        // 用 ±0.5% 的速率伺服把它拉回目标占用，而不是整块丢样本——
        // 整块丢弃会在波形中间留下跳变，听感就是「电流声/咔哒」。
        let occupancy = self.mic_buf.len() as f64;
        let target = need as f64;
        let trim = ((occupancy - target) / target * 0.05).clamp(-0.005, 0.005);
        let step = base_step * (1.0 + trim);
        if self.mic_buf.len() > need * 8 {
            self.mic_buf.clear();
            self.mic_pos = 0.0;
        }
        if self.mic_buf.len() < 2 {
            self.mic_level_db = -90.0;
            return None;
        }
        let next_pos = resample_into(&self.mic_buf, self.mic_pos, step, &mut frame);
        let consumed = (next_pos.floor() as usize).min(self.mic_buf.len());
        for _ in 0..consumed {
            self.mic_buf.pop_front();
        }
        self.mic_pos = (next_pos - consumed as f64).max(0.0);

        let gain = self.config.input_volume;
        let mut capture = [0i16; FRAME_FRAMES];
        for (index, sample) in frame.iter().enumerate() {
            capture[index] =
                (sample * gain * i16::MAX as f32).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        }
        if let Some(apm) = self.apm.as_mut() {
            apm.process(&mut capture);
        }

        let mut processed = vec![0.0f32; FRAME_FRAMES];
        for (index, sample) in capture.iter().enumerate() {
            processed[index] = *sample as f32 / 32768.0;
        }
        self.dsp.high_pass(&mut processed, self.config.high_pass);
        if self.config.noise_suppressor == "rnnoise" {
            self.dsp.denoise(&mut processed);
        }
        // 电平在噪声门之前测量：门衰减不应该改变 VAD 的判定语义。
        let mut energy = 0.0f64;
        for sample in processed.iter() {
            energy += (*sample as f64) * (*sample as f64);
        }
        let rms = (energy / FRAME_FRAMES as f64).sqrt() as f32;
        self.mic_level_db = 20.0 * rms.max(1e-5).log10();
        if self.config.noise_suppressor == "gate" {
            self.dsp.gate(
                &mut processed,
                self.config.vad_threshold as f32,
                self.config.gate_depth as f32,
            );
        }
        MicDsp::limit(&mut processed);

        let mode = self.config.input_mode.clone();
        let wants = !self.config.input_muted
            && match mode.as_str() {
                "ptt" => self.ptt,
                "open" => true,
                _ => self.mic_level_db >= self.config.vad_threshold as f32,
            };
        if wants && mode == "vad" {
            self.mic_gate_until =
                Some(now + Duration::from_millis(self.config.voice_hold_ms as u64));
        }
        let hold = mode != "ptt";
        let open = wants
            || (hold
                && self
                    .mic_gate_until
                    .map(|until| now < until)
                    .unwrap_or(false));

        if open {
            if !self.mic_gate_open {
                let preroll: Vec<Vec<f32>> = self.mic_preroll.drain(..).collect();
                let mut first = true;
                for buffered in preroll {
                    self.push_mic_frame(&buffered, first);
                    first = false;
                }
                self.push_mic_frame(&processed, first);
            } else {
                self.push_mic_frame(&processed, false);
            }
            self.mic_preroll.clear();
        } else if self.mic_gate_open {
            self.push_mic_frame(&processed, false);
            self.finish_mic_frame(true);
            self.mic_preroll.clear();
        } else {
            self.mic_preroll.push_back(processed);
            while self.mic_preroll.len() > MIC_PREROLL {
                self.mic_preroll.pop_front();
            }
        }

        let heartbeat = self
            .mic_emit_at
            .map(|stamp| now.duration_since(stamp) > Duration::from_millis(400))
            .unwrap_or(true);
        let mut event = None;
        if open != self.mic_gate_open || (open && heartbeat) {
            self.mic_emit_at = Some(now);
            event = Some((open, self.mic_level_db));
        }
        self.mic_gate_open = open;
        event
    }

    fn mic_frame_samples(&self) -> usize {
        FRAME_FRAMES * (self.config.frame_size.max(10) as usize) / 10
    }

    fn push_mic_frame(&mut self, frame: &[f32], fade_in: bool) {
        let start = self.mic_accum.len();
        self.mic_accum.extend_from_slice(frame);
        if fade_in {
            let ramp = MIC_FADE_SAMPLES.min(frame.len());
            for index in 0..ramp {
                self.mic_accum[start + index] *= index as f32 / ramp as f32;
            }
        }
        let frame_samples = self.mic_frame_samples();
        while self.mic_accum.len() >= frame_samples {
            let chunk: Vec<f32> = self.mic_accum.drain(..frame_samples).collect();
            self.encode_mic_frame(&chunk);
        }
    }

    fn finish_mic_frame(&mut self, fade_out: bool) {
        let frame_samples = self.mic_frame_samples();
        if self.mic_accum.is_empty() {
            return;
        }
        if fade_out {
            let len = self.mic_accum.len();
            let ramp = MIC_FADE_SAMPLES.min(len);
            for index in 0..ramp {
                let slot = len - ramp + index;
                self.mic_accum[slot] *= (ramp - index) as f32 / ramp as f32;
            }
        }
        self.mic_accum.resize(frame_samples, 0.0);
        let chunk: Vec<f32> = self.mic_accum.drain(..).collect();
        self.encode_mic_frame(&chunk);
    }

    fn encode_mic_frame(&mut self, pcm: &[f32]) {
        let Some(encoder) = self.encoder.as_mut() else {
            return;
        };
        let mut output = vec![0u8; 4000];
        let encoded = if encoder.channels == 2 {
            let mut stereo = Vec::with_capacity(pcm.len() * 2);
            for sample in pcm {
                stereo.push(*sample);
                stereo.push(*sample);
            }
            encoder.encoder.encode_float(&stereo, &mut output)
        } else {
            encoder.encoder.encode_float(pcm, &mut output)
        };
        let Ok(size) = encoded else { return };
        if size == 0 {
            return;
        }
        let codec = encoder.codec;
        if self.client.is_some() {
            self.pending_send.push((output[..size].to_vec(), codec));
            self.mic_frames += 1;
        }
    }
}

struct MicEncoder {
    encoder: Encoder,
    channels: usize,
    codec: i32,
}

impl MicEncoder {
    fn new(config: &NativeAudioConfig) -> Option<Self> {
        let stereo = config.stereo || config.music_mode;
        let channels = if stereo {
            Channels::Stereo
        } else {
            Channels::Mono
        };
        let application = if config.music_mode {
            Application::Audio
        } else {
            Application::Voip
        };
        let mut encoder = Encoder::new(SampleRate::Hz48000, channels, application).ok()?;
        let _ = encoder.set_bitrate(Bitrate::BitsPerSecond((config.bitrate * 1000) as i32));
        let _ = encoder.set_complexity(10);
        let _ = encoder.set_inband_fec(true);
        let _ = encoder.set_packet_loss_perc(5);
        let _ = encoder.set_dtx(false);
        let _ = encoder.set_signal(if config.music_mode {
            Signal::Music
        } else {
            Signal::Voice
        });
        Some(Self {
            encoder,
            channels: if stereo { 2 } else { 1 },
            codec: if config.music_mode { 5 } else { 4 },
        })
    }
}

struct MicCapture {
    _stream: cpal::Stream,
    consumer: ringbuf::HeapCons<f32>,
    device: String,
    rate: u32,
    overruns: Arc<AtomicU64>,
}

/// 采集侧后处理链：高通 → RNNoise（可选）→ 噪声门（可选）→ 软限幅。
/// 顺序与前端 AudioWorklet 的实现保持一致，两条链路听感尽量相同。
pub(crate) struct MicDsp {
    hp_x: f32,
    hp_y: f32,
    gate_gain: f32,
    rnnoise: Option<Box<nnnoiseless::DenoiseState<'static>>>,
    rn_in: Vec<f32>,
    rn_out: Vec<f32>,
    primed: bool,
}

impl MicDsp {
    pub(crate) fn new() -> Self {
        Self {
            hp_x: 0.0,
            hp_y: 0.0,
            gate_gain: 1.0,
            rnnoise: None,
            rn_in: vec![0.0; FRAME_FRAMES],
            rn_out: vec![0.0; FRAME_FRAMES],
            primed: false,
        }
    }

    pub(crate) fn reset(&mut self) {
        self.hp_x = 0.0;
        self.hp_y = 0.0;
        self.gate_gain = 1.0;
        self.primed = false;
    }

    pub(crate) fn configure(&mut self, suppressor: &str) {
        if suppressor == "rnnoise" {
            if self.rnnoise.is_none() {
                self.rnnoise = Some(nnnoiseless::DenoiseState::new());
                self.primed = false;
            }
        } else if self.rnnoise.is_some() {
            self.rnnoise = None;
        }
    }

    /// 80 Hz 一阶高通：去掉直流与桌面震动/空调低频隆隆声。
    pub(crate) fn high_pass(&mut self, frame: &mut [f32], enabled: bool) {
        if !enabled {
            return;
        }
        const ALPHA: f32 = 0.9899;
        for sample in frame.iter_mut() {
            let input = *sample;
            let output = ALPHA * (self.hp_y + input - self.hp_x);
            self.hp_x = input;
            self.hp_y = output;
            *sample = output;
        }
    }

    /// RNNoise（48 kHz / 480 帧，样本按 ±32768 标定）。
    pub(crate) fn denoise(&mut self, frame: &mut [f32]) {
        if frame.len() != FRAME_FRAMES {
            return;
        }
        let Some(mut state) = self.rnnoise.take() else {
            return;
        };
        for (dst, src) in self.rn_in.iter_mut().zip(frame.iter()) {
            *dst = *src * 32768.0;
        }
        state.process_frame(&mut self.rn_out, &self.rn_in);
        self.rnnoise = Some(state);
        // 首帧依赖前序状态，输出会带淡入伪影，直接丢弃。
        if !self.primed {
            self.primed = true;
            frame.fill(0.0);
            return;
        }
        for (dst, src) in frame.iter_mut().zip(self.rn_out.iter()) {
            *dst = *src / 32768.0;
        }
    }

    /// 软噪声门：低于阈值时整帧压到 -depth dB，开得快、关得慢。
    pub(crate) fn gate(&mut self, frame: &mut [f32], threshold_db: f32, depth_db: f32) {
        let energy = frame.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>();
        let rms = (energy / frame.len().max(1) as f64).sqrt() as f32;
        let level_db = 20.0 * rms.max(1e-6).log10();
        let target = if level_db >= threshold_db {
            1.0
        } else {
            10f32.powf(-depth_db.abs() / 20.0)
        };
        // 开得快、关得慢：10 ms 块上约 5 ms 开启、250 ms 关到底。
        let coefficient = if target > self.gate_gain { 0.7 } else { 0.15 };
        let start = self.gate_gain;
        self.gate_gain += (target - self.gate_gain) * coefficient;
        let step = (self.gate_gain - start) / frame.len().max(1) as f32;
        let mut gain = start;
        for sample in frame.iter_mut() {
            gain += step;
            *sample *= gain;
        }
    }

    /// 软限幅：0.7 以上用 tanh 压到 1.0，避免硬削产生方波谐波。
    pub(crate) fn limit(frame: &mut [f32]) {
        for sample in frame.iter_mut() {
            let magnitude = sample.abs();
            if magnitude > 0.7 {
                *sample = sample.signum() * (0.7 + 0.3 * ((magnitude - 0.7) / 0.3).tanh());
            }
        }
    }
}

/// 线性重采样：把任意输入采样率的样本插值到 48 kHz 输出。
fn resample_into(buf: &VecDeque<f32>, pos: f64, step: f64, out: &mut [f32]) -> f64 {
    let len = buf.len();
    if len < 2 {
        out.fill(0.0);
        return pos + out.len() as f64 * step;
    }
    for (index, slot) in out.iter_mut().enumerate() {
        let position = pos + index as f64 * step;
        let floor = position.floor().max(0.0) as usize;
        let base = floor.min(len - 2);
        let frac = (position - position.floor()) as f32;
        let a = buf[base];
        let b = buf[base + 1];
        *slot = a + (b - a) * frac;
    }
    pos + out.len() as f64 * step
}

/// SpeexDSP 预处理：谱减降噪 + 自动增益。
/// 原生采集没有播放参考信号，因此不启用回声消除（AEC 需要 render 参考）。
struct SpeexApm {
    pre: *mut aec_rs_sys::SpeexPreprocessState,
}

// 只在采集 tick 线程内使用；裸指针本身不实现 Send。
unsafe impl Send for SpeexApm {}

impl SpeexApm {
    fn new(denoise: bool, agc: bool) -> Option<Self> {
        let pre =
            unsafe { aec_rs_sys::speex_preprocess_state_init(FRAME_FRAMES as i32, RATE as i32) };
        if pre.is_null() {
            return None;
        }
        let denoise_value = denoise as i32;
        let agc_value = agc as i32;
        let noise_suppress = -25.0f32;
        let agc_target = 12_000i32;
        unsafe {
            aec_rs_sys::speex_preprocess_ctl(
                pre,
                aec_rs_sys::SPEEX_PREPROCESS_SET_DENOISE as i32,
                &denoise_value as *const i32 as *mut c_void,
            );
            aec_rs_sys::speex_preprocess_ctl(
                pre,
                aec_rs_sys::SPEEX_PREPROCESS_SET_NOISE_SUPPRESS as i32,
                &noise_suppress as *const f32 as *mut c_void,
            );
            aec_rs_sys::speex_preprocess_ctl(
                pre,
                aec_rs_sys::SPEEX_PREPROCESS_SET_AGC as i32,
                &agc_value as *const i32 as *mut c_void,
            );
            aec_rs_sys::speex_preprocess_ctl(
                pre,
                aec_rs_sys::SPEEX_PREPROCESS_SET_AGC_TARGET as i32,
                &agc_target as *const i32 as *mut c_void,
            );
        }
        Some(Self { pre })
    }

    fn process(&mut self, capture: &mut [i16; FRAME_FRAMES]) {
        unsafe {
            aec_rs_sys::speex_preprocess_run(self.pre, capture.as_mut_ptr());
        }
    }
}

impl Drop for SpeexApm {
    fn drop(&mut self) {
        unsafe {
            if !self.pre.is_null() {
                aec_rs_sys::speex_preprocess_state_destroy(self.pre);
                self.pre = std::ptr::null_mut();
            }
        }
    }
}

fn open_input_stream(app: AppHandle, config: &NativeAudioConfig) -> Result<MicCapture, String> {
    let host = cpal::default_host();
    let device = select_input_device(&host, config.input_device.as_deref())?;
    let supported = pick_input_config(&device)?;
    let sample_format = supported.sample_format();
    let stream_config = supported.config();
    let channels = stream_config.channels as usize;
    let rate = stream_config.sample_rate;
    let ring = HeapRb::<f32>::new(rate as usize);
    let (mut producer, consumer) = ring.split();
    let overruns = Arc::new(AtomicU64::new(0));
    let callback_overruns = overruns.clone();
    let error_app = app.clone();
    let error_fn = move |error: cpal::Error| {
        if matches!(
            error.kind(),
            cpal::ErrorKind::Xrun
                | cpal::ErrorKind::RealtimeDenied
                | cpal::ErrorKind::DeviceChanged
        ) {
            return;
        }
        let _ = error_app.emit(
            "ts://audio-engine",
            json!({ "mic": true, "error": error.to_string() }),
        );
    };
    let stream = match sample_format {
        SampleFormat::F32 => {
            let mut scratch = Vec::<f32>::with_capacity(8192);
            device.build_input_stream(
                stream_config,
                move |data: &[f32], _| {
                    scratch.clear();
                    if channels <= 1 {
                        scratch.extend_from_slice(data);
                    } else {
                        for frame in data.chunks_exact(channels) {
                            let sum: f32 = frame.iter().sum();
                            scratch.push(sum / channels as f32);
                        }
                    }
                    if producer.push_slice(&scratch) < scratch.len() {
                        callback_overruns.fetch_add(1, Ordering::Relaxed);
                    }
                },
                error_fn,
                None,
            )
        }
        SampleFormat::I16 => {
            let mut scratch = Vec::<f32>::with_capacity(8192);
            device.build_input_stream(
                stream_config,
                move |data: &[i16], _| {
                    scratch.clear();
                    if channels <= 1 {
                        scratch.extend(data.iter().map(|sample| *sample as f32 / 32768.0));
                    } else {
                        for frame in data.chunks_exact(channels) {
                            let sum: f32 =
                                frame.iter().map(|sample| *sample as f32 / 32768.0).sum();
                            scratch.push(sum / channels as f32);
                        }
                    }
                    if producer.push_slice(&scratch) < scratch.len() {
                        callback_overruns.fetch_add(1, Ordering::Relaxed);
                    }
                },
                error_fn,
                None,
            )
        }
        _ => return Err("不支持的麦克风采样格式".to_string()),
    }
    .map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;
    Ok(MicCapture {
        _stream: stream,
        consumer,
        device: device.to_string(),
        rate,
        overruns,
    })
}

fn select_input_device(host: &cpal::Host, name: Option<&str>) -> Result<cpal::Device, String> {
    let mut devices: Vec<cpal::Device> = host.input_devices().map_err(|error| error.to_string())?.collect();
    let requested = name.map(str::trim).filter(|value| !value.is_empty());
    if let Some(requested) = requested {
        if let Some(device) = devices
            .iter()
            .find(|device| device.to_string() == requested)
        {
            return Ok(device.clone());
        }
        if let Some(device) = devices.iter().find(|device| {
            let name = device.to_string();
            name.contains(requested) || requested.contains(&name)
        }) {
            return Ok(device.clone());
        }
        // 不能悄悄回落到系统默认：用户会以为切换生效了，实际还在用另一支麦克风。
        return Err(format!("找不到麦克风「{requested}」，请重新选择输入设备"));
    }
    host.default_input_device()
        .or_else(|| devices.pop())
        .ok_or_else(|| "没有可用的麦克风设备".to_string())
}

fn pick_input_config(device: &cpal::Device) -> Result<SupportedStreamConfig, String> {
    let mut best: Option<(i32, SupportedStreamConfig)> = None;
    if let Ok(ranges) = device.supported_input_configs() {
        for range in ranges {
            let format_rank = match range.sample_format() {
                SampleFormat::F32 => 0,
                SampleFormat::I16 => 1,
                _ => continue,
            };
            if range.channels() < 1 || range.channels() > 2 {
                continue;
            }
            // 优先 48 kHz，不支持时退到 44.1k 或区间上界，由采集侧重采样。
            let rate = if range.min_sample_rate() <= RATE && range.max_sample_rate() >= RATE {
                RATE
            } else if range.min_sample_rate() <= 44_100 && range.max_sample_rate() >= 44_100 {
                44_100
            } else {
                range.max_sample_rate().min(96_000)
            };
            if rate < 8_000 {
                continue;
            }
            let distance = (rate as i32 - RATE as i32).abs();
            let rate_rank = if rate == RATE { 0 } else { 1000 + distance };
            let score = rate_rank * 4 + format_rank * 2 + if range.channels() == 1 { 0 } else { 1 };
            if best
                .as_ref()
                .map(|(current, _)| score < *current)
                .unwrap_or(true)
            {
                best = Some((score, range.with_sample_rate(rate)));
            }
        }
    }
    if let Some((_, config)) = best {
        return Ok(config);
    }
    let default = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    if default.channels() >= 1
        && default.channels() <= 2
        && matches!(
            default.sample_format(),
            SampleFormat::F32 | SampleFormat::I16
        )
    {
        Ok(default)
    } else {
        Err("麦克风没有可用的单/双声道采集格式".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 选错设备名必须报错：悄悄回落到默认设备会让用户以为切换生效了。
    #[test]
    fn unknown_input_device_is_rejected() {
        let host = cpal::default_host();
        let inputs = host.input_devices().map(|list| list.count()).unwrap_or(0);
        if inputs == 0 {
            return;
        }
        let error = select_input_device(&host, Some("definitely-not-a-real-microphone"))
            .err()
            .expect("unknown device must not fall back to default");
        assert!(error.contains("找不到麦克风"), "unexpected error: {error}");
        assert!(select_input_device(&host, None).is_ok());
    }

    // 噪声门：低于阈值压到 -depth dB，高于阈值逐步恢复接近 0 dB。
    #[test]
    fn gate_attenuates_noise_and_opens_on_voice() {
        let mut dsp = MicDsp::new();
        let noise = vec![0.0012f32; FRAME_FRAMES];
        let mut frame = noise.clone();
        for _ in 0..40 {
            frame.copy_from_slice(&noise);
            dsp.gate(&mut frame, -45.0, 18.0);
        }
        let peak = frame.iter().fold(0f32, |acc, v| acc.max(v.abs()));
        assert!(
            peak < 0.0006,
            "gated noise should drop by ~18 dB, got peak {peak}"
        );

        let voice = vec![0.2f32; FRAME_FRAMES];
        for _ in 0..40 {
            frame.copy_from_slice(&voice);
            dsp.gate(&mut frame, -45.0, 18.0);
        }
        assert!(
            frame[FRAME_FRAMES - 1] > 0.18,
            "gate must reopen on speech, got {}",
            frame[FRAME_FRAMES - 1]
        );
    }

    // 软限幅：2 倍增益后的满幅信号不能超过 1.0，也不应该被削成方波。
    #[test]
    fn limiter_keeps_signal_bounded() {
        let mut frame: Vec<f32> = (0..FRAME_FRAMES)
            .map(|i| (i as f32 * 0.11).sin() * 1.8)
            .collect();
        MicDsp::limit(&mut frame);
        assert!(frame.iter().all(|v| v.abs() <= 1.0));
        assert!(
            frame.iter().any(|v| v.abs() > 0.85),
            "soft limiter should keep loud peaks near full scale"
        );
    }

    // RNNoise：首帧丢弃伪影，后续帧输出有限且不超出输入量级。
    #[test]
    fn rnnoise_output_stays_finite() {
        let mut dsp = MicDsp::new();
        dsp.configure("rnnoise");
        let tone = |len: usize| -> Vec<f32> {
            (0..len)
                .map(|i| 0.1 * (i as f32 * 0.12).sin())
                .collect::<Vec<f32>>()
        };
        let mut first = tone(FRAME_FRAMES);
        dsp.denoise(&mut first);
        assert!(
            first.iter().all(|v| *v == 0.0),
            "RNNoise 首帧应被丢弃以躲开淡入伪影"
        );
        for _ in 0..4 {
            let mut frame = tone(FRAME_FRAMES);
            dsp.denoise(&mut frame);
            assert!(frame.iter().all(|v| v.is_finite()));
            assert!(frame.iter().all(|v| v.abs() <= 0.2));
        }
        dsp.configure("off");
        assert!(dsp.rnnoise.is_none());
    }

    // 一阶高通：直流分量应被压到接近 0。
    #[test]
    fn high_pass_removes_dc_offset() {
        let mut dsp = MicDsp::new();
        let dc = vec![0.5f32; FRAME_FRAMES];
        let mut frame = dc.clone();
        for _ in 0..10 {
            frame.copy_from_slice(&dc);
            dsp.high_pass(&mut frame, true);
        }
        let peak = frame.iter().fold(0f32, |acc, v| acc.max(v.abs()));
        assert!(peak < 0.01, "DC offset must be blocked, got peak {peak}");
    }

    // 44.1 kHz 麦克风：480 个输出样本消费 480×step 个输入样本，直流不被改变。
    #[test]
    fn resample_from_44k1_preserves_level() {
        let mut buf: VecDeque<f32> = VecDeque::new();
        for _ in 0..4096 {
            buf.push_back(0.25);
        }
        let step = 44_100.0 / RATE as f64;
        let mut out = [0.0f32; FRAME_FRAMES];
        let next = resample_into(&buf, 0.0, step, &mut out);
        assert!(
            out.iter().all(|value| (*value - 0.25).abs() < 1e-6),
            "重采样不应改变直流电平"
        );
        assert!((next - FRAME_FRAMES as f64 * step).abs() < 1e-6);
        assert!(next < FRAME_FRAMES as f64, "44.1k 需要更少的输入样本");
    }

    #[test]
    fn resample_interpolates_linearly() {
        let mut buf: VecDeque<f32> = VecDeque::new();
        for index in 0..2048 {
            buf.push_back(index as f32);
        }
        let mut out = [0.0f32; 8];
        resample_into(&buf, 0.0, 2.0, &mut out);
        assert!((out[0] - 0.0).abs() < 1e-4);
        assert!((out[1] - 2.0).abs() < 1e-4);
        assert!((out[3] - 6.0).abs() < 1e-4);
    }
}

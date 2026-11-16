// 系统音频采集（WASAPI 进程回环，排除 RaySpeak 自身）。
//
// 用 `ActivateAudioInterfaceAsync` + `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
// 激活一个「虚拟回环设备」，`ProcessTree` 设为 EXCLUDE 并传本进程 ID：
// 这样拿到的是「除 RaySpeak 进程树以外」的所有桌面声音——包括游戏、播放器、
// 浏览器，而 RaySpeak 自己播放的队友语音不会被二次采集，避免观众听到回声。
//
// 采集线程把交织的 f32 样本放进环形缓冲，前端按 ~20ms 拉取后转成
// `AudioData`（f32-planar）喂给 `MediaStreamTrackGenerator`。
// 要求 Windows 10 2004+（build 19041+）；不支持时启动直接报错并让界面降级成纯画面。

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use windows::core::{implement, Interface, Ref};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler,
    IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
    AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::System::Com::{
    CoInitializeEx, CoTaskMemAlloc, CoUninitialize, COINIT_MULTITHREADED,
};
use windows::Win32::System::Com::StructuredStorage::{
    PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::System::Threading::{
    CreateEventW, GetCurrentProcessId, WaitForSingleObject,
};

const SAMPLE_RATE: u32 = 48_000;
const CHANNELS: u16 = 2;
const BYTES_PER_SAMPLE: u16 = 4;
/// 2 秒的环形缓冲：前端暂停取帧时不至于无限增长。
const MAX_BUFFERED_SAMPLES: usize = SAMPLE_RATE as usize * CHANNELS as usize * 2;

#[derive(Serialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: u16,
}

pub struct AudioSession {
    info: AudioInfo,
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<VecDeque<f32>>>,
    thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl AudioSession {
    pub async fn start() -> Result<Self, String> {
        let stop = Arc::new(AtomicBool::new(false));
        let samples = Arc::new(Mutex::new(VecDeque::with_capacity(MAX_BUFFERED_SAMPLES)));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        let thread = {
            let stop = stop.clone();
            let samples = samples.clone();
            std::thread::spawn(move || {
                run_capture(stop, samples, ready_tx);
            })
        };

        match tauri::async_runtime::spawn_blocking(move || {
            ready_rx.recv_timeout(Duration::from_secs(6))
        })
        .await
        {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(error))) => {
                stop.store(true, Ordering::Release);
                let _ = thread.join();
                return Err(error);
            }
            _ => {
                stop.store(true, Ordering::Release);
                let _ = thread.join();
                return Err("系统音频启动超时".into());
            }
        }

        Ok(Self {
            info: AudioInfo {
                sample_rate: SAMPLE_RATE,
                channels: CHANNELS,
            },
            stop,
            samples,
            thread: Mutex::new(Some(thread)),
        })
    }

    pub fn info(&self) -> AudioInfo {
        self.info
    }

    /// 取出最多 `max_frames` 帧，按 **planar**（先 L 后 R）返回 f32le 字节。
    /// WebCodecs 的 `f32-planar` 正好是这个布局，前端不用再做交织转换。
    pub fn read(&self, max_frames: usize) -> Vec<u8> {
        let channels = self.info.channels as usize;
        let mut ring = self.samples.lock().unwrap();
        let available = ring.len() / channels;
        let frames = available.min(max_frames);
        if frames == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(frames * channels * 2);
        let mut left = Vec::with_capacity(frames);
        let mut right = Vec::with_capacity(frames);
        for _ in 0..frames {
            left.push(ring.pop_front().unwrap_or(0.0));
            for channel in 1..channels {
                let value = ring.pop_front().unwrap_or(0.0);
                if channel == 1 {
                    right.push(value);
                }
            }
        }
        for value in left.iter().chain(right.iter()) {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }

    pub async fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        let thread = self.thread.lock().unwrap().take();
        if let Some(thread) = thread {
            let _ = tauri::async_runtime::spawn_blocking(move || {
                let _ = thread.join();
            })
            .await;
        }
        self.samples.lock().unwrap().clear();
    }
}

impl Drop for AudioSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    done: Arc<(Mutex<bool>, std::sync::Condvar)>,
    client: Arc<Mutex<Option<IAudioClient>>>,
    error: Arc<Mutex<Option<String>>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        operation: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let mut status = windows::core::HRESULT(0);
        let mut activated: Option<windows::core::IUnknown> = None;
        if let Some(operation) = operation.as_ref() {
            unsafe {
                let _ = operation.GetActivateResult(&mut status, &mut activated);
            }
        }
        if status.is_ok() {
            match activated.and_then(|value| value.cast::<IAudioClient>().ok()) {
                Some(client) => *self.client.lock().unwrap() = Some(client),
                None => *self.error.lock().unwrap() = Some("音频接口类型不匹配".into()),
            }
        } else {
            *self.error.lock().unwrap() = Some(format!(
                "系统音频不可用（0x{:08X}），需要 Windows 10 2004 及以上",
                status.0
            ));
        }
        let (lock, condvar) = &*self.done;
        *lock.lock().unwrap() = true;
        condvar.notify_all();
        Ok(())
    }
}

fn run_capture(
    stop: Arc<AtomicBool>,
    samples: Arc<Mutex<VecDeque<f32>>>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let com = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let ok = com.is_ok();
    let result = activate_and_capture(&stop, &samples, &ready);
    if let Err(error) = result {
        let _ = ready.send(Err(error));
    }
    if ok {
        unsafe { CoUninitialize() };
    }
}

fn activate_and_capture(
    stop: &Arc<AtomicBool>,
    samples: &Arc<Mutex<VecDeque<f32>>>,
    ready: &std::sync::mpsc::Sender<Result<(), String>>,
) -> Result<(), String> {
    let done = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
    let client_slot = Arc::new(Mutex::new(None));
    let error_slot = Arc::new(Mutex::new(None));
    let handler: IActivateAudioInterfaceCompletionHandler = ActivationHandler {
        done: done.clone(),
        client: client_slot.clone(),
        error: error_slot.clone(),
    }
    .into();

    let process_id = unsafe { GetCurrentProcessId() };
    let params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: process_id,
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // 激活接口要求把参数装进 VT_BLOB 的 PROPVARIANT。windows-rs 的 PROPVARIANT
    // 实现了 Drop（PropVariantClear），VT_BLOB 的 pBlobData 会被按 CoTaskMemFree
    // 释放；所以这块内存必须由 CoTaskMemAlloc 分配，指向栈上会让进程崩堆。
    let params_size = std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>();
    let params_ptr = unsafe { CoTaskMemAlloc(params_size) } as *mut AUDIOCLIENT_ACTIVATION_PARAMS;
    if params_ptr.is_null() {
        return Err("无法分配系统音频激活参数".into());
    }
    unsafe { params_ptr.write(params) };
    let blob = PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                wReserved1: 0,
                wReserved2: 0,
                wReserved3: 0,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: windows::Win32::System::Com::BLOB {
                        cbSize: params_size as u32,
                        pBlobData: params_ptr as *mut u8,
                    },
                },
            }),
        },
    };

    unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&blob as *const _),
            &handler,
        )
        .map_err(|error| format!("无法启动系统音频：{error}"))?;
    }

    {
        let (lock, condvar) = &*done;
        let mut finished = lock.lock().unwrap();
        let mut waited = Duration::ZERO;
        while !*finished {
            if waited >= Duration::from_secs(5) {
                // 超时后激活可能仍在进行：handler 与参数内存不能释放，
                // 交给系统在回调结束时自行收尾（很小的一次性泄漏）。
                std::mem::forget(blob);
                std::mem::forget(handler);
                return Err("激活系统音频接口超时".into());
            }
            let (next, timeout) = condvar
                .wait_timeout(finished, Duration::from_millis(200))
                .unwrap();
            finished = next;
            waited += Duration::from_millis(200);
            let _ = timeout;
        }
    }

    if let Some(error) = error_slot.lock().unwrap().take() {
        return Err(error);
    }
    let client = client_slot
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "没有拿到系统音频客户端".to_string())?;

    let format = WAVEFORMATEX {
        wFormatTag: 3, // WAVE_FORMAT_IEEE_FLOAT
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * CHANNELS as u32 * BYTES_PER_SAMPLE as u32,
        nBlockAlign: CHANNELS * BYTES_PER_SAMPLE,
        wBitsPerSample: BYTES_PER_SAMPLE * 8,
        cbSize: 0,
    };
    // 进程回环必须带 AUDCLNT_STREAMFLAGS_LOOPBACK（缺了会 AUDCLNT_E_INVALID_STREAM_FLAG），
    // period 为 0、buffer 时长非 0（200ms）。
    let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
        | AUDCLNT_STREAMFLAGS_LOOPBACK
        | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
        | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    unsafe {
        client
            .Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                flags,
                200 * 10_000,
                0,
                &format,
                None,
            )
            .map_err(|error| format!("系统音频初始化失败：{error}"))?;
    }
    let event = unsafe { CreateEventW(None, false, false, None) }
        .map_err(|error| format!("创建音频事件失败：{error}"))?;
    unsafe {
        client
            .SetEventHandle(event)
            .map_err(|error| format!("绑定音频事件失败：{error}"))?;
    }
    let capture: IAudioCaptureClient = unsafe {
        client
            .GetService()
            .map_err(|error| format!("获取音频采集接口失败：{error}"))?
    };
    unsafe {
        client
            .Start()
            .map_err(|error| format!("启动系统音频失败：{error}"))?;
    }
    let _ = ready.send(Ok(()));

    while !stop.load(Ordering::Acquire) {
        let waited = unsafe { WaitForSingleObject(event, 200) };
        if waited != WAIT_OBJECT_0 {
            continue;
        }
        loop {
            let packet_frames = match unsafe { capture.GetNextPacketSize() } {
                Ok(frames) => frames,
                Err(_) => break,
            };
            if packet_frames == 0 {
                break;
            }
            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            let mut device_position = 0u64;
            let mut qpc_position = 0u64;
            if unsafe {
                capture.GetBuffer(
                    &mut data,
                    &mut frames,
                    &mut flags,
                    Some(&mut device_position),
                    Some(&mut qpc_position),
                )
            }
            .is_err()
            {
                break;
            }
            if frames > 0 {
                // AUDCLNT_BUFFERFLAGS_SILENT = 0x2
                let silent = flags & 0x2 != 0;
                let count = frames as usize * CHANNELS as usize;
                let mut ring = samples.lock().unwrap();
                if silent || data.is_null() {
                    for _ in 0..count {
                        push_sample(&mut ring, 0.0);
                    }
                } else {
                    let slice = unsafe { std::slice::from_raw_parts(data as *const f32, count) };
                    for value in slice {
                        push_sample(&mut ring, *value);
                    }
                }
            }
            let _ = unsafe { capture.ReleaseBuffer(frames) };
        }
    }

    unsafe {
        let _ = client.Stop();
    }
    unsafe {
        let _ = CloseHandle(event);
    }
    Ok(())
}

fn push_sample(ring: &mut VecDeque<f32>, value: f32) {
    if ring.len() >= MAX_BUFFERED_SAMPLES {
        ring.pop_front();
    }
    ring.push_back(value);
}

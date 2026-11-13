// 麦克风诊断：不依赖人耳判断，把「设备原始信号」与「处理后信号」都录成 WAV，
// 并给出一组可解释的客观指标（直流、削波、底噪、工频哼声、高频嘶声、帧边界断点）。
//
// 用法：rayspeak.exe --mic-diag [秒数]
// 产物：mic-diag-raw.wav、mic-diag-processed.wav、mic-diag.json
//
// 这些指标用来区分三类完全不同的“电流声”：
//   1. 工频哼声（hum）：50/60 Hz 及其谐波能量占比高 → 供电/接地/线材问题
//   2. 宽带嘶声（hiss）：>8 kHz 能量占比高、底噪高 → 麦克风自噪或增益过大
//   3. 断点（clicks）：相邻样本差值的离群点多、且集中在帧边界 → 代码丢帧/错位

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde_json::{json, Value};

use crate::audio::MicDsp;

const FFT_SIZE: usize = 4096;
const HOP: usize = 2048;

pub fn run(seconds: f32) -> String {
    let seconds = seconds.clamp(1.0, 30.0);
    let host = cpal::default_host();
    let Some(device) = host.default_input_device() else {
        return json!({ "ok": false, "error": "没有默认输入设备" }).to_string();
    };
    let name = device.to_string();
    let (config, samples) = match record(&device, seconds) {
        Ok(result) => result,
        Err(error) => return json!({ "ok": false, "device": name, "error": error }).to_string(),
    };
    let rate = config.sample_rate as f32;

    let _ = write_wav("mic-diag-raw.wav", &samples, config.sample_rate);

    // 同一段信号过一遍真实 DSP 链，用于对比“处理是否引入额外噪声”。
    let mut dsp = MicDsp::new();
    let mut processed = samples.clone();
    for chunk in processed.chunks_mut(480) {
        if chunk.len() < 480 {
            break;
        }
        dsp.high_pass(chunk, true);
        dsp.gate(chunk, -45.0, 18.0);
        MicDsp::limit(chunk);
    }
    let _ = write_wav("mic-diag-processed.wav", &processed, config.sample_rate);

    let raw = analyze(&samples, rate);
    let after = analyze(&processed, rate);
    let verdict = verdict(&raw);

    json!({
        "ok": true,
        "device": name,
        "sampleRate": config.sample_rate,
        "channels": config.channels,
        "seconds": seconds,
        "raw": raw,
        "processed": after,
        "verdict": verdict,
        "files": ["mic-diag-raw.wav", "mic-diag-processed.wav"],
    })
    .to_string()
}

/// 逐个打开所有输入设备录 1.2 秒，报告哪个设备真的有信号。
/// 用于判断「默认麦克风是静音的」还是「整个采集链路有问题」。
pub fn scan() -> String {
    scan_devices(1.2)
}

pub fn scan_devices(seconds: f32) -> String {
    let host = cpal::default_host();
    let default_name = host.default_input_device().map(|device| device.to_string());
    let mut rows = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for device in devices {
            let name = device.to_string();
            let row = match record(&device, seconds) {
                Ok((config, samples)) => {
                    let peak = samples.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
                    let rms = (samples
                        .iter()
                        .map(|v| (v * v) as f64)
                        .sum::<f64>()
                        / samples.len().max(1) as f64)
                        .sqrt() as f32;
                    json!({
                        "device": name,
                        "default": default_name.as_deref() == Some(name.as_str()),
                        "sampleRate": config.sample_rate,
                        "channels": config.channels,
                        "peakDbfs": round1(db(peak)),
                        "rmsDbfs": round1(db(rms)),
                        "hasSignal": db(rms) > -60.0,
                        "samples": samples.len(),
                    })
                }
                Err(error) => json!({
                    "device": name,
                    "default": default_name.as_deref() == Some(name.as_str()),
                    "error": error,
                    "hasSignal": false,
                }),
            };
            rows.push(row);
        }
    }
    let working: Vec<&str> = rows
        .iter()
        .filter(|row| row["hasSignal"].as_bool().unwrap_or(false))
        .filter_map(|row| row["device"].as_str())
        .collect();
    json!({
        "ok": true,
        "default": default_name,
        "devices": rows,
        "working": working,
        "advice": if working.is_empty() {
            "所有输入设备都没有信号：检查系统隐私设置（允许桌面应用访问麦克风）、耳机上的物理静音开关"
        } else {
            "在设置 → 麦克风里改选上面 hasSignal=true 的设备"
        },
    })
    .to_string()
}

fn record(
    device: &cpal::Device,
    seconds: f32,
) -> Result<(cpal::StreamConfig, Vec<f32>), String> {
    let supported = device
        .default_input_config()
        .map_err(|error| error.to_string())?;
    let config = supported.config();
    let channels = config.channels as usize;
    let format = supported.sample_format();
    let buffer = Arc::new(Mutex::new(Vec::<f32>::with_capacity(
        (config.sample_rate as f32 * seconds) as usize,
    )));
    let done = Arc::new(AtomicBool::new(false));

    let tap = buffer.clone();
    let finish = done.clone();
    let target = (config.sample_rate as f32 * seconds) as usize;
    let push = move |data: Vec<f32>| {
        if let Ok(mut guard) = tap.lock() {
            guard.extend_from_slice(&data);
            if guard.len() >= target {
                finish.store(true, Ordering::Relaxed);
            }
        }
    };

    let build = match format {
        cpal::SampleFormat::F32 => {
            let mut mono = Vec::<f32>::new();
            device.build_input_stream(
                config,
                move |data: &[f32], _| {
                    mono.clear();
                    for frame in data.chunks_exact(channels) {
                        mono.push(frame.iter().sum::<f32>() / channels as f32);
                    }
                    push(mono.clone());
                },
                |_| {},
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut mono = Vec::<f32>::new();
            device.build_input_stream(
                config,
                move |data: &[i16], _| {
                    mono.clear();
                    for frame in data.chunks_exact(channels) {
                        let sum: f32 = frame.iter().map(|v| *v as f32 / 32768.0).sum();
                        mono.push(sum / channels as f32);
                    }
                    push(mono.clone());
                },
                |_| {},
                None,
            )
        }
        _ => return Err("不支持的输入采样格式".to_string()),
    };
    let stream = build.map_err(|error| error.to_string())?;
    stream.play().map_err(|error| error.to_string())?;

    let deadline = Instant::now() + Duration::from_secs_f32(seconds + 2.0);
    while !done.load(Ordering::Relaxed) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    drop(stream);
    let samples = buffer.lock().map(|guard| guard.clone()).unwrap_or_default();
    if samples.is_empty() {
        return Err("没有采集到任何样本（设备被占用或静音）".to_string());
    }
    Ok((config, samples))
}

fn analyze(samples: &[f32], rate: f32) -> Value {
    let count = samples.len();
    let dc = samples.iter().sum::<f32>() / count as f32;
    let peak = samples.iter().fold(0.0f32, |acc, v| acc.max(v.abs()));
    let rms = (samples.iter().map(|v| (v * v) as f64).sum::<f64>() / count as f64).sqrt() as f32;
    let clipped = samples.iter().filter(|v| v.abs() >= 0.999).count();

    // 底噪：按 100ms 分窗求 RMS，取 10% 分位，避免把说话声算成底噪。
    let window = (rate * 0.1) as usize;
    let mut windows: Vec<f32> = samples
        .chunks(window.max(1))
        .filter(|chunk| chunk.len() == window.max(1))
        .map(|chunk| {
            (chunk.iter().map(|v| (v * v) as f64).sum::<f64>() / chunk.len() as f64).sqrt() as f32
        })
        .collect();
    windows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let floor = windows
        .get(windows.len() / 10)
        .copied()
        .unwrap_or(0.0)
        .max(1e-8);
    let median = windows.get(windows.len() / 2).copied().unwrap_or(0.0);

    // 断点检测：相邻样本差值的离群点。真实语音的相邻差分布连续，
    // 丢帧/错位会留下远大于中位数的单点跳变。
    let mut diffs: Vec<f32> = samples.windows(2).map(|pair| (pair[1] - pair[0]).abs()).collect();
    let mut sorted = diffs.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let diff_median = sorted.get(sorted.len() / 2).copied().unwrap_or(0.0);
    let diff_p99 = sorted.get(sorted.len() * 99 / 100).copied().unwrap_or(0.0);
    // 阈值取「p99 的 8 倍」与「中位数的 40 倍」中较大者，且不低于 0.02，
    // 避免安静环境下把正常语音的陡峭起始误判成断点。
    let threshold = (diff_p99 * 8.0).max(diff_median * 40.0).max(0.02);
    let mut clicks = 0usize;
    let mut boundary_hits = 0usize;
    for (index, diff) in diffs.iter_mut().enumerate() {
        if *diff > threshold {
            clicks += 1;
            // 帧边界：常见的 480 样本（10 ms）网格
            if index % 480 < 2 || index % 960 < 2 {
                boundary_hits += 1;
            }
        }
    }

    let spectrum = spectrum_profile(samples, rate);
    json!({
        "dcOffset": round6(dc),
        "peakDbfs": round1(db(peak)),
        "rmsDbfs": round1(db(rms)),
        "floorDbfs": round1(db(floor)),
        "medianDbfs": round1(db(median)),
        "crestDb": round1(db(peak) - db(rms)),
        "clippedSamples": clipped,
        "clickCount": clicks,
        "clickBoundaryHits": boundary_hits,
        "clickThreshold": round6(threshold),
        "humRatio": round6(spectrum.0),
        "humFreq": spectrum.1,
        "highBandRatio": round6(spectrum.2),
        "spectralCentroidHz": round1(spectrum.3),
        "samples": count,
    })
}

fn db(value: f32) -> f32 {
    20.0 * value.max(1e-9).log10()
}

fn round1(value: f32) -> f32 {
    (value * 10.0).round() / 10.0
}

fn round6(value: f32) -> f32 {
    (value * 1e6).round() / 1e6
}

/// 返回 (工频占比, 主导工频, 高频占比, 频谱质心)
fn spectrum_profile(samples: &[f32], rate: f32) -> (f32, f32, f32, f32) {
    let mut planner = rustfft::FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FFT_SIZE);
    let mut accum = vec![0f64; FFT_SIZE / 2];
    let mut windows = 0usize;
    let hop = HOP.min(FFT_SIZE);
    let mut index = 0usize;
    while index + FFT_SIZE <= samples.len() {
        let mut buffer: Vec<rustfft::num_complex::Complex<f32>> = (0..FFT_SIZE)
            .map(|n| {
                let hann = 0.5 - 0.5 * ((2.0 * PI * n as f32) / FFT_SIZE as f32).cos();
                rustfft::num_complex::Complex::new(samples[index + n] * hann, 0.0)
            })
            .collect();
        fft.process(&mut buffer);
        for (bin, value) in buffer.iter().take(FFT_SIZE / 2).enumerate() {
            accum[bin] += (value.norm_sqr()) as f64;
        }
        windows += 1;
        index += hop;
    }
    if windows == 0 {
        return (0.0, 0.0, 0.0, 0.0);
    }
    let bin_hz = rate / FFT_SIZE as f32;
    let total: f64 = accum.iter().skip(1).sum();
    // 整段接近数字静音时，占比没有意义（分母是噪声），直接归零。
    let mean_energy = total / windows as f64;
    if !(mean_energy > 1e-9) {
        return (0.0, 0.0, 0.0, 0.0);
    }

    // 工频带用「不重叠」的区间统计：50/60 Hz 在 11.7 Hz 的分辨率下只差 1 个 bin，
    // 逐频点各取 ±2 bin 会互相覆盖，算出来的占比会超过 1，必须按区间合并。
    let bands: [(f32, f32, &str); 4] = [
        (45.0, 65.0, "50/60"),
        (95.0, 125.0, "100/120"),
        (145.0, 185.0, "150/180"),
        (235.0, 245.0, "240"),
    ];
    let mut hum = 0.0f64;
    let mut hum_peak = 0.0f32;
    let mut hum_peak_energy = 0.0f64;
    for (low, high_freq, _label) in bands {
        let from = (low / bin_hz).floor() as usize;
        let to = ((high_freq / bin_hz).ceil() as usize).min(accum.len() - 1);
        let mut energy = 0.0;
        let mut peak_bin = from;
        for bin in from..=to {
            energy += accum[bin];
            if accum[bin] > accum[peak_bin] {
                peak_bin = bin;
            }
        }
        hum += energy;
        if energy > hum_peak_energy {
            hum_peak_energy = energy;
            // 报频带内的真实峰值频点，而不是频带中点。
            hum_peak = peak_bin as f32 * bin_hz;
        }
    }
    let high_start = ((6000.0 / bin_hz) as usize).min(accum.len() - 1);
    let high: f64 = accum[high_start..].iter().sum();
    let centroid = accum
        .iter()
        .enumerate()
        .map(|(bin, energy)| bin as f64 * bin_hz as f64 * energy)
        .sum::<f64>()
        / total;
    (
        (hum / total) as f32,
        hum_peak,
        (high / total) as f32,
        centroid as f32,
    )
}

fn verdict(raw: &Value) -> Value {
    let hum = raw["humRatio"].as_f64().unwrap_or(0.0);
    let high = raw["highBandRatio"].as_f64().unwrap_or(0.0);
    let floor = raw["floorDbfs"].as_f64().unwrap_or(-90.0);
    let clicks = raw["clickCount"].as_u64().unwrap_or(0);
    let boundary = raw["clickBoundaryHits"].as_u64().unwrap_or(0);
    let clipped = raw["clippedSamples"].as_u64().unwrap_or(0);
    let seconds = raw["samples"].as_f64().unwrap_or(1.0) / 48000.0;

    let median = raw["medianDbfs"].as_f64().unwrap_or(-90.0);
    let rms = raw["rmsDbfs"].as_f64().unwrap_or(-90.0);
    // 「典型电平」才是判断有没有声音的依据：单个瞬态会把 peak 抬起来，
    // 但整段中位数仍是数字静音，此时任何频谱占比都是噪声除以噪声。
    if median < -70.0 || rms < -60.0 {
        return json!({
            "conclusion": "采集期间几乎没有持续信号",
            "findings": [
                format!("典型电平 {median:.0} dBFS、整体 RMS {rms:.0} dBFS：麦克风被系统静音/禁用、选错设备，或录制时没有发声")
            ],
            "advice": "在 Windows 声音设置里确认该麦克风未静音、输入音量 100%，录音期间保持正常音量说话再跑一次",
        });
    }

    let mut findings: Vec<&str> = Vec::new();
    if hum > 0.05 {
        findings.push("工频哼声偏强：检查供电/接地、换 USB 口或加屏蔽线");
    }
    if high > 0.25 {
        findings.push("高频嘶声偏强：麦克风自噪或增益过大，先降增益再加降噪");
    }
    if floor > -55.0 {
        findings.push("静音段底噪偏高（>-55 dBFS）：环境噪声或设备自噪明显");
    }
    if clipped > 0 {
        findings.push("存在削波样本：输入增益过高，需下调");
    }
    if boundary > 0 && boundary * 3 > clicks {
        findings.push("断点集中在 10ms 帧边界：采集链路在丢帧/错位，属于代码问题");
    } else if clicks > 20 {
        findings.push("存在较多瞬时断点：可能是缓冲欠载或设备中断");
    }
    if clicks == 0 && hum < 0.02 && high < 0.15 && floor < -60.0 {
        findings.push("未发现明显电学或链路问题，原始信号干净");
    }
    if seconds < 1.0 {
        findings.push("录音时长不足 1 秒，指标仅供参考");
    }
    json!({
        "conclusion": if findings.is_empty() { "未触发任何告警" } else { "见 findings" },
        "findings": findings,
        "advice": "把 mic-diag-raw.wav 放进 Audacity 看频谱：50/60Hz 竖线=工频哼声，全频抬高=嘶声，等距竖线=断点",
    })
}

/// 16-bit PCM 单声道 WAV。
fn write_wav(path: &str, samples: &[f32], rate: u32) -> Result<(), String> {
    use std::io::Write;
    let data_len = samples.len() * 2;
    let mut file = std::fs::File::create(path).map_err(|error| error.to_string())?;
    let header = |chunk: &mut Vec<u8>, value: u32| chunk.extend_from_slice(&value.to_le_bytes());
    let mut out: Vec<u8> = Vec::with_capacity(44 + data_len);
    out.extend_from_slice(b"RIFF");
    header(&mut out, 36 + data_len as u32);
    out.extend_from_slice(b"WAVEfmt ");
    header(&mut out, 16);
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    header(&mut out, rate);
    header(&mut out, rate * 2); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    header(&mut out, data_len as u32);
    for sample in samples {
        let value = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend_from_slice(&value.to_le_bytes());
    }
    file.write_all(&out).map_err(|error| error.to_string())
}


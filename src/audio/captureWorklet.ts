// 采集侧 AudioWorklet 的唯一实现。
//
// 真实语音链路（useVoice）与设置页的「本地测试 / 自听」都从这里取，
// 保证「你听到的」= 「别人听到的」。之前测试走的是另一条裸链路，导致
// 关掉降噪后听到的底噪与实际发送完全不是一回事。
//
// DSP 顺序（与 Rust 侧 MicDsp 一致）：
//   80 Hz 一阶高通 → 电平测量 → 噪声门（软衰减）→ 软限幅
export const CAPTURE_WORKLET_SOURCE = `
class RaySpeakCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = (options && options.processorOptions) || {};
    this.frameSize = config.frameSize || 960;
    this.channels = Math.max(1, Math.min(2, config.channels || 1));
    this.buffers = [];
    for (let c = 0; c < this.channels; c += 1) this.buffers.push(new Float32Array(this.frameSize));
    this.offset = 0;
    this.timestamp = 0;
    // 监听输出队列：DSP 按整帧处理，输出按渲染块取用，最多落后一帧。
    this.outputQueue = [];
    this.ready = null;
    this.readyFrames = 0;
    this.readyChannels = 1;
    this.readyOffset = 0;
    const rc = 1 / (2 * Math.PI * 80);
    this.hpAlpha = rc / (rc + 1 / sampleRate);
    this.hpX = new Float32Array(this.channels);
    this.hpY = new Float32Array(this.channels);
    this.highPass = config.highPass !== false;
    this.gateEnabled = !!config.gateEnabled;
    this.gateThresholdDb = typeof config.gateThresholdDb === 'number' ? config.gateThresholdDb : -45;
    this.gateDepthDb = typeof config.gateDepthDb === 'number' ? config.gateDepthDb : 18;
    this.gateGain = 1;
    this.port.onmessage = (event) => {
      const message = event.data || {};
      if (message.type !== 'params') return;
      if (typeof message.highPass === 'boolean') this.highPass = message.highPass;
      if (typeof message.gateEnabled === 'boolean') this.gateEnabled = message.gateEnabled;
      if (typeof message.gateThresholdDb === 'number') this.gateThresholdDb = message.gateThresholdDb;
      if (typeof message.gateDepthDb === 'number') this.gateDepthDb = message.gateDepthDb;
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    if (input && input[0]) {
      const length = input[0].length;
      let read = 0;
      while (read < length) {
        const write = Math.min(length - read, this.frameSize - this.offset);
        for (let c = 0; c < this.channels; c += 1) {
          const source = input[Math.min(c, input.length - 1)];
          this.buffers[c].set(source.subarray(read, read + write), this.offset);
        }
        this.offset += write;
        read += write;
        if (this.offset >= this.frameSize) {
          this.emit();
          this.offset = 0;
        }
      }
    }
    // 必须把处理后的样本写回 outputs，否则 node.connect(destination) 是静音，
    // 自听（本地监听）就完全没有声音。
    this.render(outputs && outputs[0]);
    return true;
  }
  render(output) {
    if (!output || output.length === 0) return;
    const length = output[0].length;
    for (let i = 0; i < length; i += 1) {
      if (!this.ready || this.readyOffset >= this.readyFrames) {
        const next = this.outputQueue.shift();
        this.ready = next ? next.data : null;
        this.readyFrames = next ? next.frames : 0;
        this.readyChannels = next ? next.channels : 1;
        this.readyOffset = 0;
      }
      for (let c = 0; c < output.length; c += 1) {
        output[c][i] = this.ready
          ? this.ready[this.readyOffset * this.readyChannels + Math.min(c, this.readyChannels - 1)]
          : 0;
      }
      if (this.ready) this.readyOffset += 1;
    }
  }
  emit() {
    const frames = this.frameSize;
    const channels = this.channels;
    if (this.highPass) {
      for (let c = 0; c < channels; c += 1) {
        const buffer = this.buffers[c];
        let x = this.hpX[c];
        let y = this.hpY[c];
        for (let i = 0; i < frames; i += 1) {
          const input = buffer[i];
          y = this.hpAlpha * (y + input - x);
          x = input;
          buffer[i] = y;
        }
        this.hpX[c] = x;
        this.hpY[c] = y;
      }
    }
    let energy = 0;
    const mono = this.buffers[0];
    for (let i = 0; i < frames; i += 1) energy += mono[i] * mono[i];
    const level = Math.sqrt(energy / frames);
    const levelDb = 20 * Math.log10(Math.max(level, 1e-6));
    if (this.gateEnabled) {
      const target = levelDb >= this.gateThresholdDb ? 1 : Math.pow(10, -Math.abs(this.gateDepthDb) / 20);
      const coefficient = target > this.gateGain ? 0.7 : 0.15;
      const start = this.gateGain;
      this.gateGain += (target - this.gateGain) * coefficient;
      const step = (this.gateGain - start) / frames;
      let gain = start;
      for (let i = 0; i < frames; i += 1) {
        gain += step;
        for (let c = 0; c < channels; c += 1) this.buffers[c][i] *= gain;
      }
    }
    for (let c = 0; c < channels; c += 1) {
      const buffer = this.buffers[c];
      for (let i = 0; i < frames; i += 1) {
        const value = buffer[i];
        const magnitude = Math.abs(value);
        if (magnitude > 0.7) {
          buffer[i] = Math.sign(value) * (0.7 + 0.3 * Math.tanh((magnitude - 0.7) / 0.3));
        }
      }
    }
    const data = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) data[i * channels + c] = this.buffers[c][i];
    }
    // data 留给监听输出，发送侧用副本（transfer 会让原缓冲 detach）。
    const posted = new Float32Array(data);
    this.port.postMessage(
      {
        frame: posted.buffer,
        frames: frames,
        channels: channels,
        level: level,
        levelDb: levelDb,
        timestamp: this.timestamp,
      },
      [posted.buffer],
    );
    this.outputQueue.push({ data: data, frames: frames, channels: channels });
    if (this.outputQueue.length > 6) this.outputQueue.shift();
    this.timestamp += Math.round((frames / sampleRate) * 1000000);
  }
}
registerProcessor('rayspeak-capture', RaySpeakCapture);
`

export const CAPTURE_PROCESSOR = 'rayspeak-capture'

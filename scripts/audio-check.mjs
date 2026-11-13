// 采集侧 DSP 的离线自检：从 src/useVoice.ts 里抽出 AudioWorklet 源码，
// 在 Node 里用正弦/阶跃信号跑一遍，断言高通、噪声门、软限幅的行为。
//
// 这三段 DSP 跑在 WebView 的音频线程里，TypeScript 类型检查和单元测试都覆盖不到，
// 只能这样抽出来跑。`npm run audio:check` 可直接执行，退出码非 0 表示有断言失败。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(path.join(root, 'src/audio/captureWorklet.ts'), 'utf8')

function extractWorklet(text) {
  const head = 'export const CAPTURE_WORKLET_SOURCE = `'
  const start = text.indexOf(head)
  if (start < 0) throw new Error('未找到 CAPTURE_WORKLET_SOURCE')
  const bodyStart = start + head.length
  const tail = text.indexOf("registerProcessor('rayspeak-capture'", bodyStart)
  if (tail < 0) throw new Error('未找到 registerProcessor')
  const end = text.indexOf('`', tail)
  if (end < 0) throw new Error('CAPTURE_WORKLET_SOURCE 未闭合')
  return text.slice(bodyStart, end)
}

let Processor = null
globalThis.sampleRate = 48000
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      postMessage: (message) => globalThis.__frames.push(message),
      onmessage: null,
    }
  }
}
globalThis.registerProcessor = (_name, cls) => {
  Processor = cls
}
globalThis.__frames = []
new Function(extractWorklet(source))()
if (!Processor) throw new Error('worklet 未注册 processor')

const create = (options) =>
  new Processor({
    processorOptions: { frameSize: 480, channels: 1, ...options },
  })

let phase = 0
function feed(processor, amplitude, blocks, frequency = 440) {
  for (let block = 0; block < blocks; block += 1) {
    const chunk = new Float32Array(128)
    for (let index = 0; index < 128; index += 1) {
      chunk[index] = amplitude * Math.sin(phase)
      phase += (2 * Math.PI * frequency) / 48000
    }
    processor.process([[chunk]])
  }
}

const peak = (buffer) => buffer.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
const lastFrame = () => new Float32Array(globalThis.__frames.at(-1).frame)

const checks = []
function check(name, passed, detail) {
  checks.push({ name, passed, detail })
}

// 1) 噪声门：-58 dBFS 底噪应被压暗 18 dB（稳态）
{
  const processor = create({
    highPass: true,
    gateEnabled: true,
    gateThresholdDb: -45,
    gateDepthDb: 18,
  })
  phase = 0
  feed(processor, 0.0012, 320)
  const ratio = peak(lastFrame()) / 0.0012
  check(
    '噪声门把 -58 dBFS 底噪压暗 18 dB',
    ratio > 0.09 && ratio < 0.18,
    `输出/输入 = ${ratio.toFixed(3)}（期望 0.126）`,
  )
}

// 2) 人声越过阈值：门必须放行，且不改变电平
{
  const processor = create({
    highPass: false,
    gateEnabled: true,
    gateThresholdDb: -45,
    gateDepthDb: 18,
  })
  phase = 0
  feed(processor, 0.2, 80)
  const ratio = peak(lastFrame()) / 0.2
  check('人声越过阈值时门放行', ratio > 0.95 && ratio < 1.05, `输出/输入 = ${ratio.toFixed(3)}`)
}

// 3) 关闭噪声门：底噪原样通过
{
  const processor = create({
    highPass: false,
    gateEnabled: false,
    gateThresholdDb: -45,
    gateDepthDb: 18,
  })
  phase = 0
  feed(processor, 0.0012, 80)
  const ratio = peak(lastFrame()) / 0.0012
  check('关闭噪声门时直通', ratio > 0.95, `输出/输入 = ${ratio.toFixed(3)}`)
}

// 4) 软限幅：2.4 倍过载也不能超过 1.0
{
  const processor = create({ highPass: false, gateEnabled: false })
  phase = 0
  feed(processor, 2.4, 20)
  const value = peak(lastFrame())
  check('2.4 倍过载被软限幅在 1.0 以内', value <= 1.0001, `峰值 = ${value.toFixed(3)}`)
}

// 5) 高通：50 Hz 衰减明显，1 kHz 基本无损
{
  const measure = (frequency) => {
    const processor = create({ highPass: true, gateEnabled: false })
    phase = 0
    feed(processor, 0.3, 80, frequency)
    return peak(lastFrame()) / 0.3
  }
  const low = measure(50)
  const high = measure(1000)
  check('高通压制 50 Hz 低频', low < 0.7, `50 Hz 残余 = ${low.toFixed(3)}`)
  check('高通不损伤 1 kHz 人声', high > 0.9, `1 kHz 通过 = ${high.toFixed(3)}`)
}

// 6) 参数热更新：port 消息能关闭噪声门
{
  const processor = create({
    highPass: false,
    gateEnabled: true,
    gateThresholdDb: -45,
    gateDepthDb: 24,
  })
  phase = 0
  feed(processor, 0.0012, 120)
  const gatedRatio = peak(lastFrame()) / 0.0012
  processor.port.onmessage({ data: { type: 'params', gateEnabled: false } })
  phase = 0
  feed(processor, 0.0012, 40)
  const openRatio = peak(lastFrame()) / 0.0012
  check(
    '参数热更新生效（关门 → 开门）',
    gatedRatio < 0.15 && openRatio > 0.95,
    `门内 ${gatedRatio.toFixed(3)} → 门外 ${openRatio.toFixed(3)}`,
  )
}

// 7) 自听输出：worklet 必须把处理后的样本写回 outputs，
//    否则 node.connect(destination) 是静音（本地监听「不可用」的根因）。
{
  const processor = create({ highPass: false, gateEnabled: false })
  phase = 0
  let lastOut = new Float32Array(128)
  for (let block = 0; block < 40; block += 1) {
    const chunk = new Float32Array(128)
    for (let index = 0; index < 128; index += 1) {
      chunk[index] = 0.2 * Math.sin(phase)
      phase += (2 * Math.PI * 440) / 48000
    }
    const output = [new Float32Array(128)]
    processor.process([[chunk]], [output])
    lastOut = output[0]
  }
  const value = peak(lastOut)
  check('自听（监听）输出有信号', value > 0.15, `监听峰值 = ${value.toFixed(3)}`)
}

const failed = checks.filter((item) => !item.passed)
for (const item of checks) {
  console.log(`${item.passed ? '  ok  ' : ' fail '} ${item.name}  ${item.detail}`)
}
console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
if (failed.length) {
  console.error('\n采集侧 DSP 自检失败')
  process.exit(1)
}

import { useEffect, useRef } from 'react'
import type { Client } from './types'
import { protocol, type VoiceEvent } from './protocol'
import { autoVadThreshold } from './settings'
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from './audio/captureWorklet'

function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step))
  }
  return btoa(binary)
}

function base64ToBytes(text: string) {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index)
  return bytes
}



export interface VoiceAudioConfig {
  inputDevice: string
  outputDevice: string
  inputVolume: number
  outputVolume: number
  echoCancel: boolean
  noiseSuppressor: 'off' | 'gate' | 'chromium' | 'speex' | 'rnnoise'
  highPass: boolean
  gateDepth: number
  autoGain: boolean
  inputMode: 'vad' | 'ptt' | 'open'
  inputSensitivity: 'auto' | 'manual'
  noiseFloorDb: number
  voiceHoldMs: number
  vadThreshold: number
  pttHeld: boolean
  musicMode: boolean
  bitrate: number
  frameSize: number
  stereo: boolean
  jitterBuffer: number
  latencyMode: 'low' | 'balanced' | 'stable'
  nativeMic: boolean
}

interface OpusEncoderOptions {
  signal?: 'auto' | 'voice' | 'music'
  application?: 'voip' | 'audio' | 'lowdelay'
  frameDuration?: number
  complexity?: number
  packetlossperc?: number
  useinbandfec?: boolean
  usedtx?: boolean
}

type RayAudioEncoderConfig = AudioEncoderConfig & { opus?: OpusEncoderOptions }

interface Options {
  enabled: boolean
  muted: boolean
  deafened: boolean
  clients: Client[]
  audio: VoiceAudioConfig
  captureKey: string
  onTalking: (clid: number, talking: boolean) => void
  onSelfTalking: (talking: boolean) => void
  onAudioError?: (message: string) => void
}

interface CapturedFrame {
  frame: ArrayBuffer
  frames: number
  channels: number
  timestamp: number
}

interface PendingSource {
  node: AudioBufferSourceNode
  startAt: number
}

interface PendingPacket {
  data: string
  arrival: number
}

interface Receiver {
  clid: number
  decoder: AudioDecoder
  channels: number
  scheduled: number
  expectedGap: number
  jitter: number
  lastArrival: number
  lastTimestamp: number
  pending: Set<PendingSource>
  pendingPackets: Map<number, PendingPacket>
  nextPacketId: number | null
  gapTimer: number | undefined
  lastPlanes: Float32Array[] | null
  lastRate: number
  fadePending: boolean
  lastAccept: number
}

interface PlaybackEnvelope {
  fadeIn?: number
  fadeOut?: number
  gain?: number
}

const OPUS_VOICE_CODEC = 4
const OPUS_MUSIC_CODEC = 5
const MIN_HOLD_US = 100_000
const MAX_PREROLL_MS = 120
const PACKET_ID_MASK = 0xffff
const MAX_BUFFERED_PACKETS = 32

function levelToDb(level: number) {
  return 20 * Math.log10(Math.max(level, 1e-6))
}

/**
 * WebView 链路能做的降噪只有 Chromium 内置与噪声门；
 * 选中需要原生采集的降噪器时退回噪声门，避免「选了却没效果」。
 */
function webviewSuppressor(suppressor: VoiceAudioConfig['noiseSuppressor']) {
  return suppressor === 'speex' || suppressor === 'rnnoise' ? 'gate' : suppressor
}

/**
 * 环境底噪跟踪：下降快、回升慢的 min-tracker。说话期间只允许底噪下降，
 * 否则人声会把底噪抬高，自动阈值随后一路爬升，最后听不到自己说话。
 */
function nextNoiseFloor(floor: number, db: number, gateOpen: boolean) {
  if (!Number.isFinite(db) || db < -89) return floor
  if (gateOpen) return db < floor ? floor + (db - floor) * 0.002 : floor
  return db < floor ? floor + (db - floor) * 0.3 : floor + (db - floor) * 0.002
}


function packetIdDiff(a: number, b: number) {
  return (((a - b + 0x8000) & PACKET_ID_MASK) - 0x8000)
}

function reorderWindow(audio: VoiceAudioConfig) {
  return audio.latencyMode === 'low' ? 30 : audio.latencyMode === 'stable' ? 100 : 60
}

function isOpusCodec(codec: number) {
  return codec === OPUS_VOICE_CODEC || codec === OPUS_MUSIC_CODEC
}

function encoderConfig(audio: VoiceAudioConfig): RayAudioEncoderConfig {
  const channels = audio.stereo || audio.musicMode ? 2 : 1
  return {
    codec: 'opus',
    sampleRate: 48000,
    numberOfChannels: channels,
    bitrate: Math.max(8000, Math.round(audio.bitrate * 1000)),
    opus: {
      signal: audio.musicMode ? 'music' : 'voice',
      application: audio.musicMode ? 'audio' : 'voip',
      frameDuration: Math.max(2500, Math.round(audio.frameSize * 1000)),
      complexity: 10,
      packetlossperc: 5,
      useinbandfec: true,
      usedtx: false,
    },
  }
}

// 旧版 WebView2 可能不认 opus 调优参数，失败时退回最小配置。
function configureEncoder(encoder: AudioEncoder, audio: VoiceAudioConfig) {
  const full = encoderConfig(audio)
  try {
    encoder.configure(full)
    return true
  } catch {
    try {
      encoder.configure({
        codec: full.codec,
        sampleRate: full.sampleRate,
        numberOfChannels: full.numberOfChannels,
        bitrate: full.bitrate,
      })
      return true
    } catch {
      return false
    }
  }
}

function playbackTarget(audio: VoiceAudioConfig, jitterMs: number) {
  const mode = audio.latencyMode === 'low' ? 0.6 : audio.latencyMode === 'stable' ? 1.6 : 1
  const base = Math.max(20, audio.jitterBuffer) * mode
  const ms = Math.min(420, Math.max(30, base + jitterMs * 2.5))
  return ms / 1000
}

export function useVoice({
  enabled,
  muted,
  deafened,
  clients,
  audio,
  captureKey,
  onTalking,
  onSelfTalking,
  onAudioError,
}: Options) {
  const audioRef = useRef(audio)
  audioRef.current = audio
  const mutedRef = useRef(muted)
  mutedRef.current = muted
  const deafenedRef = useRef(deafened)
  deafenedRef.current = deafened
  const gainsRef = useRef(new Map<number, GainNode>())
  const streamRef = useRef<MediaStream | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const masterRef = useRef<GainNode | null>(null)
  const captureGainRef = useRef<GainNode | null>(null)
  const encoderRef = useRef<AudioEncoder | null>(null)
  const receiversRef = useRef(new Map<number, Receiver>())
  const prerollRef = useRef<CapturedFrame[]>([])
  const gateUntilRef = useRef(0)
  const wasOpenRef = useRef(false)
  const unsupportedCodecRef = useRef(false)
  const lastLevelRef = useRef(0)
  const noiseFloorRef = useRef(-60)
  const paramsSignatureRef = useRef('')
  const lastVoiceRef = useRef(new Map<number, number>())
  const talkingRef = useRef(new Set<number>())
  const selfTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const context = contextRef.current
    const master = masterRef.current
    if (!context) return
    if (master) {
      master.gain.setTargetAtTime(
        Math.max(0, Math.min(1, audio.outputVolume / 100)),
        context.currentTime,
        0.03,
      )
    }
    for (const client of clients) {
      if (!client.clid) continue
      const gain = gainsRef.current.get(client.clid)
      if (!gain) continue
      const value =
        deafened || client.localMuted ? 0 : Math.max(0, Math.min(2, client.volume / 100))
      gain.gain.setTargetAtTime(value, context.currentTime, 0.03)
    }
  }, [clients, deafened, audio.outputVolume])

  useEffect(() => {
    const context = contextRef.current as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    if (!context?.setSinkId) return
    void context.setSinkId(audio.outputDevice || '').catch(() => {})
  }, [audio.outputDevice])

  useEffect(() => {
    const context = contextRef.current
    const gain = captureGainRef.current
    if (!context || !gain) return
    gain.gain.setTargetAtTime(
      Math.max(0, Math.min(2, audio.inputVolume / 100)),
      context.currentTime,
      0.03,
    )
  }, [audio.inputVolume])

  useEffect(() => {
    const encoder = encoderRef.current
    if (!encoder || encoder.state !== 'configured') return
    configureEncoder(encoder, audioRef.current)
  }, [audio.bitrate, audio.stereo, audio.musicMode])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let decoderTimer: number | undefined
    let context: AudioContext | null = null
    let captureNode: AudioWorkletNode | null = null
    const config = audioRef.current
    const sendCodec = config.musicMode ? OPUS_MUSIC_CODEC : OPUS_VOICE_CODEC

    let handleDecoded: (receiver: Receiver, audioData: AudioData, ctx: AudioContext) => void

    const teardown = () => {
      disposed = true
      if (decoderTimer) window.clearInterval(decoderTimer)
      if (selfTimerRef.current) window.clearTimeout(selfTimerRef.current)
      captureNode?.port.close()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      for (const receiver of receiversRef.current.values()) {
        if (receiver.gapTimer) window.clearTimeout(receiver.gapTimer)
        for (const pending of receiver.pending) {
          try {
            pending.node.stop()
          } catch {
            /* already stopped */
          }
        }
        try {
          receiver.decoder.close()
        } catch {
          /* already closed */
        }
      }
      receiversRef.current.clear()
      gainsRef.current.clear()
      lastVoiceRef.current.clear()
      talkingRef.current.clear()
      prerollRef.current = []
      wasOpenRef.current = false
      gateUntilRef.current = 0
      paramsSignatureRef.current = ''
      encoderRef.current = null
      masterRef.current = null
      captureGainRef.current = null
      if (context) void context.close()
      contextRef.current = null
      void protocol.setVoiceEnabled(false).catch(() => {})
      onSelfTalking(false)
    }

    const requestMic = async () => {
      const base: MediaTrackConstraints = {
        channelCount: config.stereo || config.musicMode ? 2 : 1,
        echoCancellation: config.echoCancel,
        // 只有选中「智能降噪」时才让 Chromium 介入；噪声门与原生降噪器自己处理频谱。
        noiseSuppression: config.noiseSuppressor === 'chromium',
        autoGainControl: config.autoGain,
      }
      if (config.inputDevice) {
        try {
          return await navigator.mediaDevices.getUserMedia({
            audio: { ...base, deviceId: { exact: config.inputDevice } },
            video: false,
          })
        } catch {
          /* fall back to the system default device */
        }
      }
      return navigator.mediaDevices.getUserMedia({ audio: base, video: false })
    }

    const start = async () => {
      unsupportedCodecRef.current = false
      // 上次校准的底噪作为本次自动灵敏度的起点，避免刚连上就误开。
      noiseFloorRef.current = Math.max(-90, Math.min(-20, config.noiseFloorDb || -60))
      try {
        context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      } catch {
        context = new AudioContext({ latencyHint: 'interactive' })
      }
      contextRef.current = context
      if (context.state === 'suspended') {
        await context.resume().catch(() => {})
      }
      const sink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
      if (sink.setSinkId) {
        await sink.setSinkId(config.outputDevice || '').catch(() => {})
      }
      const master = context.createGain()
      master.gain.value = Math.max(0, Math.min(1, config.outputVolume / 100))
      master.connect(context.destination)
      masterRef.current = master

      if (config.nativeMic) {
        // 原生采集在 Rust 侧完成并直接发包，这里只保留播放解码链路。
      } else if (typeof AudioEncoder === 'undefined') {
        onAudioError?.('当前系统不支持 WebCodecs Opus 编码，只能接收语音')
      } else {
        try {
          const encoder = new AudioEncoder({
            output: (chunk) => {
              if (mutedRef.current || disposed) return
              const buffer = new Uint8Array(chunk.byteLength)
              chunk.copyTo(buffer)
              void protocol.sendVoiceData(bytesToBase64(buffer), sendCodec).catch(() => {})
            },
            error: () => onAudioError?.('Opus 编码器不可用，语音发送已停止'),
          })
          if (configureEncoder(encoder, config)) encoderRef.current = encoder
          else onAudioError?.('无法初始化 Opus 编码器')
        } catch {
          onAudioError?.('无法初始化 Opus 编码器')
        }
      }

      const encodeFrame = (frame: CapturedFrame, fadeIn = 0, fadeOut = 0) => {
        const encoder = encoderRef.current
        if (!encoder || encoder.state !== 'configured' || mutedRef.current || disposed) return
        try {
          const rate = context?.sampleRate ?? 48000
          const inSamples = Math.min(frame.frames, Math.round(fadeIn * rate))
          const outSamples = Math.min(frame.frames, Math.round(fadeOut * rate))
          let data: ArrayBuffer | ArrayBufferView = frame.frame
          if (inSamples > 0 || outSamples > 0) {
            // 包络必须写回真正送给编码器的缓冲，否则起停爆音照旧。
            const samples = new Float32Array(frame.frames * frame.channels)
            samples.set(new Float32Array(frame.frame))
            for (let i = 0; i < frame.frames; i += 1) {
              let envelope = 1
              if (inSamples > 0 && i < inSamples) envelope *= i / inSamples
              if (outSamples > 0 && i >= frame.frames - outSamples) {
                envelope *= (frame.frames - i - 1) / outSamples
              }
              if (envelope === 1) continue
              for (let channel = 0; channel < frame.channels; channel += 1) {
                samples[i * frame.channels + channel] *= envelope
              }
            }
            data = samples.buffer
          }
          const audioData = new AudioData({
            format: 'f32',
            sampleRate: rate,
            numberOfFrames: frame.frames,
            numberOfChannels: frame.channels,
            timestamp: frame.timestamp,
            data,
          })
          encoder.encode(audioData)
          audioData.close()
        } catch {
          /* encoder hiccup */
        }
      }

      if (!config.nativeMic)
        try {
          const stream = await requestMic()
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const moduleUrl = URL.createObjectURL(
          new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }),
        )
        await context.audioWorklet.addModule(moduleUrl)
        URL.revokeObjectURL(moduleUrl)
        const source = context.createMediaStreamSource(stream)
        const captureGain = context.createGain()
        captureGain.gain.value = Math.max(0, Math.min(2, config.inputVolume / 100))
        captureGainRef.current = captureGain
        captureNode = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
          processorOptions: {
            frameSize: Math.max(
              128,
              Math.round(((context.sampleRate || 48000) * config.frameSize) / 1000),
            ),
            channels: config.stereo || config.musicMode ? 2 : 1,
            highPass: config.highPass,
            gateEnabled: webviewSuppressor(config.noiseSuppressor) === 'gate',
            gateThresholdDb:
              config.inputSensitivity === 'auto'
                ? autoVadThreshold(config.noiseFloorDb)
                : config.vadThreshold,
            gateDepthDb: Math.max(0, Math.min(40, config.gateDepth)),
          },
        })
        const silentSink = context.createGain()
        silentSink.gain.value = 0
        source.connect(captureGain)
        captureGain.connect(captureNode)
        captureNode.connect(silentSink)
        silentSink.connect(context.destination)

        captureNode.port.onmessage = (event: MessageEvent) => {
          if (disposed) return
          const payload = event.data as {
            frame: ArrayBuffer
            frames: number
            channels: number
            level: number
            timestamp: number
          }
          lastLevelRef.current = payload.level
          const current = audioRef.current
          const levelDb = levelToDb(payload.level)
          // 底噪跟踪只参考「门控关闭」的帧，说话时不让阈值跟着人声爬升。
          noiseFloorRef.current = nextNoiseFloor(
            noiseFloorRef.current,
            levelDb,
            wasOpenRef.current,
          )
          const thresholdDb =
            current.inputSensitivity === 'auto'
              ? autoVadThreshold(noiseFloorRef.current)
              : current.vadThreshold

          // 高通 / 噪声门参数随设置与自动阈值实时下推到音频线程，
          // 阈值取整后再比较，避免每帧都发消息。
          const desiredHighPass = current.highPass
          const desiredGate = webviewSuppressor(current.noiseSuppressor) === 'gate'
          const desiredThreshold = Math.round(thresholdDb)
          const desiredDepth = Math.max(0, Math.min(40, current.gateDepth))
          const signature = `${desiredHighPass}|${desiredGate}|${desiredThreshold}|${desiredDepth}`
          if (signature !== paramsSignatureRef.current) {
            paramsSignatureRef.current = signature
            captureNode?.port.postMessage({
              type: 'params',
              highPass: desiredHighPass,
              gateEnabled: desiredGate,
              gateThresholdDb: desiredThreshold,
              gateDepthDb: desiredDepth,
            })
          }

          window.dispatchEvent(
            new CustomEvent('rayspeak:level', {
              detail: {
                level: payload.level,
                db: levelDb,
                floorDb: noiseFloorRef.current,
                thresholdDb,
                auto: current.inputSensitivity === 'auto',
              },
            }),
          )
          if (payload.level >= Math.pow(10, thresholdDb / 20)) {
            gateUntilRef.current = payload.timestamp + Math.max(MIN_HOLD_US, current.voiceHoldMs * 1000)
          }
          const gateOpen =
            current.inputMode === 'open'
              ? true
              : current.inputMode === 'ptt'
                ? current.pttHeld
                : payload.timestamp < gateUntilRef.current

          const frame: CapturedFrame = {
            frame: payload.frame,
            frames: payload.frames,
            channels: payload.channels,
            timestamp: payload.timestamp,
          }
          if (gateOpen) {
            if (!wasOpenRef.current) {
              let fading = true
              for (const buffered of prerollRef.current) {
                encodeFrame(buffered, fading ? 0.012 : 0)
                fading = false
              }
              encodeFrame(frame, fading ? 0.012 : 0)
            } else {
              encodeFrame(frame)
            }
            prerollRef.current = []
          } else {
            if (wasOpenRef.current) {
              encodeFrame(frame, 0, 0.012)
              prerollRef.current = []
            } else {
              prerollRef.current.push(frame)
            }
            const keep = Math.max(1, Math.ceil(MAX_PREROLL_MS / Math.max(1, current.frameSize)))
            while (prerollRef.current.length > keep) prerollRef.current.shift()
          }
          wasOpenRef.current = gateOpen

          if (!mutedRef.current && gateOpen && payload.level > 0.004) {
            onSelfTalking(true)
            if (selfTimerRef.current) window.clearTimeout(selfTimerRef.current)
            selfTimerRef.current = window.setTimeout(() => onSelfTalking(false), 420)
          }
        }
      } catch {
        onAudioError?.('无法访问麦克风，请检查设备与系统权限')
      }

      void protocol.setVoiceEnabled(true).catch(() => {})

      decoderTimer = window.setInterval(() => {
        const now = performance.now()
        for (const [clid, stamp] of lastVoiceRef.current) {
          const active = now - stamp < 650
          if (active && !talkingRef.current.has(clid)) {
            talkingRef.current.add(clid)
            onTalking(clid, true)
          } else if (!active && talkingRef.current.has(clid)) {
            talkingRef.current.delete(clid)
            onTalking(clid, false)
          }
        }
      }, 220)
    }

    const enqueueBuffer = (
      receiver: Receiver,
      planes: Float32Array[],
      rate: number,
      ctx: AudioContext,
      envelope?: PlaybackEnvelope,
    ) => {
      const channels = planes.length
      if (!channels) return
      const frames = planes[0].length
      if (!frames) return
      const now = ctx.currentTime
      const target = playbackTarget(audioRef.current, receiver.jitter)
      if (receiver.scheduled > 0 && receiver.scheduled - now > Math.max(target * 2.5, 0.3)) {
        for (const pending of receiver.pending) {
          if (pending.startAt > now) {
            try {
              pending.node.stop()
            } catch {
              /* already stopped */
            }
            receiver.pending.delete(pending)
          }
        }
        receiver.scheduled = 0
      }
      const continuous = receiver.scheduled > now
      // 起播/重同步时加一个很短的淡入，避免从任意波形突然开始产生爆音。
      const fadeIn = Math.min(frames, Math.round(Math.max(envelope?.fadeIn ?? 0, continuous ? 0 : 0.008) * rate))
      const fadeOut = Math.min(frames, Math.round((envelope?.fadeOut ?? 0) * rate))
      const level = envelope?.gain ?? 1
      const audioBuffer = ctx.createBuffer(channels, frames, rate)
      for (let channel = 0; channel < channels; channel += 1) {
        const source = planes[channel]
        const targetChannel = audioBuffer.getChannelData(channel)
        if (level === 1 && fadeIn === 0 && fadeOut === 0) {
          targetChannel.set(source)
          continue
        }
        for (let i = 0; i < frames; i += 1) {
          let value = source[i] * level
          if (fadeIn > 0 && i < fadeIn) value *= i / fadeIn
          if (fadeOut > 0 && i >= frames - fadeOut) value *= (frames - i - 1) / fadeOut
          targetChannel[i] = value
        }
      }
      let gain = gainsRef.current.get(receiver.clid)
      if (!gain) {
        gain = ctx.createGain()
        gain.connect(masterRef.current ?? ctx.destination)
        gainsRef.current.set(receiver.clid, gain)
      }
      const startAt = continuous ? receiver.scheduled : now + target
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.connect(gain)
      const entry: PendingSource = { node: source, startAt }
      receiver.pending.add(entry)
      source.onended = () => receiver.pending.delete(entry)
      source.start(startAt)
      receiver.scheduled = startAt + audioBuffer.duration
    }

    handleDecoded = (receiver, audioData, ctx) => {
      if (disposed) {
        audioData.close()
        return
      }
      const sampleRate = audioData.sampleRate || 48000
      const frames = audioData.numberOfFrames
      const channels = Math.max(1, audioData.numberOfChannels || receiver.channels)
      const planes: Float32Array[] = []
      try {
        for (let channel = 0; channel < channels; channel += 1) {
          const plane = new Float32Array(frames)
          audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' })
          planes.push(plane)
        }
      } catch {
        audioData.close()
        return
      }
      audioData.close()
      if (deafenedRef.current) {
        receiver.scheduled = 0
        return
      }
      receiver.lastPlanes = planes
      receiver.lastRate = sampleRate
      const fadeIn = receiver.fadePending ? 0.01 : 0
      receiver.fadePending = false
      enqueueBuffer(receiver, planes, sampleRate, ctx, { fadeIn })
    }

    const createReceiver = (clid: number, channels: number, ctx: AudioContext): Receiver | null => {
      let receiver: Receiver | null = null
      try {
        const decoder = new AudioDecoder({
          output: (audioData) => {
            if (receiver) handleDecoded(receiver, audioData, ctx)
            else audioData.close()
          },
          error: () => {
            const current = receiversRef.current.get(clid)
            if (current && current.decoder === decoder) {
              receiversRef.current.delete(clid)
              try {
                current.decoder.close()
              } catch {
                /* already closed */
              }
            }
          },
        })
        receiver = {
          clid,
          decoder,
          channels,
          scheduled: 0,
          expectedGap: 20,
          jitter: 0,
          lastArrival: 0,
          lastTimestamp: 0,
          pending: new Set(),
          pendingPackets: new Map(),
          nextPacketId: null,
          gapTimer: undefined,
          lastPlanes: null,
          lastRate: 48000,
          fadePending: true,
          lastAccept: 0,
        }
        decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: channels })
        return receiver
      } catch {
        return null
      }
    }

    const concealGap = (receiver: Receiver, missing: number, ctx: AudioContext) => {
      if (!receiver.lastPlanes || !receiver.lastPlanes.length || receiver.lastRate <= 0) {
        receiver.fadePending = true
        return
      }
      const repeats = Math.min(missing, 3)
      for (let index = 0; index < repeats; index += 1) {
        enqueueBuffer(receiver, receiver.lastPlanes, receiver.lastRate, ctx, {
          gain: Math.pow(0.55, index + 1),
          fadeOut: 0.012,
        })
      }
      receiver.fadePending = true
    }

    const decodePacket = (receiver: Receiver, packet: PendingPacket) => {
      const gap = receiver.lastArrival ? packet.arrival - receiver.lastArrival : 0
      if (gap > 0 && gap < 500) {
        const deviation = Math.abs(gap - receiver.expectedGap)
        receiver.jitter = receiver.jitter * 0.85 + deviation * 0.15
        receiver.expectedGap = receiver.expectedGap * 0.9 + gap * 0.1
      } else if (gap >= 500) {
        receiver.scheduled = 0
        receiver.expectedGap = 20
        receiver.jitter = 0
        receiver.fadePending = true
      }
      receiver.lastArrival = packet.arrival
      receiver.lastTimestamp = (receiver.lastTimestamp + 20000) >>> 0
      try {
        receiver.decoder.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: receiver.lastTimestamp,
            data: base64ToBytes(packet.data),
          }),
        )
      } catch {
        return
      }
      lastVoiceRef.current.set(receiver.clid, packet.arrival)
    }

    const drainReceiver = (receiver: Receiver, force: boolean) => {
      if (disposed || !context) return
      for (;;) {
        if (receiver.nextPacketId === null) {
          receiver.pendingPackets.clear()
          return
        }
        const expected = receiver.nextPacketId
        const packet = receiver.pendingPackets.get(expected)
        if (packet) {
          receiver.pendingPackets.delete(expected)
          receiver.nextPacketId = (expected + 1) & PACKET_ID_MASK
          decodePacket(receiver, packet)
          continue
        }
        if (receiver.pendingPackets.size === 0) {
          if (receiver.gapTimer) {
            window.clearTimeout(receiver.gapTimer)
            receiver.gapTimer = undefined
          }
          return
        }
        const now = performance.now()
        let oldest = now
        for (const pending of receiver.pendingPackets.values()) {
          if (pending.arrival < oldest) oldest = pending.arrival
        }
        const wait = reorderWindow(audioRef.current)
        if (!force && now - oldest < wait) {
          if (!receiver.gapTimer) {
            receiver.gapTimer = window.setTimeout(() => {
              receiver.gapTimer = undefined
              if (receiversRef.current.get(receiver.clid) === receiver) drainReceiver(receiver, true)
            }, Math.max(1, wait - (now - oldest)))
          }
          return
        }
        let nextId: number | null = null
        let best = 0x8000
        for (const id of receiver.pendingPackets.keys()) {
          const diff = packetIdDiff(id, expected)
          if (diff > 0 && diff < best) {
            best = diff
            nextId = id
          }
        }
        if (nextId === null) {
          receiver.pendingPackets.clear()
          return
        }
        // 丢包：重复上一帧并逐渐衰减，再把后续包接上，避免硬切产生爆音。
        concealGap(receiver, Math.min(best, 6), context)
        receiver.nextPacketId = nextId
      }
    }

    const onVoice = (event: Event) => {
      if (disposed || !context) return
      const detail = (event as CustomEvent<VoiceEvent>).detail
      if (!detail?.data) return
      const codec = detail.codec
      if (!isOpusCodec(codec)) {
        if (!unsupportedCodecRef.current) {
          unsupportedCodecRef.current = true
          onAudioError?.('有成员使用 Speex/CELT 语音编码，当前版本无法播放，请对方切换为 Opus')
        }
        return
      }
      const clid = detail.clientId
      const channels = codec === OPUS_MUSIC_CODEC ? 2 : 1
      let receiver = receiversRef.current.get(clid)
      if (receiver && receiver.channels !== channels) {
        for (const pending of receiver.pending) {
          try {
            pending.node.stop()
          } catch {
            /* already stopped */
          }
        }
        if (receiver.gapTimer) window.clearTimeout(receiver.gapTimer)
        try {
          receiver.decoder.close()
        } catch {
          /* already closed */
        }
        receiversRef.current.delete(clid)
        receiver = undefined
      }
      if (!receiver) {
        const created = createReceiver(clid, channels, context)
        if (!created) return
        receiver = created
        receiversRef.current.set(clid, receiver)
      }
      const packetId = (detail.packetId ?? 0) & PACKET_ID_MASK
      const arrival = performance.now()
      if (receiver.lastAccept && arrival - receiver.lastAccept > 1000) {
        receiver.nextPacketId = packetId
        receiver.pendingPackets.clear()
        receiver.fadePending = true
      }
      receiver.lastAccept = arrival
      if (receiver.nextPacketId === null) receiver.nextPacketId = packetId
      if (packetIdDiff(packetId, receiver.nextPacketId) < 0) return
      if (!receiver.pendingPackets.has(packetId)) {
        receiver.pendingPackets.set(packetId, { data: detail.data, arrival })
      }
      if (receiver.pendingPackets.size > MAX_BUFFERED_PACKETS) {
        const keep = receiver.pendingPackets.get(packetId)
        receiver.pendingPackets.clear()
        if (keep) receiver.pendingPackets.set(packetId, keep)
        receiver.nextPacketId = packetId
        receiver.fadePending = true
      }
      drainReceiver(receiver, false)
    }

    window.addEventListener('rayspeak:voice', onVoice)
    void start()

    return () => {
      window.removeEventListener('rayspeak:voice', onVoice)
      teardown()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, captureKey])
}

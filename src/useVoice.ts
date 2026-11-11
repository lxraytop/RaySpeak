import { useEffect, useRef } from 'react'
import type { Client } from './types'
import { protocol, type VoiceEvent } from './protocol'

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

const WORKLET_SOURCE = `
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
  }
  emit() {
    const frames = this.frameSize;
    const channels = this.channels;
    const data = new Float32Array(frames * channels);
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) data[i * channels + c] = this.buffers[c][i];
    }
    let energy = 0;
    const mono = this.buffers[0];
    for (let i = 0; i < frames; i += 1) energy += mono[i] * mono[i];
    const level = Math.sqrt(energy / frames);
    this.port.postMessage(
      { frame: data.buffer, frames, channels, level, timestamp: this.timestamp },
      [data.buffer],
    );
    this.timestamp += Math.round((frames / sampleRate) * 1000000);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
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
    return true;
  }
}
registerProcessor('rayspeak-capture', RaySpeakCapture);
`

export interface VoiceAudioConfig {
  inputDevice: string
  outputDevice: string
  inputVolume: number
  outputVolume: number
  echoCancel: boolean
  noiseSuppress: boolean
  autoGain: boolean
  inputMode: 'vad' | 'ptt'
  vadThreshold: number
  pttHeld: boolean
  musicMode: boolean
  bitrate: number
  frameSize: number
  stereo: boolean
  jitterBuffer: number
  latencyMode: 'low' | 'balanced' | 'stable'
}

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
  const decodersRef = useRef(new Map<number, AudioDecoder>())
  const timestampsRef = useRef(new Map<number, number>())
  const scheduleRef = useRef(new Map<number, number>())
  const lastVoiceRef = useRef(new Map<number, number>())
  const lastLevelRef = useRef(0)
  const talkingRef = useRef(new Set<number>())
  const selfTimerRef = useRef<number | undefined>(undefined)

  const playbackDelay = () => {
    const config = audioRef.current
    const mode =
      config.latencyMode === 'low' ? 0.6 : config.latencyMode === 'stable' ? 1.6 : 1
    return Math.max(0.02, (config.jitterBuffer / 1000) * mode)
  }

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
    try {
      encoder.configure({
        codec: 'opus',
        sampleRate: 48000,
        numberOfChannels: audio.stereo || audio.musicMode ? 2 : 1,
        bitrate: Math.max(8000, audio.bitrate * 1000),
      })
    } catch {
      /* reconfiguration unsupported */
    }
  }, [audio.bitrate, audio.stereo, audio.musicMode])

  useEffect(() => {
    if (!enabled) return
    let disposed = false
    let decoderTimer: number | undefined
    let context: AudioContext | null = null
    let captureNode: AudioWorkletNode | null = null
    const config = audioRef.current

    const teardown = () => {
      disposed = true
      if (decoderTimer) window.clearInterval(decoderTimer)
      if (selfTimerRef.current) window.clearTimeout(selfTimerRef.current)
      captureNode?.port.close()
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      for (const decoder of decodersRef.current.values()) {
        try {
          decoder.close()
        } catch {
          /* already closed */
        }
      }
      decodersRef.current.clear()
      gainsRef.current.clear()
      timestampsRef.current.clear()
      scheduleRef.current.clear()
      lastVoiceRef.current.clear()
      talkingRef.current.clear()
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
        noiseSuppression: config.noiseSuppress,
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

      if (typeof AudioEncoder === 'undefined') {
        onAudioError?.('当前系统不支持 WebCodecs Opus 编码，只能接收语音')
      } else {
        try {
          const encoder = new AudioEncoder({
            output: (chunk) => {
              const buffer = new Uint8Array(chunk.byteLength)
              chunk.copyTo(buffer)
              const current = audioRef.current
              if (mutedRef.current || disposed) return
              const gateOpen =
                current.inputMode === 'ptt'
                  ? current.pttHeld
                  : lastLevelRef.current >= Math.pow(10, current.vadThreshold / 20)
              if (!gateOpen) return
              void protocol
                .sendVoiceData(bytesToBase64(buffer), current.musicMode ? 5 : 4)
                .catch(() => {})
            },
            error: () => onAudioError?.('Opus 编码器不可用，语音发送已停止'),
          })
          encoder.configure({
            codec: 'opus',
            sampleRate: 48000,
            numberOfChannels: config.stereo || config.musicMode ? 2 : 1,
            bitrate: Math.max(8000, config.bitrate * 1000),
          })
          encoderRef.current = encoder
        } catch {
          onAudioError?.('无法初始化 Opus 编码器')
        }
      }

      try {
        const stream = await requestMic()
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        streamRef.current = stream
        const moduleUrl = URL.createObjectURL(
          new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
        )
        await context.audioWorklet.addModule(moduleUrl)
        URL.revokeObjectURL(moduleUrl)
        const source = context.createMediaStreamSource(stream)
        const captureGain = context.createGain()
        captureGain.gain.value = Math.max(0, Math.min(2, config.inputVolume / 100))
        captureGainRef.current = captureGain
        captureNode = new AudioWorkletNode(context, 'rayspeak-capture', {
          processorOptions: {
            frameSize: Math.max(
              128,
              Math.round(((context.sampleRate || 48000) * config.frameSize) / 1000),
            ),
            channels: config.stereo || config.musicMode ? 2 : 1,
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
          window.dispatchEvent(
            new CustomEvent('rayspeak:level', { detail: { level: payload.level } }),
          )
          const current = audioRef.current
          const gateOpen =
            current.inputMode === 'ptt'
              ? current.pttHeld
              : payload.level >= Math.pow(10, current.vadThreshold / 20)
          if (!mutedRef.current && gateOpen && payload.level > 0.006) {
            onSelfTalking(true)
            if (selfTimerRef.current) window.clearTimeout(selfTimerRef.current)
            selfTimerRef.current = window.setTimeout(() => onSelfTalking(false), 420)
          }
          const encoder = encoderRef.current
          if (!encoder || encoder.state !== 'configured' || !gateOpen || mutedRef.current) {
            return
          }
          try {
            const audioData = new AudioData({
              format: 'f32',
              sampleRate: context?.sampleRate ?? 48000,
              numberOfFrames: payload.frames,
              numberOfChannels: payload.channels,
              timestamp: payload.timestamp,
              data: payload.frame,
            })
            encoder.encode(audioData)
            audioData.close()
          } catch {
            /* encoder hiccup */
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

    const getDecoder = (clid: number, ctx: AudioContext) => {
      let decoder = decodersRef.current.get(clid)
      if (decoder) return decoder
      try {
        decoder = new AudioDecoder({
          output: (audioData) => {
            const sampleRate = audioData.sampleRate || 48000
            const frames = audioData.numberOfFrames
            const buffer = new Float32Array(frames)
            const copied = audioData.copyTo(buffer, {
              planeIndex: 0,
              format: 'f32-planar',
            }) as unknown as Promise<void> | void
            void Promise.resolve(copied)
              .then(() => {
                audioData.close()
                if (deafenedRef.current) return
                const audioBuffer = ctx.createBuffer(1, frames, sampleRate)
                audioBuffer.copyToChannel(buffer, 0)
                const source = ctx.createBufferSource()
                source.buffer = audioBuffer
                let gain = gainsRef.current.get(clid)
                if (!gain) {
                  gain = ctx.createGain()
                  gain.connect(masterRef.current ?? ctx.destination)
                  gainsRef.current.set(clid, gain)
                }
                source.connect(gain)
                const scheduled = scheduleRef.current.get(clid) ?? 0
                const startAt = Math.max(ctx.currentTime + playbackDelay(), scheduled)
                source.start(startAt)
                scheduleRef.current.set(clid, startAt + audioBuffer.duration)
              })
              .catch(() => {
                try {
                  audioData.close()
                } catch {
                  /* already closed */
                }
              })
          },
          error: () => {
            decodersRef.current.delete(clid)
          },
        })
        decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 })
        decodersRef.current.set(clid, decoder)
        return decoder
      } catch {
        return null
      }
    }

    const onVoice = (event: Event) => {
      if (disposed || !context) return
      const detail = (event as CustomEvent<VoiceEvent>).detail
      if (!detail?.data) return
      const bytes = base64ToBytes(detail.data)
      const decoder = getDecoder(detail.clientId, context)
      if (!decoder) return
      const next = (timestampsRef.current.get(detail.clientId) ?? 0) + 20000
      timestampsRef.current.set(detail.clientId, next)
      try {
        decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: next, data: bytes }))
      } catch {
        return
      }
      lastVoiceRef.current.set(detail.clientId, performance.now())
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

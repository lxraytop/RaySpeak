import { isTauri, listenEvent, protocol, type ShareNetworkOptionsDto } from './protocol'

export interface ShareNetworkInfo {
  roomId: string
  network: string
  peerId: string
  nickname: string
  ip: string
  signalPort: number
  nodeId: string
  nodeLabel: string
  nodeUri: string
  nodeLatencyMs: number | null
}

export interface ShareNodeProbe {
  id: string
  label: string
  uri: string
  protocol: string
  latencyMs: number | null
  /** 多次握手的最大延迟差；越大说明链路越抖 */
  jitterMs: number | null
  reachable: boolean
}

/** 内置节点目录，不带测速结果，页面首次打开即可选择。 */
export interface ShareNodeOption {
  id: string
  label: string
  uri: string
  protocol: string
}

export interface SharePeerInfo {
  peerId: string
  nickname: string
  ip: string
  connected: boolean
  latencyMs?: number | null
}

export interface ShareQuality {
  resolution: number
  frameRate: number
  bitrateMbps: number
  /** 共享系统声音：WASAPI 进程回环，且排除 RaySpeak 自身进程树 */
  systemAudio: boolean
}

/** 采集侧实测值（来自真实帧，不是设置项）。 */
export interface ShareCaptureStats {
  width: number
  height: number
  /** 前端实际交付给编码器的帧率 */
  fps: number
  /** WGC 回调送来的帧数 / 秒：为 0 说明桌面本身静止，不是管线卡住 */
  arrived: number
  /** 原生侧完成拷贝 + 缩放的帧数 / 秒 */
  built: number
  /** 最近一帧的 GPU 读回 + 缩放耗时 */
  captureMs: number
  /** 最近一帧的 JPEG 编码耗时 */
  buildMs: number
  /** 最近一帧的 IPC 载荷大小（JPEG 字节数） */
  kb: number
  /** 共享的是窗口且已被最小化：WGC 不产帧，画面会停住 */
  minimized: boolean
  /** 最近一次采集/编码错误 */
  error: string
}

/** 发送端 getStats() 的真实编码结果。 */
export interface ShareEncodeStats {
  fps: number
  width: number
  height: number
  /** 实际发送码率（kbps），按两次采样差值估算 */
  bitrateKbps: number
  /** Chromium 估算的可用上行带宽（kbps），未协商完成时为 0 */
  availableKbps: number
  limitation: string
  encoder: string
  codec: string
}

export interface ShareSession {
  shareId: string
  peerId: string
  name: string
  quality: ShareQuality
  sourceName: string
  at: number
  /** 这一路共享是否带系统声音 */
  hasAudio?: boolean
}

export interface ShareCaptureSource {
  id: string
  name: string
  kind: 'monitor' | 'window'
  width: number
  height: number
  primary: boolean
}

export type SharePhase = 'offline' | 'starting' | 'online' | 'error'

export interface ScreenShareState {
  phase: SharePhase
  info?: ShareNetworkInfo
  error?: string
  peers: SharePeerInfo[]
  shares: ShareSession[]
  sharing?: ShareSession
  viewing?: { shareId: string; ownerId: string; name: string; stream: MediaStream }
  localStream?: MediaStream
  viewerBusy?: string
  viewerCount: number
  captureStats?: ShareCaptureStats
  encodeStats?: ShareEncodeStats
  /** 共享端系统音频启动失败的原因（不影响画面） */
  audioError?: string
  /** 观看端是否静音了共享声音 */
  audioMuted: boolean
  /** 观看端自动播放被浏览器拦截，需要用户点一下 */
  audioBlocked: boolean
  sources: ShareCaptureSource[]
  quality: ShareQuality
  /** 内置节点目录（不测速，来自 Rust 的 CATALOG） */
  catalog: ShareNodeOption[]
  nodes: ShareNodeProbe[]
  /** 上次测速的时间戳；0 表示还没测过 */
  probedAt: number
  probing: boolean
  logs: string[]
}

const NODES_KEY = 'rayspeak.shareNodes.v1'

function loadNodeProbes(): { nodes: ShareNodeProbe[]; probedAt: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(NODES_KEY) || 'null') as {
      at?: number
      nodes?: ShareNodeProbe[]
    } | null
    if (!raw || !Array.isArray(raw.nodes)) return { nodes: [], probedAt: 0 }
    return { nodes: raw.nodes, probedAt: Number(raw.at) || 0 }
  } catch {
    return { nodes: [], probedAt: 0 }
  }
}

function saveNodeProbes(nodes: ShareNodeProbe[], probedAt: number) {
  try {
    localStorage.setItem(NODES_KEY, JSON.stringify({ at: probedAt, nodes: nodes.slice(0, 24) }))
  } catch {
    /* 存储不可用时仍然可以手动测速 */
  }
}

const QUALITY_KEY = 'rayspeak.screenShare.v1'
export const SHARE_RESOLUTIONS = [720, 1080, 1440, 2160] as const
export const SHARE_FRAME_RATES = [30, 60, 120] as const
export const SHARE_BITRATES = [0, 4, 8, 16, 32, 64] as const
export const DEFAULT_QUALITY: ShareQuality = {
  resolution: 1080,
  frameRate: 30,
  bitrateMbps: 0,
  systemAudio: false,
}

export function loadShareQuality(): ShareQuality {
  try {
    const raw = JSON.parse(localStorage.getItem(QUALITY_KEY) || 'null')
    return normalizeQuality(raw)
  } catch {
    return { ...DEFAULT_QUALITY }
  }
}

export function saveShareQuality(quality: ShareQuality) {
  try {
    localStorage.setItem(QUALITY_KEY, JSON.stringify(normalizeQuality(quality)))
  } catch {
    /* 存储不可用时仍可共享 */
  }
}

export function normalizeQuality(value?: Partial<ShareQuality> | null): ShareQuality {
  const resolution = SHARE_RESOLUTIONS.find((item) => item === value?.resolution) ?? 1080
  const frameRate = SHARE_FRAME_RATES.find((item) => item === value?.frameRate) ?? 30
  const bitrateMbps = SHARE_BITRATES.find((item) => item === value?.bitrateMbps) ?? 0
  return { resolution, frameRate, bitrateMbps, systemAudio: Boolean(value?.systemAudio) }
}

export function screenBitrate(quality: ShareQuality): number {
  const base = ({ 720: 2, 1080: 4, 1440: 8, 2160: 16 } as Record<number, number>)[quality.resolution] || 4
  const mbps = quality.bitrateMbps || Math.min(64, (base * quality.frameRate) / 30)
  return mbps * 1_000_000
}

export type NetworkGrade = 'excellent' | 'good' | 'fair' | 'poor'

export interface NetworkAssessment {
  grade: NetworkGrade
  label: string
  rttMs: number
  jitterMs: number
  /** 建议的最高画质（码率用「自动」，随分辨率/帧率缩放） */
  suggestion: ShareQuality
  note: string
}

/**
 * 用测速得到的往返延迟与抖动估算可支撑的画质。延迟不直接等于带宽，
 * 所以这里只给「节点握手能稳定支撑」的保守上限，真实上行由共享后的
 * availableOutgoingBitrate 确认。
 */
export function assessNetwork(
  probe: ShareNodeProbe | undefined,
  transport: 'auto' | 'p2p' | 'relay',
): NetworkAssessment | null {
  if (!probe || probe.latencyMs == null) return null
  const rtt = probe.latencyMs
  const jitter = Math.max(0, probe.jitterMs ?? 0)
  const score = rtt + Math.min(jitter, 120) * 1.5
  const pick = (
    grade: NetworkGrade,
    label: string,
    resolution: number,
    frameRate: number,
  ): NetworkAssessment => ({
    grade,
    label,
    rttMs: rtt,
    jitterMs: jitter,
    suggestion: { resolution, frameRate, bitrateMbps: 0, systemAudio: false },
    note: `延迟 ${rtt.toFixed(0)}ms · 抖动 ${jitter.toFixed(0)}ms，按节点握手估算；共享后右上角会显示实测发送码率。`,
  })
  let result =
    score <= 50
      ? pick('excellent', '优秀', 1080, 60)
      : score <= 100
        ? pick('good', '良好', 1080, 60)
        : score <= 170
          ? pick('fair', '一般', 1080, 30)
          : pick('poor', '较差', 720, 30)
  if (transport === 'relay' && result.suggestion.frameRate > 30) {
    result = {
      ...result,
      suggestion: { ...result.suggestion, frameRate: 30 },
      note: `${result.note} 仅中继模式下建议最高 30fps。`,
    }
  }
  return result
}

interface ViewOfferMessage {
  type: 'view-offer'
  shareId: string
  from: string
  sdp: string
}

type SignalMessage =
  | { type: 'share-start'; share: ShareSession }
  | { type: 'share-stop'; shareId: string }
  | ViewOfferMessage
  | { type: 'view-answer'; shareId: string; to: string; sdp: string }
  | { type: 'ice'; shareId: string; role: 'sharer' | 'viewer'; candidate: RTCIceCandidateInit }
  | { type: 'view-stop'; shareId: string; from: string }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface AudioFrameLike {
  close(): void
}
type AudioGeneratorTrack = MediaStreamTrack & { writable: WritableStream<AudioFrameLike> }

class ScreenShareClient {
  private state: ScreenShareState = (() => {
    const cached = loadNodeProbes()
    return {
      phase: 'offline',
      peers: [],
      shares: [],
      sources: [],
      quality: loadShareQuality(),
      viewerCount: 0,
      catalog: [],
      nodes: cached.nodes,
      probedAt: cached.probedAt,
      probing: false,
      logs: [],
      audioMuted: false,
      audioBlocked: false,
    }
  })()
  private listeners = new Set<() => void>()
  private started = false
  private dispose: Array<() => void> = []
  private degradation: 'framerate' | 'resolution' = 'framerate'
  private localTrack: MediaStreamTrack | null = null
  private localAudioTrack: MediaStreamTrack | null = null
  private audioWriter: WritableStreamDefaultWriter<AudioFrameLike> | null = null
  private audioGeneration = 0
  private remoteAudio: HTMLAudioElement | null = null
  private generatorWriter: WritableStreamDefaultWriter<VideoFrame> | null = null
  private captureId: string | null = null
  // 每次停止/重新开始都递增；旧取帧循环看到代数变化就退出，避免残留循环。
  private captureGeneration = 0
  private viewerPcs = new Map<string, RTCPeerConnection>()
  private sharerPcs = new Map<string, RTCPeerConnection>()
  private pendingIce = new Map<string, RTCIceCandidateInit[]>()
  private broadcastTimer: number | null = null
  private announcedPeers = new Set<string>()
  private statsTimers = new Map<string, number>()

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = () => this.state

  private set(patch: Partial<ScreenShareState>) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  async init() {
    if (this.started) return
    this.started = true
    if (!isTauri) return
    let disposers: Array<() => void> = []
    try {
      disposers = await Promise.all([
      listenEvent<{ phase: SharePhase; info: ShareNetworkInfo | null; error: string | null }>(
        'ts://share-status',
        (payload) => {
          if (payload.phase === 'offline') {
            this.teardownAll()
            this.set({ phase: 'offline', info: undefined, error: payload.error ?? undefined })
          } else if (payload.phase === 'online' && payload.info) {
            this.set({ phase: 'online', info: payload.info, error: undefined })
          } else {
            this.set({ phase: payload.phase, error: payload.error ?? undefined })
          }
        },
      ),
      listenEvent<SharePeerInfo[]>('ts://share-peers', (peers) => {
        const list = peers.filter((peer) => peer.peerId)
        const connected = list.filter((peer) => peer.connected).map((peer) => peer.peerId)
        const fresh = connected.filter((peerId) => !this.announcedPeers.has(peerId))
        this.announcedPeers = new Set(connected)
        this.set({ peers: list })
        if (this.state.sharing && fresh.length > 0) this.scheduleBroadcast()
      }),
      listenEvent<{ from: string; message: string }>('ts://share-signal', (payload) => {
        void this.handleSignal(payload.from, payload.message)
      }),
      listenEvent<{ id: string }>('ts://share-capture-ended', (payload) => {
        if (payload.id === this.captureId) {
          void this.stopSharing()
        }
      }),
      listenEvent<string | string[]>('ts://share-net-log', (payload) => {
        const lines = Array.isArray(payload) ? payload : typeof payload === 'string' ? [payload] : []
        if (lines.length === 0) return
        this.set({ logs: [...this.state.logs, ...lines].slice(-80) })
      }),
      ])
    } catch {
      // 事件通道不可用时仍查询一次状态，避免整个页面卡在离线。
    }
    this.dispose.push(...disposers)
    const status = await protocol.shareNetworkStatus()
    if (status?.info) {
      this.set({ phase: 'online', info: status.info })
      this.set({ peers: await protocol.sharePeers() })
    }
    void protocol
      .shareNodeOptions()
      .then((catalog) => {
        if (catalog.length) this.set({ catalog })
      })
      .catch(() => {})
  }

  destroy() {
    for (const dispose of this.dispose) dispose()
    this.dispose = []
    this.started = false
  }

  private async handleSignal(from: string, raw: string) {
    let message: SignalMessage
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    try {
      await this.dispatchSignal(from, message)
    } catch {
      // 单条信令失败（例如对端提前关闭）不应中断整个 mesh。
    }
  }

  private async dispatchSignal(from: string, message: SignalMessage) {
    switch (message.type) {
      case 'share-start': {
        const share = message.share
        if (!share || share.peerId === this.state.info?.peerId) return
        if (typeof share.shareId !== 'string' || !share.shareId) return
        const shares = this.state.shares.filter((item) => item.shareId !== share.shareId)
        this.set({
          shares: [
            ...shares,
            {
              ...share,
              name: String(share.name || share.peerId),
              sourceName: String(share.sourceName || '屏幕'),
              quality: normalizeQuality(share.quality),
            },
          ],
        })
        break
      }
      case 'share-stop': {
        this.set({ shares: this.state.shares.filter((item) => item.shareId !== message.shareId) })
        if (this.state.viewing?.shareId === message.shareId) {
          this.stopWatching()
        }
        this.closeViewer(message.shareId)
        break
      }
      case 'view-offer':
        try {
          await this.answerViewer(from, message)
        } catch {
          this.closeSharer(message.shareId, from)
        }
        break
      case 'view-answer':
        await this.acceptAnswer(message)
        break
      case 'ice':
        await this.addRemoteCandidate(from, message)
        break
      case 'view-stop':
        this.closeSharer(message.shareId, message.from)
        break
    }
  }

  private send(to: string, message: SignalMessage) {
    void protocol.shareSendSignal(to, JSON.stringify(message)).catch(() => {})
  }

  private broadcast(message: SignalMessage) {
    this.send('*', message)
  }

  private scheduleBroadcast() {
    if (!this.state.sharing) return
    if (this.broadcastTimer != null) window.clearTimeout(this.broadcastTimer)
    this.broadcastTimer = window.setTimeout(() => {
      this.broadcastTimer = null
      if (this.state.sharing) this.broadcast({ type: 'share-start', share: this.state.sharing })
    }, 200)
  }

  async startNetwork(options: {
    channelId: number
    nickname: string
    pin?: string
    node?: string
    /** 上次手动测速得到的节点顺序；为空时后端按目录顺序兜底 */
    peers?: string[]
    network?: ShareNetworkOptionsDto
  }) {
    await this.init()
    this.set({ phase: 'starting', error: undefined, logs: [] })
    try {
      const info = await protocol.shareNetworkStart(
        options.channelId,
        options.nickname,
        options.pin?.trim() || null,
        options.node?.trim() || null,
        options.peers?.length ? options.peers : null,
        options.network,
      )
      this.set({ phase: 'online', info, error: undefined, peers: await protocol.sharePeers() })
      void this.refreshLogs()
      return info
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.set({ phase: 'error', error: message })
      throw error
    }
  }

  /** 手动测速：并发探测内置公共节点与用户自定义节点。进入页面时不会自动调用。 */
  async probeNodes(custom: string[] = []) {
    await this.init()
    if (!isTauri) return this.state.nodes
    this.set({ probing: true })
    try {
      const nodes = await protocol.shareProbeNodes(custom)
      const probedAt = Date.now()
      saveNodeProbes(nodes, probedAt)
      this.set({ nodes, probedAt })
      return nodes
    } finally {
      this.set({ probing: false })
    }
  }

  /** 只测一行：内置 id 或自定义 URI。结果合并进现有缓存。 */
  async probeNode(target: string) {
    await this.init()
    if (!isTauri) return null
    const probe = await protocol.shareProbeNode(target)
    if (probe) {
      const nodes = this.state.nodes.filter((node) => node.id !== probe.id)
      nodes.push(probe)
      const probedAt = Date.now()
      saveNodeProbes(nodes, probedAt)
      this.set({ nodes, probedAt })
    }
    return probe
  }

  async refreshLogs() {
    if (!isTauri) return this.state.logs
    const logs = await protocol.shareNetworkLogs().catch(() => [])
    this.set({ logs: logs.slice(-80) })
    return logs
  }

  async stopNetwork() {
    try {
      await this.stopSharing()
      this.stopWatching()
      await protocol.shareNetworkStop()
    } finally {
      this.teardownAll()
      this.set({ phase: 'offline', info: undefined, shares: [], peers: [] })
    }
  }

  async connectPeer(ip: string) {
    await protocol.shareConnectPeer(ip.trim())
  }

  async refreshSources() {
    await this.init()
    const sources = await protocol.shareCaptureSources()
    this.set({ sources })
    return sources
  }

  async startSharing(
    sourceId: string,
    quality: ShareQuality,
    preferences?: { degradation?: 'framerate' | 'resolution' },
  ) {
    const info = this.state.info
    if (!info) throw new Error('EasyTier 网络尚未就绪')
    if (this.state.sharing) throw new Error('已经在共享屏幕')
    this.degradation = preferences?.degradation === 'resolution' ? 'resolution' : 'framerate'
    saveShareQuality(quality)
    this.set({ quality })

    const capture = await protocol.shareCaptureStart(sourceId, quality.resolution, quality.frameRate)
    this.captureId = capture.id
    let stream: MediaStream
    let track: MediaStreamTrack
    try {
      const pumped = this.pumpFrames(capture.id)
      stream = pumped.stream
      track = pumped.track
    } catch (error) {
      this.captureId = null
      await protocol.shareCaptureStop(capture.id).catch(() => {})
      throw error
    }
    this.localTrack = track

    // 系统音频是加分项：失败不影响画面共享，界面会显示原因。
    let audio: MediaStreamTrack | null = null
    let audioError: string | undefined
    if (quality.systemAudio) {
      try {
        audio = await this.startAudioPump()
      } catch (error) {
        audioError = error instanceof Error ? error.message : String(error)
      }
    }
    this.set({ audioError })

    const share: ShareSession = {
      shareId: `share-${info.peerId}-${Date.now()}`,
      peerId: info.peerId,
      name: info.nickname,
      quality: normalizeQuality(quality),
      sourceName: capture.source.name,
      at: Date.now(),
      hasAudio: Boolean(audio),
    }
    this.set({ sharing: share, localStream: stream })
    this.broadcast({ type: 'share-start', share })
    return share
  }

  async stopSharing() {
    const share = this.state.sharing
    this.captureGeneration += 1
    this.stopAudioPump()
    if (share) this.broadcast({ type: 'share-stop', shareId: share.shareId })
    void this.generatorWriter?.close().catch(() => {})
    this.generatorWriter = null
    this.localTrack?.stop()
    this.localTrack = null
    for (const pc of this.sharerPcs.values()) pc.close()
    this.sharerPcs.clear()
    this.clearStatsTimers()
    const id = this.captureId
    this.captureId = null
    if (id) {
      await protocol.shareCaptureStop(id).catch(() => {})
    }
    this.set({
      sharing: undefined,
      localStream: undefined,
      viewerCount: 0,
      captureStats: undefined,
      audioError: undefined,
    })
  }

  /** 共享端：WASAPI 进程回环（排除 RaySpeak 自身）→ AudioData → 音频轨。 */
  private async startAudioPump(): Promise<MediaStreamTrack> {
    const windows = window as unknown as {
      AudioData?: new (init: Record<string, unknown>) => AudioFrameLike
      MediaStreamTrackGenerator?: new (init: { kind: 'audio' }) => AudioGeneratorTrack
    }
    const AudioDataCtor = windows.AudioData
    const Generator = windows.MediaStreamTrackGenerator
    if (!AudioDataCtor || !Generator) {
      throw new Error('当前 WebView2 不支持音频轨生成')
    }
    const info = await protocol.shareAudioStart()
    const generator = new Generator({ kind: 'audio' })
    const writer = generator.writable.getWriter()
    this.audioWriter = writer
    this.localAudioTrack = generator
    const generation = ++this.audioGeneration
    const chunkFrames = Math.round(info.sampleRate / 50) // 20ms
    let timestamp = 0
    const loop = async () => {
      while (generation === this.audioGeneration) {
        let packet: ArrayBuffer
        try {
          packet = await protocol.shareAudioRead(chunkFrames)
        } catch {
          if (generation !== this.audioGeneration) break
          await sleep(120)
          continue
        }
        if (generation !== this.audioGeneration) break
        if (packet.byteLength < 4) {
          await sleep(8)
          continue
        }
        const samples = new Float32Array(packet)
        const frames = Math.floor(samples.length / info.channels)
        if (frames <= 0) {
          await sleep(8)
          continue
        }
        const audio = new AudioDataCtor({
          format: 'f32-planar',
          sampleRate: info.sampleRate,
          numberOfFrames: frames,
          numberOfChannels: info.channels,
          timestamp,
          data: samples,
        })
        timestamp += Math.round((frames / info.sampleRate) * 1_000_000)
        try {
          await writer.write(audio)
        } catch {
          audio.close()
          break
        }
        audio.close()
      }
    }
    void loop()
    return generator
  }

  private stopAudioPump() {
    this.audioGeneration += 1
    void this.audioWriter?.close().catch(() => {})
    this.audioWriter = null
    this.localAudioTrack?.stop()
    this.localAudioTrack = null
    void protocol.shareAudioStop().catch(() => {})
  }

  async watch(share: ShareSession) {
    await this.init()
    if (this.state.viewing?.shareId === share.shareId) return
    if (!this.state.peers.some((peer) => peer.peerId === share.peerId && peer.connected)) {
      throw new Error('共享者不在线')
    }
    this.stopWatching()
    this.set({ viewerBusy: share.shareId })
    try {
      const stream = await this.requestView(share)
      this.set({
        viewing: { shareId: share.shareId, ownerId: share.peerId, name: share.name, stream },
        viewerBusy: undefined,
      })
    } catch (error) {
      this.set({ viewerBusy: undefined })
      throw error
    }
  }

  stopWatching() {
    const viewing = this.state.viewing
    if (viewing) {
      this.send(viewing.ownerId, {
        type: 'view-stop',
        shareId: viewing.shareId,
        from: this.state.info?.peerId || '',
      })
      this.closeViewer(viewing.shareId)
    }
    this.detachRemoteAudio()
    this.set({ viewing: undefined })
  }

  /** 观看端播放共享者的系统声音；自动播放被拦截时由 UI 提示点一下。 */
  private attachRemoteAudio(track: MediaStreamTrack) {
    if (!this.remoteAudio) {
      this.remoteAudio = new Audio()
      this.remoteAudio.autoplay = true
    }
    this.remoteAudio.srcObject = new MediaStream([track])
    this.remoteAudio.muted = this.state.audioMuted
    this.remoteAudio.play().then(
      () => this.set({ audioBlocked: false }),
      () => this.set({ audioBlocked: true }),
    )
  }

  toggleRemoteAudio() {
    const muted = !this.state.audioMuted
    if (this.remoteAudio) {
      this.remoteAudio.muted = muted
      if (!muted) {
        void this.remoteAudio.play().then(
          () => this.set({ audioMuted: false, audioBlocked: false }),
          () => this.set({ audioMuted: false, audioBlocked: true }),
        )
        return
      }
    }
    this.set({ audioMuted: muted })
  }

  private detachRemoteAudio() {
    if (this.remoteAudio) {
      this.remoteAudio.pause()
      this.remoteAudio.srcObject = null
      this.remoteAudio = null
    }
    this.set({ audioBlocked: false })
  }

  private pumpFrames(captureId: string) {
    type GeneratedTrack = MediaStreamTrack & { writable: WritableStream<VideoFrame> }
    const Generator = (
      window as unknown as {
        MediaStreamTrackGenerator?: new (init: { kind: 'video' }) => GeneratedTrack
      }
    ).MediaStreamTrackGenerator
    // WebCodecs 视频轨：VideoFrame 直接引用 IPC 缓冲区，省掉 canvas 上传与
    // putImageData；不支持时退回 canvas 手动 requestFrame。
    const useCodecs = typeof Generator === 'function' && typeof VideoFrame !== 'undefined'
    const canvas = useCodecs ? null : document.createElement('canvas')
    const context = canvas?.getContext('2d', { alpha: false, desynchronized: true }) ?? null
    if (!useCodecs && !context) throw new Error('无法创建共享视频轨')

    let stream: MediaStream
    let track: MediaStreamTrack
    let writer: WritableStreamDefaultWriter<VideoFrame> | null = null
    if (useCodecs && Generator) {
      const generated = new Generator({ kind: 'video' })
      stream = new MediaStream([generated])
      track = generated
      writer = generated.writable.getWriter()
    } else {
      stream = canvas!.captureStream(0)
      track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
    }
    this.generatorWriter = writer
    // 屏幕内容也有滚动/视频，motion 让编码器优先保帧率而不是死保细节。
    track.contentHint = 'motion'

    const generation = ++this.captureGeneration
    let frames = 0
    let windowStart = performance.now()
    // 静止画面每秒重发最后一帧：保留一帧已解码的结果，不必重新解码 JPEG。
    let lastFrame: VideoFrame | null = null
    let lastBitmap: ImageBitmap | null = null
    let lastWidth = 0
    let lastHeight = 0
    let lastKb = 0
    let nativeArrived = 0
    let nativeBuilt = 0

    const deliver = async (bitmap: ImageBitmap, width: number, height: number) => {
      if (writer) {
        const video = new VideoFrame(bitmap, {
          timestamp: Math.round(performance.now() * 1000),
        })
        lastFrame?.close()
        lastFrame = video
        await writer.write(video)
        return
      }
      if (!canvas || !context) return
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width
        canvas.height = height
      }
      context.drawImage(bitmap, 0, 0, width, height)
      ;(track as CanvasCaptureMediaStreamTrack).requestFrame()
    }

    const repeatLast = async () => {
      if (writer) {
        if (!lastFrame) return
        const clone = new VideoFrame(lastFrame, { timestamp: Math.round(performance.now() * 1000) })
        try {
          await writer.write(clone)
        } finally {
          clone.close()
        }
        return
      }
      if (lastBitmap) await deliver(lastBitmap, lastWidth, lastHeight)
    }

    // 每秒汇报一次，**不论这一秒有没有新帧**：静止画面 / 窗口最小化时
    // 也要让界面知道真实原因，而不是停在上一次的 27fps。
    const report = async () => {
      const elapsed = performance.now() - windowStart
      if (elapsed < 1000) return
      let arrived = 0
      let built = 0
      let captureMs = 0
      let buildMs = 0
      let minimized = false
      let error = ''
      try {
        const stats = await protocol.shareCaptureStats(captureId)
        if (stats) {
          arrived = Math.max(0, Math.round(((stats.arrived - nativeArrived) * 1000) / elapsed))
          built = Math.max(0, Math.round(((stats.built - nativeBuilt) * 1000) / elapsed))
          captureMs = stats.captureMs
          buildMs = stats.buildMs
          minimized = stats.minimized
          error = stats.lastError ?? ''
          nativeArrived = stats.arrived
          nativeBuilt = stats.built
        }
      } catch {
        /* 统计失败不影响共享 */
      }
      if (generation !== this.captureGeneration) return
      this.set({
        captureStats: {
          width: lastWidth,
          height: lastHeight,
          fps: Math.round((frames * 1000) / elapsed),
          arrived,
          built,
          captureMs,
          buildMs,
          kb: lastKb,
          minimized,
          error,
        },
      })
      frames = 0
      windowStart = performance.now()
    }

    const loop = async () => {
      while (generation === this.captureGeneration) {
        let packet: ArrayBuffer
        try {
          packet = await protocol.shareCaptureFrame(captureId)
        } catch {
          if (generation !== this.captureGeneration) break
          await sleep(150)
          await report()
          continue
        }
        if (generation !== this.captureGeneration) break
        if (packet.byteLength === 0) {
          // 1 秒内没有新帧（静止画面）：重发上一帧，保证编码器与新观众持续有画面。
          try {
            await repeatLast()
          } catch {
            break
          }
          await report()
          continue
        }
        if (packet.byteLength < 12) continue
        const view = new DataView(packet)
        const width = view.getUint32(0, true)
        const height = view.getUint32(4, true)
        if (width < 2 || height < 2 || width > 16_384 || height > 16_384) continue
        // 8 字节头 + JPEG 载荷。原始 RGBA 走 IPC 只有 ~106MB/s，
        // 1080p 一帧 7.3MB 就要 70ms，所以压缩放在原生侧。
        let bitmap: ImageBitmap
        try {
          const blob = new Blob([new Uint8Array(packet, 8)], { type: 'image/jpeg' })
          bitmap = await createImageBitmap(blob)
        } catch {
          continue
        }
        if (generation !== this.captureGeneration) {
          bitmap.close()
          break
        }
        try {
          await deliver(bitmap, width, height)
        } catch {
          bitmap.close()
          break
        }
        lastWidth = width
        lastHeight = height
        lastKb = Math.round(packet.byteLength / 1024)
        if (!writer) {
          lastBitmap?.close()
          lastBitmap = bitmap
        } else {
          bitmap.close()
          lastBitmap = null
        }
        frames += 1
        await report()
      }
      lastFrame?.close()
      lastFrame = null
      lastBitmap?.close()
      lastBitmap = null
    }
    void loop()
    return { stream, track }
  }

  private async requestView(share: ShareSession): Promise<MediaStream> {
    const urls = await protocol.shareIceServers()
    const pc = this.createPeer(urls, 'viewer', share.shareId, share.peerId)
    this.viewerPcs.set(share.shareId, pc)
    this.preferCodecs(pc.addTransceiver('video', { direction: 'recvonly' }))
    if (share.hasAudio) pc.addTransceiver('audio', { direction: 'recvonly' })

    const streamPromise = new Promise<MediaStream>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.closeViewer(share.shareId)
        reject(new Error('等待画面超时'))
      }, 30_000)
      pc.ontrack = (event) => {
        if (event.track.kind === 'audio') {
          this.attachRemoteAudio(event.track)
          return
        }
        window.clearTimeout(timer)
        const stream = event.streams[0] ?? new MediaStream([event.track])
        resolve(stream)
      }
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed') {
          window.clearTimeout(timer)
          this.closeViewer(share.shareId)
          reject(new Error('WebRTC 连接失败，请确认双方都在同一 EasyTier 房间'))
        }
      }
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    this.send(share.peerId, {
      type: 'view-offer',
      shareId: share.shareId,
      from: this.state.info?.peerId || '',
      sdp: offer.sdp || '',
    })
    return streamPromise
  }

  private async answerViewer(from: string, message: ViewOfferMessage) {
    const share = this.state.sharing
    if (!share || !this.localTrack || message.shareId !== share.shareId) return
    const key = `${message.shareId}:${from}`
    this.closeSharer(message.shareId, from)
    const urls = await protocol.shareIceServers()
    if (this.state.sharing?.shareId !== share.shareId || !this.localTrack) return
    const pc = this.createPeer(urls, 'sharer', message.shareId, from)
    this.sharerPcs.set(key, pc)

    await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp })
    const transceiver = pc.getTransceivers().find((item) => item.receiver.track.kind === 'video')
    if (!transceiver) throw new Error('无法匹配视频通道')
    transceiver.direction = 'sendonly'
    this.preferCodecs(transceiver)
    await transceiver.sender.replaceTrack(this.localTrack)

    // 观看者带了音频 m-line 时把系统音频接上；没有音频就显式置为 inactive。
    const audioTransceiver = pc
      .getTransceivers()
      .find((item) => item.receiver.track.kind === 'audio')
    if (audioTransceiver) {
      if (this.localAudioTrack) {
        audioTransceiver.direction = 'sendonly'
        await audioTransceiver.sender.replaceTrack(this.localAudioTrack)
      } else {
        audioTransceiver.direction = 'inactive'
      }
    }

    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await this.applyBitrate(transceiver.sender, share.quality)
    this.send(from, {
      type: 'view-answer',
      shareId: message.shareId,
      to: from,
      sdp: answer.sdp || '',
    })
    await this.flushIce(key, pc)
    this.set({ viewerCount: this.sharerPcs.size })
    this.watchEncodeStats(key, pc)
  }

  private watchEncodeStats(key: string, pc: RTCPeerConnection) {
    this.stopEncodeStats(key)
    let prevBytes = 0
    let prevAt = 0
    const timer = window.setInterval(() => {
      void pc
        .getStats()
        .then((report) => {
          type Stat = RTCStats & {
            kind?: string
            codecId?: string
            mimeType?: string
            framesPerSecond?: number
            frameWidth?: number
            frameHeight?: number
            qualityLimitationReason?: string
            encoderImplementation?: string
            bytesSent?: number
            selected?: boolean
            availableOutgoingBitrate?: number
          }
          const stats = new Map<string, Stat>()
          report.forEach((raw) => stats.set(raw.id, raw as Stat))
          let availableKbps = 0
          for (const stat of stats.values()) {
            if (stat.type === 'candidate-pair' && stat.selected) {
              availableKbps = Math.round((stat.availableOutgoingBitrate ?? 0) / 1000)
            }
          }
          for (const stat of stats.values()) {
            if (stat.type !== 'outbound-rtp' || stat.kind !== 'video') continue
            const codec = stat.codecId ? stats.get(stat.codecId) : undefined
            // qualityLimitationReason=bandwidth 既包含「撞到 maxBitrate 上限」也包含
            // 「发送带宽估算偏低」，用实测码率区分，避免把自设上限报成网络故障。
            const now = performance.now()
            const bytes = stat.bytesSent ?? 0
            const kbps =
              prevAt > 0 && now > prevAt && bytes >= prevBytes
                ? ((bytes - prevBytes) * 8) / (now - prevAt)
                : 0
            prevBytes = bytes
            prevAt = now
            this.set({
              encodeStats: {
                fps: Math.round(stat.framesPerSecond ?? 0),
                width: stat.frameWidth ?? 0,
                height: stat.frameHeight ?? 0,
                bitrateKbps: Math.round(kbps),
                availableKbps,
                limitation: stat.qualityLimitationReason ?? 'none',
                encoder: stat.encoderImplementation ?? '',
                codec: (codec?.mimeType ?? '').replace(/^video\//i, ''),
              },
            })
          }
        })
        .catch(() => {})
    }, 1000)
    this.statsTimers.set(key, timer)
  }

  private stopEncodeStats(key: string) {
    const timer = this.statsTimers.get(key)
    if (timer != null) {
      window.clearInterval(timer)
      this.statsTimers.delete(key)
    }
    if (this.statsTimers.size === 0) this.set({ encodeStats: undefined })
  }

  private clearStatsTimers() {
    for (const timer of this.statsTimers.values()) window.clearInterval(timer)
    this.statsTimers.clear()
    this.set({ encodeStats: undefined })
  }

  private async acceptAnswer(message: { shareId: string; sdp: string }) {
    const pc = this.viewerPcs.get(message.shareId)
    if (!pc) return
    await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp })
    await this.flushIce(message.shareId, pc)
  }

  private async addRemoteCandidate(from: string, message: { shareId: string; role: string; candidate: RTCIceCandidateInit }) {
    const key = message.role === 'viewer' ? `${message.shareId}:${from}` : message.shareId
    const pc = message.role === 'viewer' ? this.sharerPcs.get(key) : this.viewerPcs.get(key)
    if (!pc) {
      const list = this.pendingIce.get(key) ?? []
      list.push(message.candidate)
      this.pendingIce.set(key, list)
      return
    }
    if (!pc.remoteDescription) {
      const list = this.pendingIce.get(key) ?? []
      list.push(message.candidate)
      this.pendingIce.set(key, list)
      return
    }
    await pc.addIceCandidate(message.candidate).catch(() => {})
  }

  private async flushIce(key: string, pc: RTCPeerConnection) {
    const list = this.pendingIce.get(key) ?? []
    this.pendingIce.delete(key)
    for (const candidate of list) {
      await pc.addIceCandidate(candidate).catch(() => {})
    }
  }

  private async applyBitrate(sender: RTCRtpSender, quality: ShareQuality) {
    try {
      const params = sender.getParameters()
      if (!params.encodings?.length) params.encodings = [{}]
      params.encodings[0].maxBitrate = screenBitrate(quality)
      params.encodings[0].maxFramerate = quality.frameRate
      // 设置页的「画质优先」：保帧率适合操作演示，保分辨率适合文字/代码。
      params.degradationPreference =
        this.degradation === 'resolution' ? 'maintain-resolution' : 'maintain-framerate'
      await sender.setParameters(params)
    } catch {
      /* 部分 WebView2 版本不允许动态改参数，退回 SDP 默认值 */
    }
  }

  /**
   * WebView2 默认把软件编码器排前面（VP8/VP9），1728×1080 实测只有个位数帧率。
   * 优先 H.264：Windows 上是 MediaFoundation 硬件编码，屏幕共享 1080p 能跑满 30。
   * AV1 软件编码最慢，放到最后。
   */
  private preferCodecs(transceiver: RTCRtpTransceiver) {
    try {
      const capabilities = RTCRtpSender.getCapabilities?.('video')
      if (!capabilities?.codecs.length || typeof transceiver.setCodecPreferences !== 'function') {
        return
      }
      const rank = (mimeType: string) => {
        const mime = mimeType.toLowerCase()
        if (mime.includes('h264')) return 0
        if (mime.includes('vp8')) return 1
        if (mime.includes('vp9')) return 2
        if (mime.includes('av1')) return 4
        return 3
      }
      const codecs = [...capabilities.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType))
      transceiver.setCodecPreferences(codecs)
    } catch {
      /* 旧版 WebView2 不支持时保持默认协商结果 */
    }
  }

  private createPeer(
    iceServers: string[],
    role: 'sharer' | 'viewer',
    shareId: string,
    peerId: string,
  ) {
    const pc = new RTCPeerConnection({
      iceServers: iceServers.map((urls) => ({ urls })),
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    })
    pc.onicecandidate = (event) => {
      if (!event.candidate) return
      this.send(peerId, {
        type: 'ice',
        shareId,
        role,
        candidate: event.candidate.toJSON(),
      })
    }
    return pc
  }

  private closeViewer(shareId: string) {
    const pc = this.viewerPcs.get(shareId)
    if (pc) {
      pc.close()
      this.viewerPcs.delete(shareId)
    }
    this.pendingIce.delete(shareId)
    this.detachRemoteAudio()
  }

  private closeSharer(shareId: string, viewer: string) {
    const key = `${shareId}:${viewer}`
    const pc = this.sharerPcs.get(key)
    if (pc) {
      pc.close()
      this.sharerPcs.delete(key)
    }
    this.pendingIce.delete(key)
    this.stopEncodeStats(key)
    this.set({ viewerCount: this.sharerPcs.size })
  }

  private teardownAll() {
    for (const pc of this.viewerPcs.values()) pc.close()
    for (const pc of this.sharerPcs.values()) pc.close()
    this.viewerPcs.clear()
    this.sharerPcs.clear()
    this.clearStatsTimers()
    this.pendingIce.clear()
    this.stopAudioPump()
    this.detachRemoteAudio()
    void this.generatorWriter?.close().catch(() => {})
    this.generatorWriter = null
    this.localTrack?.stop()
    this.localTrack = null
    this.captureGeneration += 1
    this.captureId = null
    this.set({
      shares: [],
      sharing: undefined,
      viewing: undefined,
      viewerBusy: undefined,
      peers: [],
      localStream: undefined,
      viewerCount: 0,
      captureStats: undefined,
    })
  }
}

export const screenShare = new ScreenShareClient()

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  Activity,
  ClipboardPaste,
  Copy,
  Eye,
  Gauge,
  Loader2,
  Lock,
  Maximize2,
  Minimize2,
  Monitor,
  MonitorUp,
  Plus,
  RefreshCw,
  Radio,
  Square,
  TriangleAlert,
  Users,
  Volume2,
  VolumeX,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react'
import {
  assessNetwork,
  normalizeQuality,
  screenBitrate,
  screenShare,
  SHARE_FRAME_RATES,
  SHARE_RESOLUTIONS,
  saveShareQuality,
  type ShareQuality,
  type ShareSession,
} from '../screenShare'
import { decodeInvite, encodeInvite, type ShareInvite } from '../screenShareInvite'
import { isTauri, protocol } from '../protocol'
import type { Settings } from '../settings'

interface Props {
  channelId: string
  channelName: string
  nickname: string
  connected: boolean
  demoMode: boolean
  settings: Settings
  invite?: ShareInvite | null
  onChangeSettings: (patch: Partial<Settings>) => void
  onJoinInvite: (invite: ShareInvite) => void
  onInviteApplied: () => void
  onToast: (message: string) => void
}

const PHASE_LABEL = {
  offline: '未开启',
  starting: '连接中',
  online: '已就绪',
  error: '异常',
} as const

const BITRATE_OPTIONS = [0, 4, 8, 16, 32, 64] as const

const LIMITATION_LABEL: Record<string, string> = {
  bandwidth: '带宽受限',
  cpu: 'CPU 受限',
  other: '编码受限',
}

/** bandwidth 既可能是网络不够，也可能只是撞到自设的 maxBitrate。 */
function limitationText(limitation: string, bitrateKbps: number, capMbps: number): string {
  if (limitation === 'bandwidth') {
    return bitrateKbps / 1000 >= capMbps * 0.8 ? '已达码率上限' : '网络带宽不足'
  }
  return LIMITATION_LABEL[limitation] ?? '受限'
}

type LogLevel = 'error' | 'warn' | 'info'

function logLevel(line: string): LogLevel {
  if (/\b(error|fatal|panic|failed)\b|失败|错误|异常/i.test(line)) return 'error'
  if (/\b(warn|warning)\b|警告|超时/i.test(line)) return 'warn'
  return 'info'
}

function probeAge(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`
}

export function ScreenSharePage({
  channelId,
  channelName,
  nickname,
  connected,
  demoMode,
  settings,
  invite,
  onChangeSettings,
  onJoinInvite,
  onInviteApplied,
  onToast,
}: Props) {
  const state = useSyncExternalStore(screenShare.subscribe, screenShare.getSnapshot)
  const [pin, setPin] = useState('')
  const [manualIp, setManualIp] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [shareCode, setShareCode] = useState('')
  const [nodeId, setNodeId] = useState('')
  const [customUri, setCustomUri] = useState('')
  const [testingNode, setTestingNode] = useState('')
  const [sourceId, setSourceId] = useState('')
  const [quality, setQuality] = useState<ShareQuality>(state.quality)
  const [busy, setBusy] = useState('')
  const [sourcesBusy, setSourcesBusy] = useState(false)
  const [viewStats, setViewStats] = useState<{ width: number; height: number; fps: number } | null>(
    null,
  )
  const [selfTest, setSelfTest] = useState<string[]>([])
  const [theater, setTheater] = useState(false)
  const localVideo = useRef<HTMLVideoElement>(null)
  const remoteVideo = useRef<HTMLVideoElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const startedChannel = useRef('')

  // 真实频道 ID 是纯数字（后端 ChannelDto 用 channel.id.to_string()），
  // 但组/旧数据可能带 c 前缀，两种都接受；空串不能当 0。
  const roomChannelId = useMemo(() => {
    const raw = channelId.startsWith('c') ? channelId.slice(1) : channelId
    if (!raw) return null
    const value = Number(raw)
    return Number.isInteger(value) && value >= 0 ? value : null
  }, [channelId])

  const online = state.phase === 'online'
  const share = state.sharing
  const viewingShare = state.viewing
    ? state.shares.find((item) => item.shareId === state.viewing?.shareId)
    : undefined
  const logErrors = state.logs.filter((line) => logLevel(line) === 'error').length
  const logWarnings = state.logs.filter((line) => logLevel(line) === 'warn').length
  const net = settings.shareNetwork
  const customNodes = net.customNodes
  const probeById = useMemo(
    () => new Map(state.nodes.map((node) => [node.id, node])),
    [state.nodes],
  )
  // 内置节点来自 Rust CATALOG，未测速也照常展示、可选；自定义节点排在最前面。
  const nodeRows = useMemo(() => {
    const catalogUris = new Set(state.catalog.map((option) => option.uri))
    return [
      ...customNodes
        .filter((uri) => !catalogUris.has(uri))
        .map((uri) => ({
          key: uri,
          id: uri,
          label: uri.replace(/^[a-z]+:\/\//i, ''),
          uri,
          custom: true,
          probe: probeById.get(uri),
        })),
      ...state.catalog.map((option) => ({
        key: option.id,
        id: option.id,
        label: option.label,
        uri: option.uri,
        custom: false,
        probe: probeById.get(option.id),
      })),
    ]
  }, [state.catalog, customNodes, probeById])
  const testedReachable = useMemo(
    () =>
      [...state.nodes]
        .filter((node) => node.reachable)
        .sort((a, b) => (a.latencyMs ?? Infinity) - (b.latencyMs ?? Infinity)),
    [state.nodes],
  )
  const autoProbe = testedReachable[0]
  const selectedProbe = nodeId ? probeById.get(nodeId) : undefined
  // 选中了未测速的自定义节点时不要拿别的节点冒充评估结果。
  const bestProbe = nodeId
    ? selectedProbe?.reachable
      ? selectedProbe
      : undefined
    : autoProbe
  const assessment = assessNetwork(bestProbe, net.transport)
  // 启动时不再测速，把已测过的可达节点按延迟顺序交给后端做兜底。
  const peerUris = testedReachable.slice(0, 4).map((node) => node.uri)
  const onlineLatency = state.info
    ? (state.info.nodeLatencyMs ??
      state.nodes.find((node) => node.uri === state.info?.nodeUri)?.latencyMs ??
      null)
    : null
  const transportLabel =
    net.transport === 'p2p' ? '仅 P2P' : net.transport === 'relay' ? '仅中继' : '直连优先'
  const netPolicy = [
    transportLabel,
    net.degradation === 'resolution' ? '清晰优先' : '流畅优先',
    `MTU ${net.mtu || '自动'}`,
    `压缩 ${net.compression === 'zstd' ? 'zstd' : '关'}`,
    net.multiRelay ? null : '单节点',
  ]
    .filter(Boolean)
    .join(' · ')

  useEffect(() => {
    void screenShare.init()
  }, [])

  useEffect(() => {
    if (!invite) return
    setPin(invite.pin)
    setNodeId(invite.customNode || invite.nodeId)
    if (invite.customNode && !customNodes.includes(invite.customNode)) {
      onChangeSettings({
        shareNetwork: {
          ...net,
          customNodes: [...customNodes, invite.customNode].slice(0, 6),
        },
      })
    }
    onToast(
      `已套用邀请码：${invite.channelName || invite.channelId}${invite.pin ? '（含房间 PIN）' : ''}`,
    )
    onInviteApplied()
  }, [invite, onInviteApplied, onToast, onChangeSettings, customNodes, net])

  useEffect(() => {
    if (!online) return
    setSourcesBusy(true)
    void screenShare
      .refreshSources()
      .then((sources) => {
        setSourceId((current) => current || sources.find((item) => item.kind === 'monitor')?.id || sources[0]?.id || '')
      })
      .catch(() => {})
      .finally(() => setSourcesBusy(false))
  }, [online])

  useEffect(() => {
    if (localVideo.current && state.localStream) {
      localVideo.current.srcObject = state.localStream
    }
  }, [state.localStream])

  useEffect(() => {
    if (remoteVideo.current) {
      remoteVideo.current.srcObject = state.viewing?.stream ?? null
    }
  }, [state.viewing])

  // 全屏观看/预览：Tauri 侧把窗口本身切成全屏（WebView2 的 DOM Fullscreen
  // 只会铺满客户区），stage 再用 fixed 覆盖整个窗口；浏览器演示模式退回 DOM Fullscreen。
  const setFullscreenMode = async (next: boolean) => {
    setTheater(next)
    if (isTauri) {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        await getCurrentWindow().setFullscreen(next)
      } catch {
        /* 窗口全屏失败时仍保留页面内覆盖层 */
      }
      return
    }
    try {
      if (next) await stageRef.current?.requestFullscreen()
      else if (document.fullscreenElement) await document.exitFullscreen()
    } catch {
      /* 浏览器拒绝全屏时保持窗口内展示 */
    }
  }

  // 全屏时连自带标题栏一起让位：它有自己的层叠上下文，会压在 fixed 舞台上面。
  useEffect(() => {
    document.body.classList.toggle('rayspeak-theater', theater)
    return () => document.body.classList.remove('rayspeak-theater')
  }, [theater])

  useEffect(() => {
    if (!theater) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void setFullscreenMode(false)
    }
    const onFullscreenChange = () => {
      if (!document.fullscreenElement) setTheater(false)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFullscreenChange)
    }
  }, [theater])

  // 共享/观看结束后必须退出全屏，否则应用壳还压在覆盖层下面。
  useEffect(() => {
    if (theater && !state.viewing && !state.sharing) void setFullscreenMode(false)
  }, [theater, state.viewing, state.sharing])

  // 观看端用 requestVideoFrameCallback 统计真正解码上屏的帧率与分辨率。
  useEffect(() => {
    const element = remoteVideo.current
    if (!state.viewing || !element) {
      setViewStats(null)
      return
    }
    const video = element as HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: (now: number, metadata: { width: number; height: number }) => void,
      ) => number
      cancelVideoFrameCallback?: (handle: number) => void
    }
    if (typeof video.requestVideoFrameCallback !== 'function') {
      const sync = () =>
        setViewStats({
          width: video.videoWidth,
          height: video.videoHeight,
          fps: 0,
        })
      element.addEventListener('loadedmetadata', sync)
      return () => element.removeEventListener('loadedmetadata', sync)
    }
    let frames = 0
    let started = performance.now()
    let handle = 0
    let cancelled = false
    const tick = (now: number, metadata: { width: number; height: number }) => {
      if (cancelled) return
      frames += 1
      if (now - started >= 1000) {
        setViewStats({
          width: metadata.width,
          height: metadata.height,
          fps: Math.max(1, Math.round((frames * 1000) / (now - started))),
        })
        frames = 0
        started = now
      }
      handle = video.requestVideoFrameCallback?.(tick) ?? 0
    }
    handle = video.requestVideoFrameCallback(tick)
    return () => {
      cancelled = true
      video.cancelVideoFrameCallback?.(handle)
    }
  }, [state.viewing])

  useEffect(() => {
    if (!online) {
      startedChannel.current = ''
      return
    }
    if (!startedChannel.current) {
      startedChannel.current = channelId
      return
    }
    if (startedChannel.current !== channelId) {
      startedChannel.current = ''
      void screenShare.stopNetwork().then(() => onToast('已切换频道，屏幕共享网络已关闭'))
    }
  }, [channelId, online, onToast])

  useEffect(() => {
    if (!connected && online) {
      void screenShare.stopNetwork()
      onToast('已断开服务器，屏幕共享网络已关闭')
    }
  }, [connected, online, onToast])

  const startNetwork = async () => {
    if (roomChannelId == null) {
      onToast('请先进入一个真实语音频道')
      return
    }
    setBusy('network')
    try {
      const info = await screenShare.startNetwork({
        channelId: roomChannelId,
        nickname,
        pin,
        node: nodeId || undefined,
        peers: peerUris,
        network: net,
      })
      onToast(`EasyTier 网络已就绪（${info.nodeLabel || '自动节点'}）`)
      void screenShare.refreshLogs()
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const probeNodes = () => {
    void screenShare
      .probeNodes(customNodes)
      .then((nodes) => {
        const best = nodes.find((node) => node.reachable)
        const advice = assessNetwork(best, net.transport)
        onToast(
          best
            ? `测速完成：最快 ${best.label} · ${best.latencyMs?.toFixed(0)}ms${
                advice ? `，网络${advice.label}` : ''
              }`
            : '所有节点都不可达，请检查网络或添加一个自定义节点',
        )
      })
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error)))
  }

  const testNode = (target: string, label: string) => {
    if (testingNode) return
    setTestingNode(target)
    void screenShare
      .probeNode(target)
      .then((probe) => {
        if (!probe) {
          onToast('无法识别这个节点地址')
          return
        }
        onToast(
          probe.reachable
            ? `${label} · ${probe.latencyMs?.toFixed(0)}ms${
                probe.jitterMs != null && probe.jitterMs > 25
                  ? `（抖动 ±${probe.jitterMs.toFixed(0)}ms）`
                  : ''
              }`
            : `${label} 不可达`,
        )
      })
      .catch((error: unknown) => onToast(error instanceof Error ? error.message : String(error)))
      .finally(() => setTestingNode(''))
  }

  const addCustomNode = () => {
    const uri = customUri.trim()
    if (!/^(tcp|udp|ws|wss):\/\/[^\s/]{3,120}$/i.test(uri)) {
      onToast('地址格式应为 tcp://host:port（也支持 udp/ws/wss）')
      return
    }
    if (customNodes.includes(uri)) {
      onToast('这个节点已经在列表里')
      return
    }
    onChangeSettings({
      shareNetwork: { ...net, customNodes: [...customNodes, uri].slice(0, 6) },
    })
    setNodeId(uri)
    setCustomUri('')
    onToast('已添加自定义节点，点「测速」可以查看延迟')
  }

  const removeCustomNode = (uri: string) => {
    onChangeSettings({
      shareNetwork: { ...net, customNodes: customNodes.filter((item) => item !== uri) },
    })
    if (nodeId === uri) setNodeId('')
  }

  const applySuggestion = () => {
    if (!assessment) return
    const next: ShareQuality = {
      ...quality,
      resolution: assessment.suggestion.resolution,
      frameRate: assessment.suggestion.frameRate,
      bitrateMbps: 0,
    }
    setQuality(next)
    saveShareQuality(next)
    onToast(
      `已套用建议画质：${next.resolution}p${next.frameRate}（自动码率）${
        share ? '，重新开始共享后生效' : ''
      }`,
    )
  }

  const copyInvite = async () => {
    if (!online || !state.info) {
      onToast('请先开启共享网络，再生成邀请码')
      return
    }
    const code = encodeInvite({
      version: 1,
      channelId,
      channelName,
      nodeId: state.info.nodeId || (nodeId.includes('://') ? '' : nodeId),
      customNode: state.info.nodeId ? '' : state.info.nodeUri,
      pin,
    })
    setShareCode(code)
    try {
      await navigator.clipboard.writeText(code)
      onToast('邀请码已复制，发给同一服务器上的好友')
    } catch {
      onToast('剪贴板不可用，请手动复制下方邀请码')
    }
  }

  const joinByCode = () => {
    const decoded = decodeInvite(inviteCode)
    if (!decoded) {
      onToast('邀请码无效')
      return
    }
    setInviteCode('')
    onJoinInvite(decoded)
  }

  // 一键自检：节点测速 → 启动网络（UAC）→ 虚拟网卡/信令 → 等待同房间成员。
  const runSelfTest = async () => {
    if (roomChannelId == null) {
      onToast('请先进入真实语音频道')
      return
    }
    setBusy('selftest')
    const lines: string[] = []
    const push = (line: string) => {
      lines.push(line)
      setSelfTest(lines.slice())
    }
    try {
      const nodes = await screenShare.probeNodes(customNodes)
      const reachable = nodes.filter((node) => node.reachable)
      const fastest = reachable[0]
      const advice = assessNetwork(fastest, net.transport)
      push(
        `① 节点：${reachable.length}/${nodes.length} 可达` +
          (fastest?.latencyMs != null
            ? `，最快 ${fastest.label} ${fastest.latencyMs.toFixed(0)}ms`
            : '') +
          (advice ? `；网络${advice.label}，建议 ${advice.suggestion.resolution}p${advice.suggestion.frameRate}` : ''),
      )
      if (!isTauri || demoMode) {
        push('桌面版才能测试虚拟网卡与信令')
        return
      }
      let info = screenShare.getSnapshot().info
      if (screenShare.getSnapshot().phase !== 'online' || !info) {
        push('② 启动 EasyTier（会请求管理员权限）…')
        info = await screenShare.startNetwork({
          channelId: roomChannelId,
          nickname,
          pin,
          node: nodeId || undefined,
          peers: reachable.slice(0, 4).map((node) => node.uri),
          network: net,
        })
      }
      push(`② 虚拟网卡：${info.ip}，信令端口 ${info.signalPort}`)
      const latency =
        info.nodeLatencyMs ?? nodes.find((node) => node.uri === info.nodeUri)?.latencyMs ?? null
      push(
        `③ 主节点：${info.nodeLabel || '自动'}` +
          (latency != null ? ` · ${latency.toFixed(0)}ms` : ''),
      )
      push('④ 等待同房间成员（最多 10 秒）…')
      let connected = 0
      for (let i = 0; i < 5; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000))
        const peers = await protocol.sharePeers()
        connected = peers.filter((peer) => peer.connected).length
        if (connected > 0) break
      }
      push(
        connected > 0
          ? `✅ 已与 ${connected} 位成员连通，可以开始共享`
          : '⚠ 网络已就绪，但还没发现成员：让好友在同一频道导入邀请码后也开启共享网络',
      )
    } catch (error) {
      push(`❌ ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy('')
    }
  }

  const startSharing = async () => {
    if (!sourceId) {
      onToast('请选择要共享的屏幕或窗口')
      return
    }
    setBusy('share')
    try {
      await screenShare.startSharing(sourceId, normalizeQuality(quality), {
        degradation: net.degradation,
      })
      saveShareQuality(quality)
      onToast('屏幕共享已开始')
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const watch = async (session: ShareSession) => {
    setBusy(`watch:${session.shareId}`)
    try {
      await screenShare.watch(session)
    } catch (error) {
      onToast(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy('')
    }
  }

  const connectedPeers = state.peers.filter((peer) => peer.connected).length
  const startDisabled =
    !isTauri ||
    demoMode ||
    !connected ||
    roomChannelId == null ||
    busy !== '' ||
    state.phase === 'starting'
  const startHint = demoMode || !isTauri
    ? '屏幕共享需要桌面版 RaySpeak'
    : !connected
      ? '连接服务器并进入语音频道后才能开启'
      : roomChannelId == null
        ? '当前不是真实语音频道'
        : ''

  const bitrateCapMbps = share ? screenBitrate(share.quality) / 1_000_000 : 0
  const encodeStats = state.encodeStats
  const encodeMbps = encodeStats ? encodeStats.bitrateKbps / 1000 : 0

  return (
    <div className="share-page">
      <aside className="share-side">
        <header className="share-side-head">
          <div>
            <h2>屏幕共享</h2>
            <p>{channelName} · EasyTier 虚拟网</p>
          </div>
          <span className={`share-net-pill ${state.phase}`}>
            <span className="dot" />
            {PHASE_LABEL[state.phase]}
          </span>
        </header>

        {online && state.info ? (
          <>
            <section className="share-card">
              <div className="share-card-title">
                <Wifi size={14} strokeWidth={2} />
                共享网络
              </div>
              <div className="share-net-grid">
                <div>
                  <span>虚拟 IP</span>
                  <b>{state.info.ip}</b>
                </div>
                <div>
                  <span>
                    中继节点
                    {onlineLatency != null ? ` · ${onlineLatency.toFixed(0)}ms` : ''}
                  </span>
                  <b title={state.info.nodeLabel || '自动'}>{state.info.nodeLabel || '自动'}</b>
                </div>
                <div>
                  <span>信令端口</span>
                  <b>{state.info.signalPort}</b>
                </div>
                <div>
                  <span>房间成员</span>
                  <b>
                    {connectedPeers}/{state.peers.length}
                  </b>
                </div>
              </div>
              <div className="share-card-actions">
                <button className="ghost-btn" onClick={() => void copyInvite()}>
                  <Copy size={13} /> 复制邀请码
                </button>
                <button
                  className="ghost-btn danger"
                  onClick={() => void screenShare.stopNetwork()}
                >
                  <WifiOff size={13} /> 停止网络
                </button>
              </div>
              {shareCode && (
                <input
                  className="share-code"
                  readOnly
                  value={shareCode}
                  onFocus={(event) => event.currentTarget.select()}
                />
              )}
              <p className="share-hint">
                把邀请码发给同一台服务器上的好友；画面经 EasyTier 公共节点传输，不经过
                TeamSpeak 服务器，语音频道不受影响。
              </p>
              <p className="share-hint">
                传输：{netPolicy} · 底层参数在「设置 → 网络与高级」调整，下次开启生效。
              </p>
            </section>

            <section className="share-card">
              <div className="share-card-title">
                <Radio size={14} strokeWidth={2} />
                正在共享
                <span className="share-count">
                  {state.shares.length + (share ? 1 : 0)}
                </span>
              </div>
              {!share && state.shares.length === 0 ? (
                <p className="share-hint">还没有人共享屏幕。在下方选好来源即可开始。</p>
              ) : (
                <ul className="share-shares">
                  {share && (
                    <li className="mine">
                      <div>
                        <b>我的共享</b>
                        <span>
                          {share.sourceName} · {share.quality.resolution}p ·{' '}
                          {share.quality.frameRate}fps
                          {share.hasAudio ? ' · 含声音' : ''} · {state.viewerCount} 人观看
                        </span>
                      </div>
                      <span className="share-owner-pill">共享中</span>
                    </li>
                  )}
                  {state.shares.map((session) => (
                    <li key={session.shareId}>
                      <div>
                        <b>{session.name}</b>
                        <span>
                          {session.sourceName} · {session.quality.resolution}p ·{' '}
                          {session.quality.frameRate}fps
                          {session.hasAudio ? ' · 含声音' : ''}
                        </span>
                      </div>
                      <button
                        className="ghost-btn"
                        disabled={busy === `watch:${session.shareId}`}
                        onClick={() => void watch(session)}
                      >
                        {busy === `watch:${session.shareId}` ? (
                          <Loader2 size={13} className="spin" />
                        ) : (
                          <Eye size={13} />
                        )}
                        观看
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="share-card">
              <div className="share-card-title">
                <Users size={14} strokeWidth={2} />
                房间成员
                <span className="share-count">
                  {connectedPeers}/{state.peers.length}
                </span>
              </div>
              <ul className="share-peers">
                <li className="online self">
                  <span className="share-peer-dot" />
                  <span className="share-peer-name">{nickname}（你）</span>
                  <span className="share-peer-meta">{state.info?.ip}</span>
                </li>
                {state.peers.map((peer) => (
                  <li key={peer.peerId} className={peer.connected ? 'online' : ''}>
                    <span className="share-peer-dot" />
                    <span className="share-peer-name">{peer.nickname || peer.peerId}</span>
                    <span className="share-peer-meta">
                      {peer.connected
                        ? peer.latencyMs
                          ? `${peer.latencyMs.toFixed(0)}ms`
                          : '已连接'
                        : peer.ip}
                    </span>
                  </li>
                ))}
              </ul>
              {state.peers.length === 0 && (
                <p className="share-hint">
                  目前只有你。好友要在同一台服务器、同一频道打开共享页并开启共享网络，
                  才会出现在这里（0/0 不代表故障）。
                </p>
              )}
              <details className="share-join">
                <summary>
                  <ClipboardPaste size={12} /> 用邀请码加入好友的网络
                </summary>
                <div className="share-manual">
                  <input
                    value={inviteCode}
                    placeholder="粘贴好友的邀请码"
                    onChange={(event) => setInviteCode(event.target.value)}
                  />
                  <button className="ghost-btn" disabled={!inviteCode.trim()} onClick={joinByCode}>
                    <ClipboardPaste size={13} /> 导入
                  </button>
                </div>
              </details>
              <details className="share-join">
                <summary>
                  <Users size={12} /> 手动连接对方虚拟 IP
                </summary>
                <div className="share-manual">
                  <input
                    value={manualIp}
                    maxLength={15}
                    placeholder="例如 10.126.126.2"
                    onChange={(event) => setManualIp(event.target.value)}
                  />
                  <button
                    className="ghost-btn"
                    disabled={!manualIp.trim()}
                    onClick={() => {
                      void screenShare
                        .connectPeer(manualIp)
                        .then(() => {
                          setManualIp('')
                          onToast('已发起虚拟网直连')
                        })
                        .catch((error: unknown) =>
                          onToast(error instanceof Error ? error.message : String(error)),
                        )
                    }}
                  >
                    连接
                  </button>
                </div>
              </details>
            </section>
          </>
        ) : (
          <>
            <section className="share-card">
              <div className="share-card-title">
                <WifiOff size={14} strokeWidth={2} />
                第一步 · 开启共享网络
              </div>
              <p className="share-hint">
                首次开启需要管理员授权：EasyTier 会在本机创建一块虚拟网卡，与同频道成员直连。
                网络只用于传画面和信令，不影响语音。
              </p>
              <p className="share-hint">
                传输：{netPolicy} · 底层参数在「设置 → 网络与高级」调整。
              </p>
              <div className="share-node-head">
                <span>中继节点</span>
                <button
                  className="ghost-btn"
                  disabled={state.probing || testingNode !== '' || !isTauri}
                  onClick={probeNodes}
                >
                  <RefreshCw size={13} className={state.probing ? 'spin' : ''} />
                  {state.probing
                    ? '测速中…'
                    : state.probedAt
                      ? '重新全部测速'
                      : '全部测速'}
                </button>
              </div>
              <div className="share-node-list" role="radiogroup" aria-label="中继节点">
                <label className={`share-node-item ${nodeId === '' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="share-node"
                    checked={nodeId === ''}
                    onChange={() => setNodeId('')}
                  />
                  <span className="share-node-name">自动（最快可达）</span>
                  <span className="share-node-meta">
                    {autoProbe
                      ? `${autoProbe.label} · ${autoProbe.latencyMs?.toFixed(0)}ms`
                      : '未测速'}
                  </span>
                </label>
                {nodeRows.map((row) => (
                  <label
                    key={row.key}
                    className={`share-node-item ${nodeId === row.id ? 'selected' : ''}${
                      row.probe && !row.probe.reachable ? ' dead' : ''
                    }`}
                  >
                    <input
                      type="radio"
                      name="share-node"
                      value={row.id}
                      checked={nodeId === row.id}
                      onChange={() => setNodeId(row.id)}
                    />
                    <span className="share-node-name" title={row.uri}>
                      {row.label}
                    </span>
                    <span className="share-node-meta">
                      {row.probe
                        ? row.probe.reachable
                          ? `${row.probe.latencyMs?.toFixed(0)}ms${
                              row.probe.jitterMs != null && row.probe.jitterMs > 25
                                ? ` ±${row.probe.jitterMs.toFixed(0)}`
                                : ''
                            }`
                          : '不可达'
                        : '未测速'}
                    </span>
                    <span className="share-node-actions">
                      <button
                        type="button"
                        className="share-node-test"
                        title="只测这个节点"
                        disabled={state.probing || testingNode !== ''}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          testNode(row.id, row.label)
                        }}
                      >
                        <RefreshCw
                          size={11}
                          className={testingNode === row.id ? 'spin' : ''}
                        />
                      </button>
                      {row.custom && (
                        <button
                          type="button"
                          className="share-node-test"
                          title="移除自定义节点"
                          onClick={(event) => {
                            event.preventDefault()
                            event.stopPropagation()
                            removeCustomNode(row.uri)
                          }}
                        >
                          <X size={11} />
                        </button>
                      )}
                    </span>
                  </label>
                ))}
                {nodeRows.length === 0 && (
                  <p className="share-hint">内置节点目录加载中；也可以先添加自定义节点。</p>
                )}
              </div>
              {nodeId && !selectedProbe && (
                <p className="share-hint">选中的节点还没测速；点行尾的刷新图标可以只测它。</p>
              )}
              {state.probedAt > 0 && (
                <p className="share-hint">
                  上次测速：{probeAge(state.probedAt)} · 点行尾图标只测该节点，点「全部测速」重新探测
                </p>
              )}
              {assessment && (
                <div className={`share-assess ${assessment.grade}`}>
                  <div>
                    <b>
                      网络{assessment.label} · 建议最高 {assessment.suggestion.resolution}p
                      {assessment.suggestion.frameRate}
                    </b>
                    <span>
                      自动码率约 {(screenBitrate(assessment.suggestion) / 1_000_000).toFixed(0)}{' '}
                      Mbps · {assessment.note}
                    </span>
                  </div>
                  <button className="ghost-btn" onClick={applySuggestion}>
                    应用
                  </button>
                </div>
              )}
              <details className="share-custom-node">
                <summary>
                  <Plus size={12} /> 添加自定义节点
                </summary>
                <div className="share-manual">
                  <input
                    value={customUri}
                    placeholder="tcp://your-relay:11010"
                    onChange={(event) => setCustomUri(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') addCustomNode()
                    }}
                  />
                  <button
                    className="ghost-btn"
                    disabled={!customUri.trim()}
                    onClick={addCustomNode}
                  >
                    添加
                  </button>
                </div>
                <p className="share-hint">
                  支持 tcp / udp / ws / wss；添加后出现在列表里，可单独测速。邀请码会带上
                  自定义节点，好友导入后自动使用同一个。
                </p>
              </details>
              <label className="share-pin">
                <Lock size={13} strokeWidth={2} />
                <input
                  value={pin}
                  maxLength={32}
                  placeholder="可选：房间 PIN（双方一致）"
                  onChange={(event) => setPin(event.target.value)}
                />
              </label>
              <button
                className="primary-btn"
                disabled={startDisabled}
                onClick={() => void startNetwork()}
              >
                {busy === 'network' ? <Loader2 size={14} className="spin" /> : <Wifi size={14} />}
                开启共享网络
              </button>
              {startHint && <p className="share-hint">{startHint}</p>}
              {state.error && <p className="share-error">{state.error}</p>}
            </section>

            <section className="share-card">
              <div className="share-card-title">
                <ClipboardPaste size={14} strokeWidth={2} />
                已有好友的邀请码？
              </div>
              <p className="share-hint">
                导入后会切到对方所在频道，并套用相同的房间 PIN 与中继节点；再点上方
                「开启共享网络」即可接通。
              </p>
              <div className="share-manual">
                <input
                  value={inviteCode}
                  placeholder="粘贴邀请码（RS1.…）"
                  onChange={(event) => setInviteCode(event.target.value)}
                />
                <button className="ghost-btn" disabled={!inviteCode.trim()} onClick={joinByCode}>
                  <ClipboardPaste size={13} /> 导入
                </button>
              </div>
            </section>
          </>
        )}
      </aside>

      <main className="share-main">
        <div
          ref={stageRef}
          className={`share-stage ${state.viewing ? 'viewing' : share ? 'broadcasting' : ''}${
            theater ? ' is-theater' : ''
          }`}
        >
          {state.viewing ? (
            <video ref={remoteVideo} autoPlay playsInline className="share-video" />
          ) : share ? (
            <video ref={localVideo} autoPlay muted playsInline className="share-video" />
          ) : (
            <div className="share-empty">
              <span className="share-empty-orb" />
              <MonitorUp size={30} strokeWidth={1.6} />
              <strong>{online ? '选好画面来源，就可以开始了' : '共享你的屏幕'}</strong>
              <span>同一 EasyTier 房间内的成员可以实时观看，画面与语音互不干扰。</span>
              <ol className="share-steps">
                <li className={online ? 'done' : ''}>
                  <i>{online ? '✓' : '1'}</i>
                  开启共享网络
                </li>
                <li className={online ? '' : 'muted'}>
                  <i>2</i>
                  选择屏幕或窗口
                </li>
                <li className={online ? '' : 'muted'}>
                  <i>3</i>
                  发送邀请码给好友
                </li>
              </ol>
            </div>
          )}
          {state.viewing && (
            <div className="share-stage-badges">
              <span className="share-live-pill">
                <span className="share-dot" /> {state.viewing.name} 的画面
                {viewStats && viewStats.width > 0
                  ? ` · ${viewStats.width}×${viewStats.height}${viewStats.fps > 0 ? ` · ${viewStats.fps}fps` : ''}`
                  : ''}
              </span>
              <div className="share-stage-actions">
                {(viewingShare?.hasAudio || state.audioBlocked) && (
                  <button
                    className="ghost-btn"
                    title={state.audioMuted ? '取消静音' : '静音共享声音'}
                    onClick={() => screenShare.toggleRemoteAudio()}
                  >
                    {state.audioMuted ? <VolumeX size={12} /> : <Volume2 size={12} />}
                    {state.audioBlocked ? '点击播放声音' : state.audioMuted ? '已静音' : '声音'}
                  </button>
                )}
                <button
                  className="ghost-btn"
                  title={theater ? '退出全屏（Esc）' : '全屏观看'}
                  onClick={() => void setFullscreenMode(!theater)}
                >
                  {theater ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  {theater ? '退出全屏' : '全屏'}
                </button>
                <button className="ghost-btn" onClick={() => screenShare.stopWatching()}>
                  <Square size={12} /> 停止观看
                </button>
              </div>
            </div>
          )}
          {share && (
            <div className="share-stage-badges">
              <span
                className="share-live-pill"
                title={
                  encodeStats && encodeStats.limitation !== 'none' && bitrateCapMbps > 0
                    ? encodeMbps >= bitrateCapMbps * 0.8
                      ? `编码器已跑满当前码率上限（${bitrateCapMbps.toFixed(0)} Mbps）。帧率没有掉；想要更清晰可在工具栏调高码率，这是自设上限而非网络故障。`
                      : 'Chromium 估算的可用上行带宽低于码率上限，可能受公共中继节点或本地上行影响；降低码率/帧率可减少卡顿。'
                    : undefined
                }
              >
                <span className="share-dot" /> 正在共享 ·{' '}
                {state.captureStats
                  ? `${state.captureStats.width}×${state.captureStats.height} · ${
                      state.captureStats.fps > 0
                        ? `${state.captureStats.fps}fps`
                        : state.captureStats.arrived === 0
                          ? '画面静止'
                          : '0fps'
                    }`
                  : `${share.quality.resolution}p · ${share.quality.frameRate}fps`}
                {encodeStats
                  ? ` · 编码 ${encodeStats.fps}fps${
                      encodeStats.codec ? ` ${encodeStats.codec}` : ''
                    }${encodeMbps > 0 ? ` ${encodeMbps.toFixed(1)}Mbps` : ''}${
                      encodeStats.limitation !== 'none'
                        ? `（${limitationText(
                            encodeStats.limitation,
                            encodeStats.bitrateKbps,
                            bitrateCapMbps,
                          )}）`
                        : ''
                    }`
                  : ''}
              </span>
              <div className="share-stage-actions">
                <span className="share-viewers">
                  <Eye size={12} /> {state.viewerCount} 人观看
                </span>
                <button
                  className="ghost-btn"
                  title={theater ? '退出全屏（Esc）' : '全屏预览'}
                  onClick={() => void setFullscreenMode(!theater)}
                >
                  {theater ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                  {theater ? '退出全屏' : '全屏'}
                </button>
              </div>
            </div>
          )}
        </div>

        {share && state.captureStats && (state.captureStats.minimized || state.captureStats.error) && (
          <div className="share-warning">
            <TriangleAlert size={14} strokeWidth={2} />
            <div>
              {state.captureStats.minimized ? (
                <>
                  <b>被共享的窗口已最小化。</b>
                  Windows 对最小化窗口不再产帧，观众会停在最后一帧；还原窗口即自动恢复。
                  也可以停止共享后改选「显示器」。
                </>
              ) : (
                <>
                  <b>采集异常：</b>
                  {state.captureStats.error}
                  <span className="share-warning-hint">如持续出现，停止后重新选择来源即可。</span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="share-toolbar">
          {share ? (
            <>
              <div className="share-toolbar-info">
                <Monitor size={15} strokeWidth={1.9} />
                <div>
                  <b>{share.sourceName}</b>
                  <span>
                    编码上限 {bitrateCapMbps.toFixed(0)} Mbps
                    {share.quality.bitrateMbps ? '' : '（自动）'}
                    {state.captureStats
                      ? ` · 实际 ${state.captureStats.width}×${state.captureStats.height} · ${state.captureStats.fps}fps`
                      : ''}{' '}
                    · 系统声音 {share.hasAudio ? '开' : '关'} · {state.viewerCount} 位观众
                  </span>
                  {state.audioError && (
                    <span className="share-audio-error">系统声音不可用：{state.audioError}</span>
                  )}
                </div>
              </div>
              <button className="ghost-btn danger" onClick={() => void screenShare.stopSharing()}>
                <Square size={13} /> 停止共享
              </button>
            </>
          ) : (
            <>
              <div className="share-picker">
                <span>画面来源</span>
                <select value={sourceId} onChange={(event) => setSourceId(event.target.value)}>
                  {state.sources.length === 0 && <option value="">暂无可选来源</option>}
                  {state.sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.kind === 'monitor' ? '显示器' : '窗口'} · {source.name}
                      {source.width ? ` (${source.width}×${source.height})` : ''}
                    </option>
                  ))}
                </select>
                <button
                  className="ghost-btn icon"
                  title="刷新来源"
                  onClick={() => {
                    setSourcesBusy(true)
                    void screenShare.refreshSources().finally(() => setSourcesBusy(false))
                  }}
                >
                  <RefreshCw size={13} className={sourcesBusy ? 'spin' : ''} />
                </button>
              </div>
              <span className="share-toolbar-divider" />
              <div className="share-picker">
                <span>分辨率</span>
                <select
                  value={quality.resolution}
                  onChange={(event) => setQuality({ ...quality, resolution: Number(event.target.value) })}
                >
                  {SHARE_RESOLUTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value}p
                    </option>
                  ))}
                </select>
              </div>
              <div className="share-picker">
                <span>帧率</span>
                <select
                  value={quality.frameRate}
                  onChange={(event) => setQuality({ ...quality, frameRate: Number(event.target.value) })}
                >
                  {SHARE_FRAME_RATES.map((value) => (
                    <option key={value} value={value}>
                      {value}fps
                    </option>
                  ))}
                </select>
              </div>
              <div className="share-picker">
                <span>码率</span>
                <select
                  value={quality.bitrateMbps}
                  onChange={(event) => setQuality({ ...quality, bitrateMbps: Number(event.target.value) })}
                >
                  {BITRATE_OPTIONS.map((value) => (
                    <option key={value} value={value}>
                      {value ? `${value} Mbps` : '自动'}
                    </option>
                  ))}
                </select>
              </div>
              <label
                className={`share-toggle ${quality.systemAudio ? 'on' : ''}`}
                title="采集桌面声音（不含 RaySpeak 自己的语音），需要 Windows 10 2004+"
              >
                <input
                  type="checkbox"
                  checked={quality.systemAudio}
                  onChange={(event) => setQuality({ ...quality, systemAudio: event.target.checked })}
                />
                <span className="share-toggle-track" />
                系统声音
              </label>
              <button
                className="primary-btn"
                disabled={!online || busy !== '' || !sourceId}
                title={
                  !online
                    ? '请先在左侧开启共享网络'
                    : !sourceId
                      ? '请选择要共享的屏幕或窗口'
                      : undefined
                }
                onClick={() => void startSharing()}
              >
                {busy === 'share' ? <Loader2 size={14} className="spin" /> : <MonitorUp size={14} />}
                开始共享
              </button>
            </>
          )}
        </div>

        <p className="share-footnote">
          <Gauge size={12} />
          原生 Windows Graphics Capture 采集，画面不经过浏览器选屏器；EasyTier 只负责组网，不解析画面内容。
          系统声音可选（WASAPI 进程回环，已排除 RaySpeak 自身），关闭时完全不会采集声音。
        </p>

        {!demoMode && (
          <details className="share-diag">
            <summary>
              <Activity size={12} /> 连接诊断
              <span>
                {state.logs.length} 条日志
                {logErrors > 0 ? ` · ${logErrors} 错误` : ''}
                {logWarnings > 0 ? ` · ${logWarnings} 警告` : ''}
              </span>
            </summary>
            <div className="share-diag-body">
              <div className="share-diag-grid">
                <span>阶段</span>
                <b>{PHASE_LABEL[state.phase]}</b>
                <span>房间</span>
                <b>{state.info?.roomId.slice(0, 8) || '—'}</b>
                <span>中继节点</span>
                <b>{state.info?.nodeLabel || '—'}</b>
                <span>虚拟 IP</span>
                <b>{state.info?.ip || '—'}</b>
                <span>信令端口</span>
                <b>{state.info?.signalPort ?? '—'}</b>
                <span>成员</span>
                <b>
                  {connectedPeers}/{state.peers.length}
                </b>
                <span>采集帧率</span>
                <b>
                  {state.captureStats
                    ? `${state.captureStats.arrived}fps（WGC）`
                    : '—'}
                </b>
                <span>读回 + 缩放</span>
                <b>
                  {state.captureStats
                    ? `${state.captureStats.captureMs.toFixed(1)}ms`
                    : '—'}
                </b>
                <span>JPEG 编码</span>
                <b>
                  {state.captureStats
                    ? `${state.captureStats.buildMs.toFixed(1)}ms · ${state.captureStats.built}fps`
                    : '—'}
                </b>
                <span>交付帧率</span>
                <b>{state.captureStats ? `${state.captureStats.fps}fps` : '—'}</b>
                <span>帧体积</span>
                <b>{state.captureStats ? `${state.captureStats.kb} KB` : '—'}</b>
                <span>编码格式</span>
                <b>{state.encodeStats?.codec || '—'}</b>
                <span>编码器</span>
                <b>{state.encodeStats?.encoder || '—'}</b>
                <span>编码帧率</span>
                <b>
                  {state.encodeStats
                    ? `${state.encodeStats.fps}fps${
                        state.encodeStats.limitation !== 'none'
                          ? ` · ${limitationText(
                              state.encodeStats.limitation,
                              state.encodeStats.bitrateKbps,
                              bitrateCapMbps,
                            )}`
                          : ''
                      }`
                    : '—'}
                </b>
                <span>发送码率</span>
                <b>{state.encodeStats && state.encodeStats.bitrateKbps > 0 ? `${encodeMbps.toFixed(1)} / ${bitrateCapMbps.toFixed(0)} Mbps` : '—'}</b>
                <span>链路可用</span>
                <b>
                  {state.encodeStats && state.encodeStats.availableKbps > 0
                    ? `${(state.encodeStats.availableKbps / 1000).toFixed(1)} Mbps`
                    : '—'}
                </b>
              </div>
              <div className="share-diag-actions">
                <button
                  className="ghost-btn"
                  disabled={busy === 'selftest'}
                  onClick={() => void runSelfTest()}
                >
                  {busy === 'selftest' ? (
                    <Loader2 size={12} className="spin" />
                  ) : (
                    <Activity size={12} />
                  )}
                  连通自检
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => {
                    void screenShare.refreshLogs().then(() => onToast('EasyTier 日志已刷新'))
                  }}
                >
                  <RefreshCw size={12} /> 刷新日志
                </button>
                <button
                  className="ghost-btn"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(state.logs.join('\n'))
                      .then(() => onToast('日志已复制'))
                      .catch(() => onToast('复制失败'))
                  }}
                >
                  <Copy size={12} /> 复制日志
                </button>
              </div>
              {selfTest.length > 0 && (
                <pre className="share-log">{selfTest.join('\n')}</pre>
              )}
              {logErrors > 0 && (
                <p className="share-log-note">
                  EasyTier 的 ERROR 大多是节点探测与重连的自动重试（连上即停止），
                  以及本机已断开的虚拟网卡（TAP / 蓝牙 / VMware）上 169.254 地址的
                  绑定失败——这类重复行已自动过滤。只要阶段是「已就绪」、成员数正常，
                  就不影响共享；只有阶段变成「异常」或一直找不到成员时才需要处理。
                </p>
              )}
              <div className="share-log">
                {state.logs.length === 0 && <div className="share-log-line">暂无日志</div>}
                {state.logs.slice(-30).map((line, index) => (
                  <div key={`${index}-${line.slice(0, 12)}`} className={`share-log-line ${logLevel(line)}`}>
                    {line}
                  </div>
                ))}
              </div>
            </div>
          </details>
        )}
      </main>
    </div>
  )
}

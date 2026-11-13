import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  AudioLines,
  Bell,
  Check,
  CircleUserRound,
  Columns2,
  Copy,
  Info,
  Keyboard,
  LayoutGrid,
  LockKeyhole,
  Mic,
  Monitor,
  Moon,
  Palette,
  Play,
  Plus,
  RotateCcw,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Volume2,
  X,
} from 'lucide-react'
import type { Client } from '../types'
import {
  accentPresets,
  activeProcessPreset,
  audioProfilePatch,
  autoVadThreshold,
  backgroundPresets,
  defaultSettings,
  effectiveNoiseSuppressor,
  effectiveVadThreshold,
  isDark,
  newProfileId,
  noiseSuppressors,
  safeImage,
  voiceProcessPresets,
  type AudioProfile,
  type Settings,
} from '../settings'
import { groupMap } from '../data/mock'
import { CAPTURE_PROCESSOR, CAPTURE_WORKLET_SOURCE } from '../audio/captureWorklet'
import {
  errorText,
  listenEvent,
  pickSavePath,
  protocol,
  type NativeAudioStats,
} from '../protocol'
import {
  ensureNotifyPermission,
  playNotifyTone,
  showDesktopNotification,
} from '../notify'
import { stripClientTags } from '../utils/tsText'
import { clearLocalStore } from '../utils/localStore'
import {
  HotkeyInput,
  Segmented,
  Select,
  SetCard,
  SettingRow,
  Slider,
  Switch,
  TextInput,
} from './ui'

export type SettingsSection =
  | 'account'
  | 'audio'
  | 'appearance'
  | 'hotkeys'
  | 'notify'
  | 'privacy'
  | 'advanced'
  | 'about'

interface Props {
  settings: Settings
  clients: Client[]
  section: SettingsSection
  connected: boolean
  latency: number
  permissions: string[]
  demoMode: boolean
  onSection: (section: SettingsSection) => void
  onChange: (patch: Partial<Settings>) => void
  onAudioTestHold?: (active: boolean) => void
  onReset: () => void
  onClose: () => void
  onToast: (message: string) => void
}

const navItems: Array<{
  id: SettingsSection
  label: string
  desc: string
  icon: typeof CircleUserRound
}> = [
  { id: 'account', label: '我的账号', desc: '昵称、身份与在线状态', icon: CircleUserRound },
  { id: 'audio', label: '语音与音频', desc: '设备、处理与编码质量', icon: AudioLines },
  { id: 'appearance', label: '外观', desc: '主题、布局与背景', icon: Palette },
  { id: 'hotkeys', label: '快捷键', desc: '按键说话与应用内热键', icon: Keyboard },
  { id: 'notify', label: '通知', desc: '桌面提醒与勿扰模式', icon: Bell },
  { id: 'privacy', label: '隐私与安全', desc: '身份级别、屏蔽与在线状态', icon: ShieldCheck },
  { id: 'advanced', label: '网络与高级', desc: '连接、文件传输与诊断', icon: SlidersHorizontal },
  { id: 'about', label: '关于 RaySpeak', desc: '版本、技术栈与协议规划', icon: Info },
]

const protocolRows = [
  ['连接与身份', 'ECDH / RSA 谜题 / EAX 加密，身份导入导出，SRV·TSDNS', '内核已支持'],
  ['频道目录', '频道树、父子关系、icon_id、密码/人数/编解码、描述', '内核已支持'],
  ['成员与状态', '在线列表、静音/离开/频道指挥、服务器组名称、事件流', '内核已支持'],
  ['文字消息', '私聊 / 频道 / 服务器消息，Unicode 与事件回调', '内核已支持'],
  ['语音收发', 'Opus 原始包收发（codec 4/5），说话状态可由收包推导', '内核已支持'],
  ['文件与图标', '上传 / 下载 / 删除，频道、服务器组与虚拟服务器图标（明文 TCP）', '内核已支持'],
  ['服务器管理', '踢人/封禁/移动/频道创建编辑删除/自身资料已封装，其余走原始命令', '内核已支持'],
  ['频道组与资料', '频道组、客户端描述、平台与数据库 ID 通过 clientinfo 查询', '内核已支持'],
  ['音频处理', 'WebCodecs Opus、抖动缓冲、AEC/降噪、VAD、立体声与音乐模式', '内核已支持'],
  ['屏幕共享', '仅有插件命令与 WebRTC 信令通道，媒体传输需自建；当前仅本地预览', '需应用层'],
  ['ServerQuery', '内核不使用 10011 查询端口，管理命令走客户端连接', '内核不提供'],
  ['好友与头像', 'TS 协议无好友在线态与服务器头像，只能本地存储或生成', '内核不提供'],
] as const

const permissionChecks = [
  ['移动成员', ['i_client_move_power']],
  ['踢出成员', ['i_client_kick_power']],
  ['封禁成员', ['i_client_ban_power']],
  ['创建与编辑频道', ['b_channel_create_permanent', 'i_channel_create_modify_with_codec_opusvoice']],
  ['上传频道文件', ['b_filetransfer_upload']],
  ['删除频道', ['i_channel_delete_power', 'b_channel_delete_flag_force']],
] as const

const hotkeyRows = [
  ['ptt', '按键说话'],
  ['mute', '切换麦克风静音'],
  ['deafen', '切换扬声器闭麦'],
  ['settings', '打开设置'],
  ['disconnect', '断开语音连接'],
  ['layout', '切换房间布局'],
] as const

const appearancePresets: Array<{
  id: 'fresh' | 'immersive' | 'readable'
  name: string
  desc: string
  patch: Partial<Settings>
}> = [
  {
    id: 'fresh',
    name: '清爽',
    desc: '浅色 · 低模糊 · 标准面板',
    patch: {
      theme: 'light',
      blur: 8,
      panelOpacity: 80,
      contrast: 'normal',
      animations: true,
      cardStyle: 'raised',
    },
  },
  {
    id: 'immersive',
    name: '沉浸',
    desc: '深色 · 强模糊 · 半透明',
    patch: {
      theme: 'dark',
      blur: 24,
      panelOpacity: 60,
      contrast: 'normal',
      animations: true,
      cardStyle: 'flat',
    },
  },
  {
    id: 'readable',
    name: '高对比',
    desc: '清晰文字 · 不透明面板',
    patch: {
      contrast: 'high',
      blur: 6,
      panelOpacity: 100,
      animations: false,
      cardStyle: 'outline',
    },
  },
]

const METER_FLOOR_DB = -60

function dbToPercent(db: number) {
  return Math.max(0, Math.min(100, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100))
}

/**
 * 参考 TeamSpeak 3 / Discord 的输入电平条：实时电平 + 门限刻度 + 底噪标记，
 * 用户能直接看出「说话时有没有越过阈值」。
 */
function LevelMeter({
  db,
  threshold,
  floor,
  auto,
}: {
  db: number | null
  threshold: number
  floor: number | null
  auto: boolean
}) {
  const open = db !== null && db >= threshold
  return (
    <div className="level-meter">
      <div className="level-track">
        <div
          className="level-fill"
          style={{ width: `${db === null ? 0 : dbToPercent(db)}%` }}
        />
        <div
          className="level-peak"
          style={{ left: `${dbToPercent(threshold)}%` }}
          title={`发送阈值 ${threshold} dBFS`}
        />
        {floor !== null && (
          <div
            className="level-floor"
            style={{ left: `${dbToPercent(floor)}%` }}
            title={`环境底噪 ${floor.toFixed(0)} dBFS`}
          />
        )}
      </div>
      <div className="level-scale">
        <span>−60</span>
        <span>−40</span>
        <span>−20</span>
        <span>0 dBFS</span>
      </div>
      <div className="level-readout">
        <span className={open ? 'on' : ''}>
          {db === null ? '未在采集' : `${db.toFixed(0)} dBFS · ${open ? '发送中' : '静音'}`}
        </span>
        <span>
          阈值 {threshold} dBFS
          {auto ? ' · 自动' : ''}
          {floor !== null ? ` · 底噪 ${floor.toFixed(0)} dBFS` : ''}
        </span>
      </div>
    </div>
  )
}

function AboutRow({ label, value }: { label: string; value: ReactNode }) {  return (
    <div className="about-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

export function SettingsPage({
  settings,
  clients,
  section,
  connected,
  latency,
  permissions,
  demoMode,
  onSection,
  onChange,
  onAudioTestHold,
  onReset,
  onClose,
  onToast,
}: Props) {
  const [testing, setTesting] = useState(false)
  const [probing, setProbing] = useState(false)
  const [probeRows, setProbeRows] = useState<
    Array<{ device: string; hasSignal: boolean; rmsDbfs: number; peakDbfs: number }>
  >([])
  const [testDb, setTestDb] = useState<number | null>(null)
  const [liveDb, setLiveDb] = useState<number | null>(null)
  const [liveThreshold, setLiveThreshold] = useState<number | null>(null)
  const [liveFloor, setLiveFloor] = useState<number | null>(null)
  const [monitor, setMonitor] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const [granting, setGranting] = useState(false)
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceNote, setDeviceNote] = useState(
    '点击「刷新设备」授予麦克风权限后可显示完整设备名称',
  )
  const [appInfo, setAppInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const [nativeStats, setNativeStats] = useState<NativeAudioStats | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [profileName, setProfileName] = useState('')

  useEffect(() => {
    if (demoMode) return
    protocol
      .getAppInfo()
      .then(setAppInfo)
      .catch(() => {})
  }, [demoMode])

  const enumerateDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      setDeviceNote('当前系统不支持音频设备枚举')
      return []
    }
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      setDevices(list)
      if (list.length > 0 && list.every((device) => !device.label)) {
        setDeviceNote('设备名称需要授予麦克风权限后才会显示')
      } else {
        setDeviceNote(`已找到 ${list.filter((d) => d.kind !== 'videoinput').length} 个音频设备`)
      }
      return list
    } catch {
      setDeviceNote('无法读取音频设备列表')
      return []
    }
  }, [])

  useEffect(() => {
    if (section !== 'audio') return
    let disposed = false
    void (async () => {
      const list = await enumerateDevices()
      // 原生采集按设备名工作；如果从未授权过，label 全空，选择会退化成系统默认。
      // 只在开启原生采集时自动授权一次，避免普通用户莫名弹出麦克风权限。
      const noLabels = list.length > 0 && list.every((device) => !device.label)
      if (!disposed && noLabels && settings.nativeMic) await refreshDevices()
    })()
    const handler = () => void enumerateDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', handler)
    return () => {
      disposed = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', handler)
    }
  }, [section, enumerateDevices, settings.nativeMic])

  const refreshDevices = async (): Promise<MediaDeviceInfo[]> => {
    setGranting(true)
    try {
      // 授权时会短暂打开默认麦克风：先让原生采集释放设备。
      await waitForNativeRelease()
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      stream.getTracks().forEach((track) => track.stop())
    } catch {
      onToast('麦克风权限被拒绝，仅能显示默认设备')
    } finally {
      setGranting(false)
    }
    return enumerateDevices()
  }

  /**
   * 选择输入设备时同时记录 cpal 设备名（`nativeInput`）。
   * 浏览器只给 deviceId，原生采集只认名字；两者必须在选择瞬间绑定，
   * 否则没授权、拿不到 label 时原生采集会悄悄回落到系统默认设备。
   */
  const pickInputDevice = async (value: string) => {
    if (!value) {
      onChange({ inputDevice: '', nativeInput: '' })
      return
    }
    let label = devices.find((device) => device.deviceId === value)?.label ?? ''
    if (!label) {
      const list = await refreshDevices()
      label = list.find((device) => device.deviceId === value)?.label ?? ''
    }
    if (!label && settings.nativeMic) {
      onToast('未读到设备名称，原生采集会继续使用系统默认麦克风')
    }
    onChange({ inputDevice: value, nativeInput: label })
  }

  const probeDevices = async () => {
    if (demoMode) {
      onToast('演示模式无法访问真实麦克风')
      return
    }
    setProbing(true)
    try {
      await waitForNativeRelease()
      const raw = await protocol.probeMicDevices()
      const parsed = JSON.parse(raw) as {
        devices: Array<{ device: string; hasSignal: boolean; rmsDbfs: number; peakDbfs: number }>
      }
      setProbeRows(parsed.devices)
      const dead = parsed.devices.filter((row) => !row.hasSignal)
      if (dead.length === parsed.devices.length) {
        onToast('所有输入设备都没有信号：检查系统麦克风权限或耳机物理静音开关')
      } else if (dead.some((row) => row.device === inputOptions.find((o) => o.value === settings.inputDevice)?.label)) {
        onToast('当前选择的麦克风没有信号，建议改选下面有信号的设备')
      }
    } catch {
      onToast('检测失败，无法打开输入设备')
    } finally {
      setProbing(false)
    }
  }

  useEffect(() => {
    if (section !== 'audio' || demoMode || !settings.nativeMic) {
      setNativeStats(null)
      return
    }
    let disposed = false
    const pull = () => {
      protocol
        .nativeAudioStats()
        .then((stats) => {
          if (!disposed) setNativeStats(stats)
        })
        .catch(() => {})
    }
    pull()
    const timer = window.setInterval(pull, 1000)
    return () => {
      disposed = true
      window.clearInterval(timer)
    }
  }, [section, settings.nativeMic, demoMode])

  // 本地测试 / 校准 / 设备检测会自己打开麦克风：先让原生采集释放设备，
  // 否则两个采集流会抢同一支麦克风（原生侧报设备占用，界面又自动回退）。
  // 这个 effect 必须排在采集 effect 之前，保证同一次提交里先请求释放。
  useEffect(() => {
    onAudioTestHold?.(testing || calibrating || probing || granting)
  }, [testing, calibrating, probing, granting, onAudioTestHold])
  useEffect(() => () => onAudioTestHold?.(false), [onAudioTestHold])

  /** 原生采集关闭需要一次 IPC 往返 + 120ms 防抖，开麦前等一下。 */
  const waitForNativeRelease = async () => {
    if (!settings.nativeMic) return
    await new Promise((resolve) => window.setTimeout(resolve, 260))
  }

  useEffect(() => {
    if (!testing) {
      setTestDb(null)
      return
    }
    let disposed = false
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    let node: AudioWorkletNode | null = null

    const run = async () => {
      try {
        await waitForNativeRelease()
        const constraints: MediaStreamConstraints = {
          audio: settings.inputDevice
            ? {
                deviceId: { exact: settings.inputDevice },
                echoCancellation: settings.echoCancel,
                noiseSuppression: settings.noiseSuppressor === 'chromium',
                autoGainControl: settings.autoGain,
              }
            : {
                echoCancellation: settings.echoCancel,
                noiseSuppression: settings.noiseSuppressor === 'chromium',
                autoGainControl: settings.autoGain,
              },
          video: false,
        }
        stream = await navigator.mediaDevices.getUserMedia(constraints)
        if (disposed) {
          stream.getTracks().forEach((track) => track.stop())
          return
        }
        try {
          context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
        } catch {
          context = new AudioContext({ latencyHint: 'interactive' })
        }
        // getUserMedia/await 之后用户手势已过期，自动播放策略会把新建的
        // AudioContext 停在 suspended —— 不自听就没声音。
        if (context.state === 'suspended') {
          await context.resume().catch(() => {})
        }
        // 试听与诊断都走和真实发送完全相同的 AudioWorklet 链路，
        // 否则「关掉降噪后的底噪」与真正发出去的信号不是一回事。
        const moduleUrl = URL.createObjectURL(
          new Blob([CAPTURE_WORKLET_SOURCE], { type: 'application/javascript' }),
        )
        await context.audioWorklet.addModule(moduleUrl)
        URL.revokeObjectURL(moduleUrl)
        const sink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
        if (sink.setSinkId) await sink.setSinkId(settings.outputDevice || '').catch(() => {})
        const source = context.createMediaStreamSource(stream)
        const gain = context.createGain()
        gain.gain.value = Math.max(0, Math.min(2, settings.inputVolume / 100))
        node = new AudioWorkletNode(context, CAPTURE_PROCESSOR, {
          processorOptions: {
            frameSize: Math.round(((context.sampleRate || 48000) * settings.frameSize) / 1000),
            channels: 1,
            highPass: settings.highPass,
            gateEnabled: settings.noiseSuppressor === 'gate',
            gateThresholdDb: effectiveVadThreshold(settings),
            gateDepthDb: settings.gateDepth,
          },
        })
        source.connect(gain)
        gain.connect(node)
        // 自听：听到的是「处理之后、即将发送」的信号。
        // 无论开关如何都要连到 destination，否则 worklet 不被拉取、电平条不动；
        // 关掉时用增益 0 静音（createGain() 默认是 1，会把麦克风一直放出来）。
        const listen = context.createGain()
        listen.gain.value = monitor ? 1 : 0
        node.connect(listen).connect(context.destination)
        node.port.onmessage = (event: MessageEvent) => {
          if (disposed) return
          const payload = event.data as {
            frame: ArrayBuffer
            frames: number
            levelDb: number
          }
          setTestDb(
            Number.isFinite(payload.levelDb)
              ? Math.max(-90, Math.min(0, payload.levelDb))
              : -90,
          )
        }
      } catch {
        onToast('无法打开麦克风，请检查设备与系统权限')
        setTesting(false)
      }
    }
    void run()
    return () => {
      disposed = true
      node?.port.postMessage({ type: 'params' })
      node?.disconnect()
      stream?.getTracks().forEach((track) => track.stop())
      if (context) void context.close()
    }
  }, [
    testing,
    monitor,
    settings.inputDevice,
    settings.outputDevice,
    settings.inputVolume,
    settings.echoCancel,
    settings.noiseSuppressor,
    settings.highPass,
    settings.gateDepth,
    settings.frameSize,
    settings.inputSensitivity,
    settings.noiseFloorDb,
    settings.vadThreshold,
    settings.autoGain,
    onToast,
  ])

  // 已连接时优先显示真实链路的电平与阈值（AudioWorklet 上报），
  // 未连接或原生采集时退回本地测试 / 原生统计。
  useEffect(() => {
    if (section !== 'audio' || !connected || demoMode || settings.nativeMic) {
      setLiveDb(null)
      setLiveThreshold(null)
      setLiveFloor(null)
      return
    }
    const handler = (event: Event) => {
      const detail = (
        event as CustomEvent<{ db?: number; thresholdDb?: number; floorDb?: number }>
      ).detail
      if (!detail || typeof detail.db !== 'number') return
      setLiveDb(detail.db)
      if (typeof detail.thresholdDb === 'number') setLiveThreshold(detail.thresholdDb)
      if (typeof detail.floorDb === 'number') setLiveFloor(detail.floorDb)
    }
    window.addEventListener('rayspeak:level', handler)
    return () => window.removeEventListener('rayspeak:level', handler)
  }, [section, connected, demoMode, settings.nativeMic])

  useEffect(() => {
    if (section !== 'audio' || demoMode || !settings.nativeMic) return
    let off: (() => void) | undefined
    let disposed = false
    void listenEvent<{ talking: boolean; levelDb: number }>('ts://mic-activity', (event) => {
      setLiveDb(Math.max(-90, Math.min(0, event.levelDb)))
    }).then((remove) => {
      if (disposed) remove()
      else off = remove
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [section, demoMode, settings.nativeMic])

  const calibrateInput = async () => {
    if (calibrating) return
    setCalibrating(true)
    await waitForNativeRelease()
    let stream: MediaStream | null = null
    let context: AudioContext | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: settings.inputDevice ? { deviceId: { exact: settings.inputDevice } } : true,
        video: false,
      })
      context = new AudioContext()
      const analyser = context.createAnalyser()
      analyser.fftSize = 1024
      context.createMediaStreamSource(stream).connect(analyser)
      const data = new Uint8Array(analyser.fftSize)
      const samples: number[] = []
      const started = performance.now()
      await new Promise<void>((resolve) => {
        const tick = () => {
          analyser.getByteTimeDomainData(data)
          let energy = 0
          for (let index = 0; index < data.length; index += 1) {
            const value = (data[index] - 128) / 128
            energy += value * value
          }
          const db = 20 * Math.log10(Math.max(Math.sqrt(energy / data.length), 1e-6))
          if (db > -89) samples.push(db)
          if (performance.now() - started < 1800) requestAnimationFrame(tick)
          else resolve()
        }
        tick()
      })
      // 取 20% 分位而不是最小值：偶尔一帧绝对静音不会把底噪压死。
      samples.sort((a, b) => a - b)
      const picked = samples.length ? samples[Math.floor(samples.length * 0.2)] : -60
      const floorDb = Math.max(-90, Math.min(-30, Math.round(picked)))
      onChange({ noiseFloorDb: floorDb, inputSensitivity: 'auto' })
      onToast(`环境底噪约 ${floorDb} dBFS，发送阈值已设为 ${autoVadThreshold(floorDb)} dBFS`)
    } catch {
      onToast('校准失败：请授予麦克风权限后重试')
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      if (context) void context.close()
      setCalibrating(false)
    }
  }

  const playTestTone = async () => {
    let context: AudioContext | null = null
    try {
      context = new AudioContext()
      const sink = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
      if (sink.setSinkId) await sink.setSinkId(settings.outputDevice || '').catch(() => {})
      const ctx = context
      const master = ctx.createGain()
      master.gain.value = Math.max(0, Math.min(1, settings.outputVolume / 100)) * 0.3
      master.connect(ctx.destination)
      const now = ctx.currentTime
      for (const [index, freq] of [523.25, 659.25, 783.99].entries()) {
        const start = now + index * 0.22
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.value = freq
        const env = ctx.createGain()
        env.gain.setValueAtTime(0, start)
        env.gain.linearRampToValueAtTime(1, start + 0.02)
        env.gain.exponentialRampToValueAtTime(0.001, start + 0.2)
        osc.connect(env)
        env.connect(master)
        osc.start(start)
        osc.stop(start + 0.22)
      }
      window.setTimeout(() => void ctx.close(), 1400)
      onToast('已在所选扬声器播放测试音')
    } catch {
      onToast('无法播放测试音，请检查输出设备')
    }
  }

  const deviceOptions = (kind: MediaDeviceKind) => {
    const seen = new Set<string>()
    const inputs = devices
      .filter((device) => {
        if (device.kind !== kind) return false
        // 未授权时 deviceId 可能全是空串，去重避免出现多个不可区分的选项。
        if (seen.has(device.deviceId)) return false
        seen.add(device.deviceId)
        return true
      })
      .map((device, index) => ({
        value: device.deviceId,
        label: device.label || `${kind === 'audioinput' ? '麦克风' : '扬声器'} ${index + 1}`,
      }))
    return [{ value: '', label: '系统默认' }, ...inputs]
  }

  const inputOptions = deviceOptions('audioinput')
  if (settings.inputDevice && !inputOptions.some((item) => item.value === settings.inputDevice)) {
    inputOptions.push({ value: settings.inputDevice, label: '已保存的麦克风' })
  }
  const outputOptions = deviceOptions('audiooutput')
  if (
    settings.outputDevice &&
    !outputOptions.some((item) => item.value === settings.outputDevice)
  ) {
    outputOptions.push({ value: settings.outputDevice, label: '已保存的扬声器' })
  }

  const testNotification = async () => {
    if (settings.notifySound) playNotifyTone(settings.notifyTone)
    const granted = await showDesktopNotification(
      'RaySpeak',
      '这是一条测试通知，桌面提醒工作正常。',
    )
    if (!granted) {
      onToast('系统通知权限未授予，已播放本地提示音')
      return
    }
    onToast('测试通知已发送')
  }

  const copyDiagnostics = async () => {
    const payload = {
      app: `RaySpeak ${appInfo?.version ?? '0.2.0'}`,
      dataDir: appInfo?.dataDir ?? 'unknown',
      connected,
      latency,
      clients: clients.length,
      permissions: permissions.length,
      microphone: settings.inputDevice || 'system-default',
      speaker: settings.outputDevice || 'system-default',
      platform: navigator.userAgent,
      time: new Date().toISOString(),
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
      onToast('诊断信息已复制')
    } catch {
      onToast('剪贴板不可用')
    }
  }

  const active = navItems.find((item) => item.id === section) ?? navItems[0]
  const presetActive = (patch: Partial<Settings>) =>
    Object.entries(patch).every(
      ([key, value]) =>
        JSON.stringify(settings[key as keyof Settings]) === JSON.stringify(value),
    )
  const resetAppearance = () => {
    onChange({
      theme: defaultSettings.theme,
      accent: defaultSettings.accent,
      density: defaultSettings.density,
      radius: defaultSettings.radius,
      blur: defaultSettings.blur,
      panelOpacity: defaultSettings.panelOpacity,
      contrast: defaultSettings.contrast,
      chatFontSize: defaultSettings.chatFontSize,
      sidebarWidth: defaultSettings.sidebarWidth,
      background: defaultSettings.background,
      backgroundImage: defaultSettings.backgroundImage,
      backgroundDim: defaultSettings.backgroundDim,
      layout: defaultSettings.layout,
      cardStyle: defaultSettings.cardStyle,
      animations: defaultSettings.animations,
      chatBubbles: defaultSettings.chatBubbles,
      showTimestamps: defaultSettings.showTimestamps,
      showMemberState: defaultSettings.showMemberState,
      showChannelIcons: defaultSettings.showChannelIcons,
      showGroupChips: defaultSettings.showGroupChips,
      showChannelCounts: defaultSettings.showChannelCounts,
    })
    onToast('已恢复默认外观')
  }
  const dark = isDark(settings.theme)
  const themeLabel = { light: '浅色', dark: '深色', system: '跟随系统' }[settings.theme]
  const layoutLabel = settings.layout === 'cards' ? '成员卡片' : '网格式'
  const densityLabel = { compact: '紧凑', cozy: '舒适', spacious: '宽松' }[settings.density]
  const accentName =
    accentPresets.find((preset) => preset.value.toLowerCase() === settings.accent.toLowerCase())
      ?.name ?? '自定义'
  const customBackground = safeImage(settings.backgroundImage)
  const blocked = settings.blocked
    .map((id) => clients.find((client) => client.id === id))
    .filter((client): client is Client => Boolean(client))

  const copyIdentity = async () => {
    let identity = ''
    try {
      identity = await protocol.getIdentity()
    } catch {
      identity = 'rayspeak:identity-unavailable'
    }
    try {
      await navigator.clipboard.writeText(identity)
    } catch {
      /* clipboard unavailable */
    }
    onToast(demoMode ? '演示模式：未连接服务器，身份不可用' : '身份字符串已复制')
  }

  const exportIdentity = async () => {
    const destination = await pickSavePath('rayspeak-identity.dat')
    if (!destination) return
    try {
      await protocol.exportIdentity(destination)
      onToast('身份文件已导出')
    } catch (error) {
      onToast(demoMode ? '身份导出仅在桌面应用连接后可用' : errorText(error))
    }
  }

  const syncIdentity = () => {
    if (demoMode) {
      onToast('演示模式：昵称未同步')
      return
    }
    protocol
      .updateSelf(settings.nickname.trim(), settings.description || null)
      .then(() => onToast('昵称与描述已同步到服务器'))
      .catch((error) => onToast(errorText(error)))
  }

  const selfClient = clients.find((client) => client.self)
  const selfGroups = selfClient?.serverGroups.filter((id) => groupMap.has(id)) ?? []
  const identityShort = selfClient?.uid
    ? `${selfClient.uid.slice(0, 18)}…`
    : '连接后生成'

  const permissionRows = permissionChecks.map(([label, names]) => {
    const granted = demoMode
      ? true
      : names.some((name) => permissions.includes(name))
    return [label, granted ? 'granted' : 'denied'] as const
  })

  // 电平条数据源：测试中优先本地测试（此时原生采集被临时暂停，事件会停更），
  // 否则已连接优先真实链路，未连接退回本地测试。
  const meterDb = testing ? testDb : liveDb ?? testDb
  const meterThreshold = liveThreshold ?? effectiveVadThreshold(settings)
  const meterFloor =
    settings.inputSensitivity === 'auto' ? (liveFloor ?? settings.noiseFloorDb) : null
  const presetId = activeProcessPreset(settings)
  const activeSuppressor =
    noiseSuppressors.find((item) => item.id === settings.noiseSuppressor) ?? noiseSuppressors[2]
  const effectiveSuppressor = effectiveNoiseSuppressor(settings)
  const effectiveLabel =
    noiseSuppressors.find((item) => item.id === effectiveSuppressor)?.name ?? '关闭'

  const activeProfile =
    settings.audioProfiles.find((profile) => profile.id === settings.activeProfileId) ??
    settings.audioProfiles[0]

  const switchProfile = (id: string) => {
    const profile = settings.audioProfiles.find((item) => item.id === id)
    if (!profile) return
    setRenaming(false)
    onChange({ ...audioProfilePatch(profile), activeProfileId: profile.id })
  }

  const duplicateProfile = () => {
    if (!activeProfile) return
    const copy: AudioProfile = {
      ...activeProfile,
      id: newProfileId(),
      name: `${activeProfile.name} 副本`,
    }
    onChange({ audioProfiles: [...settings.audioProfiles, copy], activeProfileId: copy.id })
    onToast(`已保存为「${copy.name}」，可原地改名`)
  }

  const deleteProfile = () => {
    if (!activeProfile || settings.audioProfiles.length <= 1) return
    const rest = settings.audioProfiles.filter((item) => item.id !== activeProfile.id)
    setRenaming(false)
    onChange({
      audioProfiles: rest,
      activeProfileId: rest[0].id,
      ...audioProfilePatch(rest[0]),
    })
    onToast(`已删除「${activeProfile.name}」，切换到「${rest[0].name}」`)
  }

  const qualityPreset = settings.musicMode
    ? 'music'
    : settings.bitrate === 64 && settings.frameSize === 20
      ? 'voice'
      : 'custom'

  return (
    <div className="settings-screen">
      <aside className="settings-nav">
        <div className="settings-nav-head">
          <span className="settings-logo">
            <img src="/logo.png" alt="" draggable={false} />
          </span>
          <div>
            <strong>设置</strong>
            <span>所有修改即时生效</span>
          </div>
          <button className="icon-btn" title="返回语音界面" onClick={onClose}>
            <X size={16} strokeWidth={2.2} />
          </button>
        </div>

        <nav className="settings-nav-list">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                key={item.id}
                className={`settings-nav-item ${item.id === section ? 'active' : ''}`}
                onClick={() => onSection(item.id)}
              >
                <Icon size={17} strokeWidth={1.9} />
                <span>
                  <strong>{item.label}</strong>
                  <em>{item.desc}</em>
                </span>
              </button>
            )
          })}
        </nav>

        <footer className="settings-nav-foot">
          <span className="version-pill">
            v{appInfo?.version ?? '0.2.0'} · 协议接入
          </span>
          <span>协议内核 tsclient-rs</span>
        </footer>
      </aside>

      <div className="settings-main">
        <header className="settings-main-head">
          <div>
            <h1>{active.label}</h1>
            <p>{active.desc}</p>
          </div>
          <div className="settings-head-actions">
            <span className="autosave">
              <Check size={12} strokeWidth={2.6} />
              自动保存到本机
            </span>
            <button className="ghost-btn" onClick={onClose}>
              返回语音
            </button>
          </div>
        </header>

        <div className="settings-scroll">
          {section === 'account' && (
            <>
              <SetCard
                title="个人资料"
                desc="展示在频道成员列表与用户资料卡中；可在资料卡或右键菜单设置头像，未设置时显示昵称首字"
              >
                <div className="account-hero">
                  <span className="account-avatar">
                    {selfClient?.avatarUrl ? (
                      <img src={selfClient.avatarUrl} alt="" draggable={false} />
                    ) : (
                      settings.nickname.slice(0, 1) || 'R'
                    )}
                  </span>
                  <div className="account-copy">
                    <strong>{settings.nickname || '未命名'}</strong>
                    <span>{settings.description || '还没有填写个人描述'}</span>
                  </div>
                </div>
                <SettingRow title="昵称" desc="最多 30 个字符，支持 TeamSpeak 格式文本">
                  <TextInput
                    value={settings.nickname}
                    maxLength={30}
                    placeholder="输入昵称"
                    onChange={(value) => onChange({ nickname: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="个人描述"
                  desc="显示在资料卡片的简介区域，连接后会自动同步到服务器，无需手动保存"
                  vertical
                >
                  <textarea
                    className="text-area"
                    value={settings.description}
                    maxLength={200}
                    placeholder="介绍一下自己"
                    onChange={(event) => onChange({ description: event.target.value })}
                  />
                </SettingRow>
                <p className="set-note">
                  昵称与个人描述会在停止输入约 1 秒后自动同步到服务器，其他成员通过资料卡即可看到；
                  未连接时修改只保存在本机。
                </p>
              </SetCard>

              <SetCard title="身份与安全" desc="TeamSpeak 使用身份密钥对识别用户，等级越高越难被冒充">
                <div className="identity-box">
                  <div>
                    <span>服务器</span>
                    <code>已固定配置</code>
                  </div>
                  <div>
                    <span>身份标识</span>
                    <code>{identityShort}</code>
                  </div>
                  <span className="identity-badge">
                    <LockKeyhole size={12} strokeWidth={2.2} />
                    已加密
                  </span>
                </div>
                <SettingRow
                  title="身份安全级别"
                  desc="当前身份由应用在首次启动时生成并保存在本机"
                >
                  <span className="status-chip online">10 级</span>
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={copyIdentity}>
                    <Copy size={13} strokeWidth={2} />
                    复制身份
                  </button>
                  <button className="small-btn ghost" onClick={exportIdentity}>
                    导出身份文件
                  </button>
                  <button className="small-btn ghost" onClick={syncIdentity}>
                    同步到服务器
                  </button>
                </div>
              </SetCard>

              <SetCard title="连接状态" desc="数据来自当前服务器会话">
                <SettingRow title="语音连接" desc="Opus 48kHz · UDP · WebView2 麦克风采集">
                  <span className={`status-chip ${connected ? 'online' : 'unsupported'}`}>
                    {connected ? `已连接 · ${latency}ms` : '未连接'}
                  </span>
                </SettingRow>
                <SettingRow title="服务器组" desc="你在本服务器中拥有的服务器组">
                  <span className="inline-chips">
                    {selfGroups.length === 0 && <span className="set-note">暂无可见服务器组</span>}
                    {selfGroups.map((id) => (
                      <span className="mini-group" key={id}>
                        {groupMap.get(id)?.name}
                      </span>
                    ))}
                  </span>
                </SettingRow>
              </SetCard>

              <SetCard
                title="服务器权限"
                desc="对应 tsclient-rs 的 permission_value / permissionlist，管理按钮据此启用或禁用"
              >
                <div className="perm-list">
                  {permissionRows.map(([label, state]) => (
                    <div className="perm-row" key={label}>
                      <span>{label}</span>
                      <span
                        className={`status-chip ${
                          state === 'granted' ? 'online' : 'unsupported'
                        }`}
                      >
                        {state === 'granted' ? '已授予' : '未授予'}
                      </span>
                    </div>
                  ))}
                </div>
                <p className="set-note">
                  最终操作仍由服务器校验；连接后会用 permissionlist 返回的真实权限 id 刷新此列表。
                </p>
              </SetCard>
            </>
          )}

          {section === 'audio' && (
            <>
              <SetCard
                title="配置档"
                desc="保存多套音频配置（会议 / 游戏 / 音乐 / 外放），换场景一键切换；修改会即时写回当前配置"
              >
                <SettingRow
                  title="当前配置"
                  desc="切换会立即应用设备、增益、处理与编码参数"
                  vertical
                >
                  <div className="profile-row">
                    <Select
                      value={settings.activeProfileId}
                      options={settings.audioProfiles.map((profile) => ({
                        value: profile.id,
                        label: profile.name,
                      }))}
                      onChange={switchProfile}
                    />
                    <button className="small-btn" onClick={duplicateProfile}>
                      <Plus size={13} strokeWidth={2} />
                      另存为
                    </button>
                    <button
                      className="small-btn"
                      onClick={() => {
                        setRenaming(true)
                        setProfileName(activeProfile?.name ?? '')
                      }}
                    >
                      重命名
                    </button>
                    <button
                      className="small-btn"
                      onClick={deleteProfile}
                      disabled={settings.audioProfiles.length <= 1}
                      title={
                        settings.audioProfiles.length <= 1 ? '至少保留一套配置' : '删除当前配置'
                      }
                    >
                      <Trash2 size={13} strokeWidth={2} />
                      删除
                    </button>
                  </div>
                </SettingRow>
                {renaming && (
                  <div className="inline-actions">
                    <TextInput
                      value={profileName}
                      onChange={setProfileName}
                      placeholder="配置名称，例如「游戏 · 耳机」"
                    />
                    <button
                      className="small-btn"
                      onClick={() => {
                        if (activeProfile && profileName.trim()) {
                          onChange({
                            audioProfiles: settings.audioProfiles.map((profile) =>
                              profile.id === activeProfile.id
                                ? { ...profile, name: profileName.trim() }
                                : profile,
                            ),
                          })
                        }
                        setRenaming(false)
                      }}
                    >
                      <Check size={13} strokeWidth={2} />
                      确定
                    </button>
                  </div>
                )}
              </SetCard>

              <SetCard title="麦克风" desc="设备、原生采集与输入检测">
                <SettingRow
                  title="设备"
                  desc="切换后立即重连采集；原生采集使用同一支麦克风"
                >
                  <Select
                    value={settings.inputDevice}
                    options={inputOptions}
                    onChange={(value) => void pickInputDevice(value)}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void refreshDevices()}>
                    <RotateCcw size={13} strokeWidth={2} />
                    刷新设备
                  </button>
                  <button
                    className="small-btn"
                    onClick={() => void probeDevices()}
                    disabled={probing}
                  >
                    <Mic size={13} strokeWidth={2} />
                    {probing ? '检测中…' : '检测输入'}
                  </button>
                  <span className="set-note">{deviceNote}</span>
                </div>
                {probeRows.length > 0 && (
                  <div className="probe-list">
                    {probeRows.map((row) => {
                      const match = inputOptions.find(
                        (option) =>
                          option.label === row.device || option.label.includes(row.device),
                      )
                      return (
                        <div className="probe-row" key={row.device}>
                          <span className={row.hasSignal ? 'probe-ok' : 'probe-dead'} />
                          <span className="probe-name">{row.device}</span>
                          <span className="probe-level">
                            {row.hasSignal ? `${row.rmsDbfs.toFixed(0)} dBFS` : '无信号'}
                          </span>
                          {!row.hasSignal && match && (
                            <span className="probe-hint">静音或不可用</span>
                          )}
                          {row.hasSignal && match && match.value !== settings.inputDevice && (
                            <button
                              className="small-btn"
                              onClick={() =>
                                onChange({ inputDevice: match.value, nativeInput: row.device })
                              }
                            >
                              改用此设备
                            </button>
                          )}
                        </div>
                      )
                    })}
                    <p className="set-note">
                      每个设备打开 0.8 秒；无信号通常是系统未授权、耳机物理静音开关，
                      或被其他程序独占。
                    </p>
                  </div>
                )}
                {settings.nativeMic && (
                  <p className="set-note">
                    原生采集按设备名打开麦克风；本地测试、自听与「检测输入」会临时暂停原生采集，
                    结束后自动恢复，避免两个采集流抢同一支设备。
                  </p>
                )}
                <SettingRow
                  title="原生采集（实验性）"
                  desc="Rust 直接采集并编码，支持 SpeexDSP / RNNoise 降噪"
                >
                  <Switch
                    checked={settings.nativeMic}
                    onChange={(value) => onChange({ nativeMic: value })}
                  />
                </SettingRow>
                <p className="set-note">
                  原生采集无法提供回声消除（缺少播放参考信号）；外放场景建议关闭它，
                  使用 WebView 链路 + 智能降噪。开启后若设备打不开会自动回退。
                </p>
              </SetCard>

              <SetCard
                title="音量与监听"
                desc="本地测试与自听都走真实发送链路（高通 → 降噪 → 门控 → 限幅）"
              >
                <SettingRow title="麦克风增益" desc="过高会引入底噪，建议先校准底噪再微调">
                  <Slider
                    value={settings.inputVolume}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => onChange({ inputVolume: value })}
                  />
                </SettingRow>
                <LevelMeter
                  db={meterDb}
                  threshold={meterThreshold}
                  floor={meterFloor}
                  auto={settings.inputSensitivity === 'auto'}
                />
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => setTesting((value) => !value)}>
                    <Play size={13} strokeWidth={2} />
                    {testing ? '停止本地测试' : '本地测试'}
                  </button>
                  <button
                    className="small-btn"
                    onClick={() => void calibrateInput()}
                    disabled={calibrating}
                  >
                    <Mic size={13} strokeWidth={2} />
                    {calibrating ? '校准中…' : '校准底噪'}
                  </button>
                  <span className="set-note">
                    {connected ? '已连接：电平来自实时链路' : '未连接：电平来自本地测试'}
                  </span>
                </div>
                <p className="set-note">
                  「校准底噪」会在安静环境采集 1.8 秒，取 20% 分位电平作为环境底噪
                  （当前 {settings.noiseFloorDb} dBFS），自动阈值 = 底噪 + 9 dB
                  （{autoVadThreshold(settings.noiseFloorDb)} dBFS）。
                </p>
                {testing && liveDb === null && testDb !== null && testDb < -60 && (
                  <p className="set-note warn">
                    当前麦克风几乎没有信号（{testDb.toFixed(0)} dBFS）。请点上方「检测输入」
                    确认设备，或检查系统麦克风权限与耳机静音开关。
                  </p>
                )}
                <SettingRow
                  title="自听（本地监听）"
                  desc="回放「处理后、即将发送」的声音，建议戴耳机以免啸叫"
                >
                  <Switch
                    checked={monitor}
                    onChange={(value) => {
                      setMonitor(value)
                      if (value) setTesting(true)
                    }}
                  />
                </SettingRow>
                <p className="set-note">
                  原生采集开启时，本地测试与自听会临时暂停原生采集（结束后自动恢复）；
                  默认输出若是 FxSound 等虚拟增强设备，其自身音效会干扰判断，
                  试听时请直接选耳机/扬声器的物理设备。
                </p>
              </SetCard>

              <SetCard title="扬声器" desc="本机播放音量与设备自检">
                <SettingRow title="扬声器音量" desc="仅影响本机播放，不改变他人音量">
                  <Slider
                    value={settings.outputVolume}
                    min={0}
                    max={100}
                    suffix="%"
                    onChange={(value) => onChange({ outputVolume: value })}
                  />
                </SettingRow>
                <SettingRow title="输出设备" desc="留空跟随系统默认">
                  <Select
                    value={settings.outputDevice}
                    options={outputOptions}
                    onChange={(value) => onChange({ outputDevice: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void playTestTone()}>
                    <Volume2 size={13} strokeWidth={2} />
                    测试扬声器
                  </button>
                  <span className="set-note">三段测试音走所选输出设备，用于确认声道与音量</span>
                </div>
              </SetCard>

              <SetCard title="输入方式" desc="VAD 自动检测人声，PTT 按下按键才发送">
                <SettingRow title="模式">
                  <Segmented
                    value={settings.inputMode}
                    options={[
                      { value: 'vad', label: '自动检测' },
                      { value: 'ptt', label: '按键说话' },
                      { value: 'open', label: '常开' },
                    ]}
                    onChange={(value) => onChange({ inputMode: value })}
                  />
                </SettingRow>
                {settings.inputMode === 'vad' && (
                  <>
                    <SettingRow
                      title="灵敏度"
                      desc="自动模式按环境底噪推导阈值，说话时阈值不会跟着人声爬升"
                    >
                      <Segmented
                        value={settings.inputSensitivity}
                        options={[
                          { value: 'auto', label: '自动' },
                          { value: 'manual', label: '手动' },
                        ]}
                        onChange={(value) => onChange({ inputSensitivity: value })}
                      />
                    </SettingRow>
                    {settings.inputSensitivity === 'manual' && (
                      <SettingRow title="触发阈值" desc="低于阈值的环境音将被忽略，单位 dBFS">
                        <Slider
                          value={settings.vadThreshold}
                          min={-60}
                          max={-10}
                          step={1}
                          suffix=" dB"
                          onChange={(value) => onChange({ vadThreshold: value })}
                        />
                      </SettingRow>
                    )}
                    <SettingRow title="保持时长" desc="说完后继续发送的时间，太短会切掉尾音">
                      <Slider
                        value={settings.voiceHoldMs}
                        min={100}
                        max={1000}
                        step={50}
                        suffix=" ms"
                        onChange={(value) => onChange({ voiceHoldMs: value })}
                      />
                    </SettingRow>
                  </>
                )}
                {settings.inputMode === 'ptt' && (
                  <SettingRow title="按键" desc="按住该键时发送语音，松开停止">
                    <HotkeyInput
                      value={settings.hotkeys.ptt}
                      onChange={(value) =>
                        onChange({ hotkeys: { ...settings.hotkeys, ptt: value } })
                      }
                    />
                  </SettingRow>
                )}
                {settings.inputMode === 'open' && (
                  <p className="set-note">
                    常开模式下只要未静音就会持续发送，适合音乐或直播；
                    建议同时绑定静音热键，避免环境音全程外泄。
                  </p>
                )}
              </SetCard>

              <SetCard
                title="语音处理"
                desc="预设对应 TeamSpeak 3 的 DSP 预设；改动任一项即视为自定义"
              >
                <div className="audio-chips">
                  {voiceProcessPresets.map((preset) => (
                    <button
                      key={preset.id}
                      className={`audio-chip ${presetId === preset.id ? 'active' : ''}`}
                      title={preset.desc}
                      onClick={() => onChange(preset.patch)}
                    >
                      {preset.name}
                    </button>
                  ))}
                  <span className={`audio-chip ${presetId === 'custom' ? 'active' : ''}`}>
                    自定义
                  </span>
                </div>
                <SettingRow title="降噪方式" desc={activeSuppressor.desc}>
                  <Select
                    value={settings.noiseSuppressor}
                    options={noiseSuppressors.map((item) => ({
                      value: item.id,
                      label: `${item.name} · ${item.short}`,
                    }))}
                    onChange={(value) =>
                      onChange({ noiseSuppressor: value as Settings['noiseSuppressor'] })
                    }
                  />
                </SettingRow>
                <p className="set-note">
                  当前实际生效：{effectiveLabel}
                  {activeSuppressor.path === 'native' && !settings.nativeMic
                    ? '（该方式需要原生采集，已降级为噪声门）'
                    : ''}
                </p>
                {effectiveSuppressor === 'gate' && (
                  <SettingRow
                    title="门的深度"
                    desc="低于阈值时压暗多少 dB，越大越安静但更易听出断点"
                  >
                    <Slider
                      value={settings.gateDepth}
                      min={6}
                      max={36}
                      step={2}
                      suffix=" dB"
                      onChange={(value) => onChange({ gateDepth: value })}
                    />
                  </SettingRow>
                )}
                <SettingRow
                  title="高通滤波"
                  desc="80 Hz 以下整体切除，去掉桌面震动、空调与手持噪声"
                >
                  <Switch
                    checked={settings.highPass}
                    onChange={(value) => onChange({ highPass: value })}
                  />
                </SettingRow>
                <SettingRow title="自动增益" desc="自动拉平音量差异，开播前建议关掉做手动校准">
                  <Switch
                    checked={settings.autoGain}
                    onChange={(value) => onChange({ autoGain: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="回声消除"
                  desc={
                    settings.nativeMic
                      ? '原生采集无播放参考，关闭后由系统/耳机自带的回声抑制负责'
                      : '扬声器外放时抑制回流（WebView 采集链路生效）'
                  }
                >
                  <Switch
                    checked={settings.echoCancel}
                    onChange={(value) => onChange({ echoCancel: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="编码与网络" desc="上行质量与抗抖动；一般保持默认即可">
                <SettingRow title="质量" desc="语音最省带宽，音乐模式启用立体声与更高码率">
                  <Segmented
                    value={qualityPreset}
                    options={[
                      { value: 'voice', label: '语音' },
                      { value: 'music', label: '音乐' },
                      { value: 'custom', label: '自定义' },
                    ]}
                    onChange={(value) => {
                      if (value === 'voice') {
                        onChange({ musicMode: false, bitrate: 64, frameSize: 20 })
                      } else if (value === 'music') {
                        onChange({ musicMode: true, bitrate: 96, frameSize: 20 })
                      }
                    }}
                  />
                </SettingRow>
                <SettingRow title="语音码率" desc="上行带宽占用，频道上限以服务器为准">
                  <Slider
                    value={settings.bitrate}
                    min={16}
                    max={128}
                    step={8}
                    suffix=" kbps"
                    onChange={(value) => onChange({ bitrate: value })}
                  />
                </SettingRow>
                <SettingRow title="帧长" desc="更短的帧降低延迟，但增加带宽">
                  <Segmented
                    value={String(settings.frameSize)}
                    options={[
                      { value: '10', label: '10 ms' },
                      { value: '20', label: '20 ms' },
                      { value: '40', label: '40 ms' },
                      { value: '60', label: '60 ms' },
                    ]}
                    onChange={(value) => onChange({ frameSize: Number(value) })}
                  />
                </SettingRow>
                <SettingRow title="抖动缓冲" desc="网络波动大时增大缓冲以减少断音">
                  <Slider
                    value={settings.jitterBuffer}
                    min={20}
                    max={200}
                    step={10}
                    suffix=" ms"
                    onChange={(value) => onChange({ jitterBuffer: value })}
                  />
                </SettingRow>
                <SettingRow title="延迟策略" desc="低延迟优先 / 均衡 / 稳定优先">
                  <Segmented
                    value={settings.latencyMode}
                    options={[
                      { value: 'low', label: '低延迟' },
                      { value: 'balanced', label: '均衡' },
                      { value: 'stable', label: '稳定' },
                    ]}
                    onChange={(value) => onChange({ latencyMode: value })}
                  />
                </SettingRow>
              </SetCard>

              {settings.nativeMic && (
                <SetCard
                  title="采集诊断"
                  desc="仅原生采集开启时上报；用于判断设备与链路是否稳定"
                >
                  <div className="perm-row">
                    <span>采集引擎</span>
                    <span
                      className={`status-chip ${nativeStats?.micActive ? 'online' : 'unsupported'}`}
                    >
                      {nativeStats ? (nativeStats.micActive ? '运行中' : '未启动') : '等待连接'}
                    </span>
                  </div>
                  <div className="perm-row">
                    <span>输入设备</span>
                    <strong>{nativeStats?.micDevice ?? '系统默认'}</strong>
                  </div>
                  <div className="perm-row">
                    <span>设备采样率</span>
                    <strong>{nativeStats?.micRate ? `${nativeStats.micRate} Hz` : '—'}</strong>
                  </div>
                  <div className="perm-row">
                    <span>输入电平 / 发送门</span>
                    <strong>
                      {nativeStats
                        ? `${nativeStats.micLevelDb.toFixed(0)} dBFS · ${nativeStats.micGate ? '开' : '关'}`
                        : '—'}
                    </strong>
                  </div>
                  <div className="perm-row">
                    <span>已发送帧 / 输入溢出</span>
                    <strong>
                      {nativeStats
                        ? `${nativeStats.micFrames} / ${nativeStats.micOverruns}`
                        : '—'}
                    </strong>
                  </div>
                  <p className="set-note">
                    输入溢出持续增长说明采集回调跟不上 10ms 节奏，可换更低的设备采样率或关闭原生采集。
                  </p>
                </SetCard>
              )}
            </>
          )}

          {section === 'appearance' && (
            <>
              <section className={`appearance-hero layout-${settings.layout}`}>
                <div className="mini-app" aria-hidden="true">
                  <div className="ma-bar">
                    <span className="ma-logo">
                      <img src="/logo.png" alt="" draggable={false} />
                    </span>
                    <em>RaySpeak</em>
                    <span className="ma-live" />
                    <span className="ma-win" />
                  </div>
                  <div className="ma-body">
                    <div className="ma-rail">
                      <span className="ma-rail-item active" />
                      <span className="ma-rail-item" />
                      <span className="ma-rail-item" />
                    </div>
                    <div className="ma-side">
                      <span className="ma-server" />
                      <span className="ma-search" />
                      <span className="ma-ch active"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                      <span className="ma-ch indent"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                      <span className="ma-ch"><i /><b /></span>
                    </div>
                    <div className="ma-room">
                      <div className="ma-room-head"><i /><b /><span /></div>
                      <div className="ma-layout">
                        <div className="ma-members">
                          <span className="ma-member speaking"><i /><b /></span>
                          <span className="ma-member"><i /><b /></span>
                          <span className="ma-member"><i /><b /></span>
                        </div>
                        <div className="ma-chat">
                          <span className="ma-msg"><i /><b /><b className="short" /></span>
                          <span className="ma-msg self"><i /><b /></span>
                          <span className="ma-msg"><i /><b /><b className="short" /></span>
                          <span className="ma-composer" />
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="ah-copy">
                  <span className="ah-kicker"><Sparkles size={12} strokeWidth={2.2} /> 实时预览</span>
                  <h2>把客户端调成你的样子</h2>
                  <p>主题、强调色、圆角、密度与背景会即时作用于整个界面，所有修改仅保存在本机。</p>
                  <div className="ah-tags">
                    <span>主题 · {themeLabel}</span>
                    <span>布局 · {layoutLabel}</span>
                    <span>密度 · {densityLabel}</span>
                    <span>圆角 · {settings.radius}px</span>
                    <span>字号 · {settings.chatFontSize}px</span>
                    <span>对比 · {settings.contrast === 'high' ? '高' : '标准'}</span>
                  </div>
                </div>
              </section>

              <SetCard title="快速预设" desc="一键套用常用组合，套用后仍可逐项微调">
                <div className="preset-grid">
                  {appearancePresets.map((preset) => {
                    const active =
                      presetActive(preset.patch)
                    return (
                      <button
                        key={preset.id}
                        className={`preset-card ${active ? 'active' : ''}`}
                        onClick={() => onChange(preset.patch)}
                      >
                        <span className={`preset-thumb ${preset.id}`}>
                          <i className="pt-panel" />
                          <i className="pt-panel" />
                          <i className="pt-panel" />
                        </span>
                        <span className="preset-copy">
                          <strong>{preset.name}</strong>
                          <em>{preset.desc}</em>
                        </span>
                        {active && (
                          <span className="preset-check">
                            <Check size={11} strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    )
                  })}
                </div>
              </SetCard>

              <SetCard title="主题" desc="浅色、深色或跟随系统，强调色贯穿按钮与选中态">
                <div className="theme-options">
                  {([
                    { id: 'light', label: '浅色', hint: '明亮清爽', icon: Sun },
                    { id: 'dark', label: '深色', hint: '夜间护眼', icon: Moon },
                    { id: 'system', label: '跟随系统', hint: '自动切换', icon: Monitor },
                  ] as const).map(({ id, label, hint, icon: Icon }) => (
                    <button
                      key={id}
                      className={`theme-option ${settings.theme === id ? 'active' : ''}`}
                      onClick={() => onChange({ theme: id })}
                    >
                      <span className={`theme-thumb ${id}`}>
                        <i className="tt-rail" />
                        <i className="tt-panel" />
                        <i className="tt-dot" />
                      </span>
                      <span className="theme-meta">
                        <strong><Icon size={12} strokeWidth={2} /> {label}</strong>
                        <em>{hint}</em>
                      </span>
                      {settings.theme === id && (
                        <span className="theme-check"><Check size={11} strokeWidth={3} /></span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="accent-block">
                  <div className="accent-head">
                    <div>
                      <strong>强调色</strong>
                      <span>当前为「{accentName}」，点击色块即时切换</span>
                    </div>
                    <code>{settings.accent.toUpperCase()}</code>
                  </div>
                  <div className="accent-grid">
                    {accentPresets.map((preset) => (
                      <button
                        key={preset.value}
                        className={`accent-swatch ${
                          settings.accent.toLowerCase() === preset.value.toLowerCase() ? 'active' : ''
                        }`}
                        style={{ background: preset.value }}
                        title={preset.name}
                        aria-label={preset.name}
                        onClick={() => onChange({ accent: preset.value })}
                      >
                        {settings.accent.toLowerCase() === preset.value.toLowerCase() && (
                          <Check size={12} strokeWidth={3} />
                        )}
                      </button>
                    ))}
                    <label className="accent-swatch custom" title="自定义颜色">
                      <Plus size={12} strokeWidth={2.6} />
                      <input
                        type="color"
                        value={settings.accent}
                        onChange={(event) => onChange({ accent: event.target.value })}
                      />
                    </label>
                  </div>
                </div>
              </SetCard>

              <SetCard title="布局" desc="房间成员区块的两种排布，可在房间头部随时切换">
                <div className="layout-preview">
                  <button
                    className={`layout-option ${settings.layout === 'cards' ? 'active' : ''}`}
                    onClick={() => onChange({ layout: 'cards' })}
                  >
                    <span className="layout-thumb cards">
                      <i className="lt-rail" />
                      <span className="lt-side">
                        <b /><b className="speaking" /><b />
                      </span>
                      <span className="lt-main">
                        <b className="lt-title" />
                        <b className="lt-line" />
                        <b className="lt-bubble self" />
                        <b className="lt-line short" />
                      </span>
                    </span>
                    <span className="layout-meta">
                      <strong>左侧成员栏</strong>
                      <em>卡片 + 大聊天区</em>
                    </span>
                    {settings.layout === 'cards' && (
                      <span className="layout-check"><Check size={11} strokeWidth={3} /></span>
                    )}
                  </button>
                  <button
                    className={`layout-option ${settings.layout === 'grid' ? 'active' : ''}`}
                    onClick={() => onChange({ layout: 'grid' })}
                  >
                    <span className="layout-thumb grid">
                      <i className="lt-rail" />
                      <span className="lt-main">
                        <span className="lt-cards">
                          <b /><b className="speaking" /><b /><b />
                        </span>
                        <b className="lt-line" />
                        <b className="lt-bubble self" />
                      </span>
                    </span>
                    <span className="layout-meta">
                      <strong>顶部成员墙</strong>
                      <em>网格 + 下方聊天</em>
                    </span>
                    {settings.layout === 'grid' && (
                      <span className="layout-check"><Check size={11} strokeWidth={3} /></span>
                    )}
                  </button>
                </div>
                <div className="card-style-block">
                  <div className="card-style-head">
                    <strong>卡片风格</strong>
                    <span>影响成员卡片与面板的质感</span>
                  </div>
                  <div className="card-style-grid">
                    {([
                      { id: 'flat', label: '扁平' },
                      { id: 'raised', label: '浮起' },
                      { id: 'outline', label: '描边' },
                    ] as const).map(({ id, label }) => (
                      <button
                        key={id}
                        className={`card-style-option ${settings.cardStyle === id ? 'active' : ''}`}
                        onClick={() => onChange({ cardStyle: id })}
                      >
                        <span className={`cs-sample ${id}`}>
                          <i className="cs-avatar" />
                          <i className="cs-line" />
                          <i className="cs-line short" />
                        </span>
                        <strong>{label}</strong>
                        {settings.cardStyle === id && (
                          <span className="cs-check"><Check size={10} strokeWidth={3} /></span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </SetCard>

              <SetCard title="质感" desc="密度、圆角与毛玻璃强度会作用于所有面板">
                <SettingRow title="界面密度">
                  <Segmented
                    value={settings.density}
                    options={[
                      { value: 'compact', label: '紧凑' },
                      { value: 'cozy', label: '舒适' },
                      { value: 'spacious', label: '宽松' },
                    ]}
                    onChange={(value) => onChange({ density: value })}
                  />
                </SettingRow>
                <SettingRow title="圆角" desc="0 更硬朗，22 更圆润">
                  <Slider
                    value={settings.radius}
                    min={6}
                    max={22}
                    suffix=" px"
                    onChange={(value) => onChange({ radius: value })}
                  />
                </SettingRow>
                <SettingRow title="背景模糊" desc="毛玻璃强度，过高会影响低端设备性能">
                  <Slider
                    value={settings.blur}
                    min={0}
                    max={40}
                    suffix=" px"
                    onChange={(value) => onChange({ blur: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="纯色区域不透明度"
                  desc="统一调整卡片、侧栏、面板等纯色区域，默认 80%；100% 完全不透明"
                >
                  <Slider
                    value={settings.panelOpacity}
                    min={30}
                    max={100}
                    step={5}
                    suffix="%"
                    onChange={(value) => onChange({ panelOpacity: value })}
                  />
                </SettingRow>
                <SettingRow title="消息字号" desc="聊天与私聊正文大小，12–16 px">
                  <Slider
                    value={settings.chatFontSize}
                    min={12}
                    max={16}
                    suffix=" px"
                    onChange={(value) => onChange({ chatFontSize: value })}
                  />
                </SettingRow>
                <SettingRow title="侧栏宽度" desc="频道列表宽度，屏幕较宽时加宽更好读">
                  <Slider
                    value={settings.sidebarWidth}
                    min={232}
                    max={320}
                    step={12}
                    suffix=" px"
                    onChange={(value) => onChange({ sidebarWidth: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="高对比文字"
                  desc="加深次要文字与分割线，适合低亮度或高分辨率屏幕"
                >
                  <Switch
                    checked={settings.contrast === 'high'}
                    onChange={(value) =>
                      onChange({ contrast: value ? 'high' : 'normal' })
                    }
                  />
                </SettingRow>
                <SettingRow title="界面动画" desc="关闭后取消过渡与说话光效">
                  <Switch
                    checked={settings.animations}
                    onChange={(value) => onChange({ animations: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn ghost" onClick={resetAppearance}>
                    <RotateCcw size={13} strokeWidth={2} />
                    恢复默认外观
                  </button>
                  <span className="set-note">仅重置外观相关项，不影响账号、音频与快捷键</span>
                </div>
              </SetCard>

              <SetCard title="背景" desc="预设渐变或自定义图片，遮罩强度保证内容可读">
                <div className="bg-grid">
                  {(Object.keys(backgroundPresets) as Array<keyof typeof backgroundPresets>).map(
                    (id) => (
                      <button
                        key={id}
                        className={`bg-option ${settings.background === id ? 'active' : ''}`}
                        onClick={() => onChange({ background: id })}
                      >
                        <span
                          className="bg-preview"
                          style={{ background: dark ? backgroundPresets[id].dark : backgroundPresets[id].light }}
                        />
                        <span className="bg-name">{backgroundPresets[id].name}</span>
                        {settings.background === id && (
                          <span className="bg-check"><Check size={10} strokeWidth={3} /></span>
                        )}
                      </button>
                    ),
                  )}
                </div>
                <div className="bg-custom">
                  <SettingRow title="自定义背景图" desc="HTTPS 图片地址，留空则使用预设">
                    <div className="inline-field">
                      <TextInput
                        value={settings.backgroundImage}
                        placeholder="https://…"
                        onChange={(value) => onChange({ backgroundImage: value })}
                      />
                      {settings.backgroundImage && (
                        <button
                          className="icon-btn"
                          title="清除图片"
                          onClick={() => onChange({ backgroundImage: '' })}
                        >
                          <Trash2 size={14} strokeWidth={2} />
                        </button>
                      )}
                    </div>
                  </SettingRow>
                  {customBackground && (
                    <div className="bg-custom-card">
                      <span
                        className="bg-custom-thumb"
                        style={{ backgroundImage: `url(${JSON.stringify(customBackground)})` }}
                      />
                      <div>
                        <strong>已应用自定义背景</strong>
                        <em>调整下方遮罩强度，保证面板与文字清晰</em>
                      </div>
                    </div>
                  )}
                  <SettingRow title="背景遮罩" desc="数值越高背景越暗，文字对比更清晰">
                    <Slider
                      value={settings.backgroundDim}
                      min={0}
                      max={90}
                      step={5}
                      suffix=" %"
                      onChange={(value) => onChange({ backgroundDim: value })}
                    />
                  </SettingRow>
                </div>
              </SetCard>

              <SetCard title="内容显示" desc="消息与成员状态的细节开关">
                <SettingRow title="消息气泡" desc="关闭后使用紧凑的纯文本样式">
                  <Switch
                    checked={settings.chatBubbles}
                    onChange={(value) => onChange({ chatBubbles: value })}
                  />
                </SettingRow>
                <SettingRow title="显示时间戳">
                  <Switch
                    checked={settings.showTimestamps}
                    onChange={(value) => onChange({ showTimestamps: value })}
                  />
                </SettingRow>
                <SettingRow title="成员状态图标" desc="麦克风、扬声器、手机端与离开状态">
                  <Switch
                    checked={settings.showMemberState}
                    onChange={(value) => onChange({ showMemberState: value })}
                  />
                </SettingRow>
                <SettingRow title="频道自定义图标" desc="读取 TeamSpeak 频道的 icon_id">
                  <Switch
                    checked={settings.showChannelIcons}
                    onChange={(value) => onChange({ showChannelIcons: value })}
                  />
                </SettingRow>
                <SettingRow title="服务器组标签" desc="在成员卡片上显示服务器组徽标">
                  <Switch
                    checked={settings.showGroupChips}
                    onChange={(value) => onChange({ showGroupChips: value })}
                  />
                </SettingRow>
                <SettingRow title="频道成员数" desc="在频道树右侧显示在线人数">
                  <Switch
                    checked={settings.showChannelCounts}
                    onChange={(value) => onChange({ showChannelCounts: value })}
                  />
                </SettingRow>
              </SetCard>
            </>
          )}

          {section === 'hotkeys' && (
            <SetCard title="快捷键" desc="点击按键框后按下组合键即可录制，Esc 取消">
              {hotkeyRows.map(([key, label]) => (
                <SettingRow
                  key={key}
                  title={label}
                  desc={key === 'ptt' ? '按住说话，松开即停' : '窗口聚焦时生效'}
                >
                  <HotkeyInput
                    value={settings.hotkeys[key]}
                    onChange={(value) =>
                      onChange({ hotkeys: { ...settings.hotkeys, [key]: value } })
                    }
                  />
                </SettingRow>
              ))}
              <div className="inline-actions">
                <button
                  className="small-btn ghost"
                  onClick={() => onChange({ hotkeys: defaultSettings.hotkeys })}
                >
                  <RotateCcw size={13} strokeWidth={2} />
                  恢复默认快捷键
                </button>
              </div>
              <p className="set-note">
                快捷键在 RaySpeak 窗口聚焦时生效；在输入框、搜索框内不会触发。
                按键说话与「语音与音频」中的 PTT 按键共用同一组合。
              </p>
            </SetCard>
          )}

          {section === 'notify' && (
            <>
              <SetCard title="桌面通知" desc="对应 TeamSpeak 文本消息与被提及提醒">
                <SettingRow title="启用桌面通知" desc="窗口在后台时弹出系统通知">
                  <Switch
                    checked={settings.desktopNotify}
                    onChange={(value) => {
                      onChange({ desktopNotify: value })
                      if (value) {
                        void ensureNotifyPermission().then((granted) => {
                          if (!granted) onToast('系统通知权限未授予，仍会显示应用内提示')
                        })
                      }
                    }}
                  />
                </SettingRow>
                <SettingRow title="通知声音">
                  <Switch
                    checked={settings.notifySound}
                    onChange={(value) => onChange({ notifySound: value })}
                  />
                </SettingRow>
                <SettingRow title="仅提醒被提及" desc="频道消息只在 @我 时提醒；私聊与戳一戳仍会提醒">
                  <Switch
                    checked={settings.mentionOnly}
                    onChange={(value) => onChange({ mentionOnly: value })}
                  />
                </SettingRow>
                <SettingRow title="勿扰模式" desc="静音所有提醒，连接状态显示为勿扰">
                  <Switch
                    checked={settings.dnd}
                    onChange={(value) => onChange({ dnd: value })}
                  />
                </SettingRow>
                <SettingRow title="提示音" desc="选择通知音色">
                  <Select
                    value={settings.notifyTone}
                    options={['叮咚', '轻铃', '水滴', '木鱼']}
                    onChange={(value) => onChange({ notifyTone: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void testNotification()}>
                    <Bell size={13} strokeWidth={2} />
                    发送测试通知
                  </button>
                </div>
              </SetCard>

              <SetCard
                title="频道提醒"
                desc="只关注你自己所在频道：有人进来或离开时记录并提示，其它频道不打扰"
              >
                <SettingRow title="成员进出提醒" desc="在消息区记录你所在频道的进出">
                  <Switch
                    checked={settings.notifyJoinLeave}
                    onChange={(value) => onChange({ notifyJoinLeave: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="进出提示音"
                  desc="有人进出你所在频道时播放短提示音，勿扰模式下自动静音"
                >
                  <Switch
                    checked={settings.joinLeaveSound}
                    onChange={(value) => onChange({ joinLeaveSound: value })}
                  />
                </SettingRow>
              </SetCard>
            </>
          )}

          {section === 'privacy' && (
            <>
              <SetCard title="隐私" desc="控制本机如何显示与接收消息">
                <SettingRow
                  title="允许接收私聊"
                  desc="关闭后本机会忽略其他人的私聊消息与戳一戳"
                >
                  <Switch
                    checked={settings.allowDm}
                    onChange={(value) => onChange({ allowDm: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="显示在线状态"
                  desc="关闭后本机界面隐藏在线状态标记，不会改动服务器数据"
                >
                  <Switch
                    checked={settings.showPresence}
                    onChange={(value) => onChange({ showPresence: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="我的状态" desc="离开状态会同步到服务器，其他成员可以看到">
                <SettingRow title="状态">
                  <Segmented
                    value={settings.presenceStatus}
                    options={[
                      { value: 'online', label: '在线' },
                      { value: 'away', label: '离开' },
                    ]}
                    onChange={(value) =>
                      onChange({ presenceStatus: value as 'online' | 'away' })
                    }
                  />
                </SettingRow>
                {settings.presenceStatus === 'away' && (
                  <SettingRow title="离开说明" desc="显示给其他成员">
                    <TextInput
                      value={settings.awayMessage}
                      maxLength={80}
                      placeholder="暂时离开"
                      onChange={(value) => onChange({ awayMessage: value })}
                    />
                  </SettingRow>
                )}
                {settings.dnd && (
                  <p className="set-note">勿扰模式已开启，服务器状态会显示为「勿扰模式」。</p>
                )}
              </SetCard>

              <SetCard title="身份安全" desc="身份密钥由应用首次启动时生成并保存在本机">
                <SettingRow title="当前安全级别" desc="RSA 谜题计算出的身份等级">
                  <span className="status-chip online">10 级</span>
                </SettingRow>
                <div className="security-meter">
                  <span style={{ width: '33%' }} />
                </div>
                <p className="set-note">
                  更换或提升身份会改变 UID，现有服务器组与权限将失效，因此当前版本保持固定身份。
                </p>
              </SetCard>

              <SetCard title="屏蔽列表" desc="被屏蔽用户的消息、戳一戳与本机语音输出会被过滤">
                {blocked.length === 0 && (
                  <div className="blocked-empty">
                    <ShieldCheck size={18} strokeWidth={1.8} />
                    <span>还没有屏蔽任何人</span>
                  </div>
                )}
                {blocked.map((client) => (
                  <div className="blocked-row" key={client.id}>
                    <span>{stripClientTags(client.name)}</span>
                    <button
                      className="small-btn ghost"
                      onClick={() =>
                        onChange({ blocked: settings.blocked.filter((id) => id !== client.id) })
                      }
                    >
                      解除屏蔽
                    </button>
                  </div>
                ))}
                {blocked.length > 0 && (
                  <div className="inline-actions">
                    <button
                      className="small-btn ghost"
                      onClick={() => onChange({ blocked: [] })}
                    >
                      清空屏蔽列表
                    </button>
                  </div>
                )}
              </SetCard>
            </>
          )}

          {section === 'advanced' && (
            <>
              <SetCard title="连接" desc="连接超时与断线行为">
                <SettingRow title="允许文件传输" desc="用于频道图标与文件，图标下载为明文 TCP">
                  <Switch
                    checked={settings.fileTransfer}
                    onChange={(value) => onChange({ fileTransfer: value })}
                  />
                </SettingRow>
                <SettingRow
                  title="自动重连"
                  desc="网络中断后用本次会话凭据自动重试最多 3 次"
                >
                  <Switch
                    checked={settings.autoReconnect}
                    onChange={(value) => onChange({ autoReconnect: value })}
                  />
                </SettingRow>
                <SettingRow title="连接超时" desc="等待握手与频道目录的秒数">
                  <Slider
                    value={settings.timeout}
                    min={5}
                    max={60}
                    step={5}
                    suffix=" 秒"
                    onChange={(value) => onChange({ timeout: value })}
                  />
                </SettingRow>
              </SetCard>

              <SetCard title="预览与诊断" desc="演示事件只在浏览器预览模式生效">
                <SettingRow
                  title="演示事件"
                  desc="每 7 秒让一名成员切换频道，用于验证动态成员列表"
                >
                  <Switch
                    checked={settings.demoEvents}
                    onChange={(value) => onChange({ demoEvents: value })}
                  />
                </SettingRow>
                <div className="inline-actions">
                  <button className="small-btn" onClick={() => void copyDiagnostics()}>
                    <Copy size={13} strokeWidth={2} />
                    复制诊断信息
                  </button>
                </div>
              </SetCard>

              <SetCard
                title="协议能力对照"
                desc="基于 tsclient-rs 当前实现；共享与文件面板已具备，但入口暂时隐藏"
              >
                <div className="protocol-list">
                  {protocolRows.map(([name, detail, status]) => (
                    <div className="protocol-row" key={name}>
                      <span className="protocol-icon">
                        <Server size={14} strokeWidth={1.9} />
                      </span>
                      <div>
                        <strong>{name}</strong>
                        <em>{detail}</em>
                      </div>
                      <span
                        className={`status-chip ${
                          status === '内核已支持' ? 'online' : status === '需应用层' ? 'pending' : 'unsupported'
                        }`}
                      >
                        {status}
                      </span>
                    </div>
                  ))}
                </div>
              </SetCard>

              <SetCard title="危险操作" desc="仅影响本机设置，不影响服务器">
                <div className="inline-actions">
                  <button className="small-btn danger" onClick={onReset}>
                    <RotateCcw size={13} strokeWidth={2} />
                    恢复全部默认设置
                  </button>
                  <button
                    className="small-btn ghost"
                    onClick={() => {
                      let removed = 0
                      try {
                        const keys = Object.keys(localStorage).filter(
                          (key) =>
                            key.startsWith('rayspeak.volumes') ||
                            key.startsWith('rayspeak.nickname') ||
                            key.startsWith('rayspeak.dm.') ||
                            key.startsWith('rayspeak.avatars') ||
                            key.startsWith('rayspeak.contacts'),
                        )
                        keys.forEach((key) => localStorage.removeItem(key))
                        removed = keys.length
                      } catch {
                        onToast('本地存储不可用')
                        return
                      }
                      clearLocalStore()
                      onToast(`已清理 ${removed} 项本地缓存（含头像与联系人目录）`)
                    }}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    清理本地缓存
                  </button>
                </div>
              </SetCard>
            </>
          )}

          {section === 'about' && (
            <>
              <section className="about-hero">
                <span className="about-logo">
                  <img src="/logo.png" alt="" draggable={false} />
                </span>
                <div>
                  <h2>RaySpeak</h2>
                  <p>为 TeamSpeak 打造的现代第三方桌面客户端</p>
                  <span className="version-pill">
            v{appInfo?.version ?? '0.2.0'} · 协议接入
          </span>
                </div>
              </section>

              <SetCard title="技术栈" desc="低占用、可打包为单个 Windows 安装包">
                <AboutRow label="界面" value="React 19 + TypeScript 5.6 + Vite 6" />
                <AboutRow label="桌面容器" value="Tauri 2 · WebView2 · NSIS 安装包" />
                <AboutRow label="协议内核" value="tsclient-rs（Rust）" />
                <AboutRow label="音频" value="Opus 48kHz · WebView2 采集 · WebAudio" />
                <AboutRow label="界面语言" value="简体中文" />
                <AboutRow label="数据目录" value={appInfo?.dataDir ?? '连接后读取'} />
              </SetCard>

              <SetCard title="当前状态" desc="协议与音频已接入，持续在真实服务器上调优">
                <div className="about-status">
                  <div>
                    <span className="status-dot done" />
                    <strong>UI 与交互</strong>
                    <em>私聊、频道管理、资料卡与通知已完成（共享与文件入口暂缓展示）</em>
                  </div>
                  <div>
                    <span className="status-dot done" />
                    <strong>协议接入</strong>
                    <em>连接、频道、消息、权限、图标与文件链路已接入 tsclient-rs</em>
                  </div>
                  <div>
                    <span className="status-dot done" />
                    <strong>音频与设备</strong>
                    <em>WebCodecs Opus 收发、抖动缓冲、降噪与回声消除</em>
                  </div>
                </div>
              </SetCard>

              <SetCard title="说明" desc="非官方客户端">
                <p className="about-text">
                  RaySpeak 是社区项目，与 TeamSpeak Systems GmbH 无关联。桌面应用中频道、成员、图标与身份均由服务器实时下发；
                  浏览器预览使用内置演示数据。服务器地址只保留在应用配置中，不会显示在界面或错误信息里。
                </p>
                <div className="inline-actions">
                  <button
                    className="small-btn"
                    onClick={() => {
                      if (demoMode) {
                        onToast('仅桌面应用可打开数据目录')
                        return
                      }
                      protocol
                        .openDataDir()
                        .then(() => onToast('已打开应用数据目录'))
                        .catch((error) => onToast(errorText(error)))
                    }}
                  >
                    打开数据目录
                  </button>
                  <button className="small-btn ghost" onClick={copyDiagnostics}>
                    复制调试信息
                  </button>
                </div>
              </SetCard>
            </>
          )}

          <footer className="settings-footer">
            <Columns2 size={13} strokeWidth={2} />
            <span>提示：房间头部可随时切换布局、在线状态与深/浅色模式</span>
            <LayoutGrid size={13} strokeWidth={2} />
          </footer>
        </div>
      </div>
    </div>
  )
}

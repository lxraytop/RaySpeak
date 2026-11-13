import type {
  BackgroundId,
  CardStyle,
  Density,
  LayoutId,
  ThemeMode,
} from './types'

export type NoiseSuppressor = 'off' | 'gate' | 'chromium' | 'speex' | 'rnnoise'

/**
 * 一套完整的音频配置。用户可保存多套并按场景切换（开会 / 游戏 / 音乐 / 外放）。
 * 切换配置只是把这里的字段写回 Settings 的扁平字段，引擎读取的仍是扁平值，
 * 因此不存在「配置与实际生效不一致」的问题。
 */
export interface AudioProfile {
  id: string
  name: string
  inputDevice: string
  // 原生采集（cpal/WASAPI）只认设备名，与浏览器的 deviceId 是两个命名空间。
  // 选择设备时同步写这里，避免运行期再依赖浏览器是否已授权拿到 label。
  nativeInput: string
  outputDevice: string
  inputVolume: number
  outputVolume: number
  inputMode: 'vad' | 'ptt' | 'open'
  inputSensitivity: 'auto' | 'manual'
  noiseFloorDb: number
  voiceHoldMs: number
  vadThreshold: number
  echoCancel: boolean
  noiseSuppressor: NoiseSuppressor
  highPass: boolean
  gateDepth: number
  autoGain: boolean
  nativeMic: boolean
  musicMode: boolean
  bitrate: number
  frameSize: number
  jitterBuffer: number
  latencyMode: 'low' | 'balanced' | 'stable'
}

export const AUDIO_PROFILE_KEYS: Array<keyof AudioProfile> = [
  'inputDevice',
  'nativeInput',
  'outputDevice',
  'inputVolume',
  'outputVolume',
  'inputMode',
  'inputSensitivity',
  'noiseFloorDb',
  'voiceHoldMs',
  'vadThreshold',
  'echoCancel',
  'noiseSuppressor',
  'highPass',
  'gateDepth',
  'autoGain',
  'nativeMic',
  'musicMode',
  'bitrate',
  'frameSize',
  'jitterBuffer',
  'latencyMode',
]

export function captureAudioProfile(
  settings: Settings,
  id: string,
  name: string,
): AudioProfile {
  const profile = { id, name } as AudioProfile
  const source = settings as unknown as Record<string, unknown>
  for (const key of AUDIO_PROFILE_KEYS) {
    // 两边字段同名同型，逐键拷贝即可
    ;(profile as unknown as Record<string, unknown>)[key] = source[key]
  }
  return profile
}

export function audioProfilePatch(profile: AudioProfile): Partial<Settings> {
  const patch: Partial<Settings> = {}
  for (const key of AUDIO_PROFILE_KEYS) {
    ;(patch as Record<string, unknown>)[key] = profile[key]
  }
  return patch
}

export function newProfileId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export interface Settings {
  nickname: string
  description: string
  theme: ThemeMode
  accent: string
  density: Density
  radius: number
  blur: number
  panelOpacity: number
  contrast: 'normal' | 'high'
  chatFontSize: number
  sidebarWidth: number
  background: BackgroundId
  backgroundImage: string
  backgroundDim: number
  layout: LayoutId
  cardStyle: CardStyle
  animations: boolean
  chatBubbles: boolean
  showTimestamps: boolean
  showMemberState: boolean
  showChannelIcons: boolean
  showGroupChips: boolean
  showChannelCounts: boolean
  inputDevice: string
  nativeInput: string
  outputDevice: string
  inputVolume: number
  outputVolume: number
  inputMode: 'vad' | 'ptt' | 'open'
  inputSensitivity: 'auto' | 'manual'
  noiseFloorDb: number
  voiceHoldMs: number
  vadThreshold: number
  echoCancel: boolean
  noiseSuppressor: NoiseSuppressor
  highPass: boolean
  gateDepth: number
  autoGain: boolean
  nativeMic: boolean
  musicMode: boolean
  bitrate: number
  frameSize: number
  jitterBuffer: number
  latencyMode: 'low' | 'balanced' | 'stable'
  audioProfiles: AudioProfile[]
  activeProfileId: string
  hotkeys: {
    ptt: string
    mute: string
    deafen: string
    settings: string
    disconnect: string
    layout: string
  }
  desktopNotify: boolean
  notifySound: boolean
  mentionOnly: boolean
  dnd: boolean
  notifyTone: string
  allowDm: boolean
  showPresence: boolean
  presenceStatus: 'online' | 'away'
  awayMessage: string
  notifyJoinLeave: boolean
  joinLeaveSound: boolean
  blocked: string[]
  fileTransfer: boolean
  autoReconnect: boolean
  timeout: number
  demoEvents: boolean
}

export const accentPresets = [
  { name: '雷蓝', value: '#3d6bf5' },
  { name: '星紫', value: '#7c5cf6' },
  { name: '晴空', value: '#0ea5e9' },
  { name: '薄荷', value: '#10b981' },
  { name: '琥珀', value: '#f59e0b' },
  { name: '珊瑚', value: '#ef4444' },
  { name: '樱花', value: '#ec4899' },
  { name: '青碧', value: '#14b8a6' },
]

export const backgroundPresets: Record<
  BackgroundId,
  { name: string; light: string; dark: string }
> = {
  mist: {
    name: '晨雾',
    light:
      'radial-gradient(1200px 700px at 90% -10%, #e4edff 0%, rgba(228,237,255,0) 58%), radial-gradient(900px 620px at -8% 28%, #e9f2fc 0%, rgba(233,242,252,0) 55%), linear-gradient(158deg, #f4f8fe 0%, #eaf0f9 55%, #eef4fc 100%)',
    dark:
      'radial-gradient(1100px 700px at 92% -12%, #1e3054 0%, rgba(30,48,84,0) 55%), radial-gradient(900px 600px at -8% 30%, #1b2c46 0%, rgba(27,44,70,0) 55%), linear-gradient(158deg, #121825 0%, #0f1521 55%, #121a28 100%)',
  },
  mint: {
    name: '薄荷',
    light:
      'radial-gradient(1000px 600px at 88% -6%, #d9f7ec 0%, rgba(217,247,236,0) 55%), radial-gradient(800px 500px at 0% 40%, #e4f2ff 0%, rgba(228,242,255,0) 55%), linear-gradient(160deg, #f2fcf8 0%, #eaf7f4 55%, #eef6fb 100%)',
    dark:
      'radial-gradient(1000px 620px at 90% -8%, #143b33 0%, rgba(20,59,51,0) 55%), radial-gradient(800px 520px at -5% 35%, #0f2a35 0%, rgba(15,42,53,0) 55%), linear-gradient(160deg, #0e1a19 0%, #0d1716 55%, #0f1a20 100%)',
  },
  sunset: {
    name: '晚霞',
    light:
      'radial-gradient(1000px 640px at 92% -8%, #ffe2ec 0%, rgba(255,226,236,0) 55%), radial-gradient(820px 560px at -6% 40%, #e6e9ff 0%, rgba(230,233,255,0) 55%), linear-gradient(160deg, #fdf6fa 0%, #f4eef8 55%, #eef2fb 100%)',
    dark:
      'radial-gradient(1000px 640px at 92% -8%, #3a1f36 0%, rgba(58,31,54,0) 55%), radial-gradient(820px 560px at -6% 40%, #1c2145 0%, rgba(28,33,69,0) 55%), linear-gradient(160deg, #191420 0%, #151020 55%, #10131f 100%)',
  },
  aurora: {
    name: '极光',
    light:
      'radial-gradient(1000px 620px at 82% -12%, #d9f0ff 0%, rgba(217,240,255,0) 56%), radial-gradient(900px 560px at 6% 12%, #e7dcff 0%, rgba(231,220,255,0) 52%), radial-gradient(800px 500px at 40% 110%, #dcf7ef 0%, rgba(220,247,239,0) 55%), linear-gradient(160deg, #f6f9ff 0%, #eef3fc 100%)',
    dark:
      'radial-gradient(1000px 620px at 82% -12%, #123a52 0%, rgba(18,58,82,0) 56%), radial-gradient(900px 560px at 6% 12%, #2a1c4f 0%, rgba(42,28,79,0) 52%), radial-gradient(800px 500px at 40% 110%, #0f3a34 0%, rgba(15,58,52,0) 55%), linear-gradient(160deg, #0c1220 0%, #0f1624 100%)',
  },
  plain: {
    name: '纯色',
    light: 'linear-gradient(160deg, #f3f6fc 0%, #eef2fa 100%)',
    dark: 'linear-gradient(160deg, #101724 0%, #0d131d 100%)',
  },
}

export const defaultSettings: Settings = {
  nickname: '我',
  description: '休闲玩家，晚上八点后在线。',
  theme: 'light',
  accent: '#3d6bf5',
  density: 'cozy',
  radius: 14,
  blur: 12,
  panelOpacity: 80,
  contrast: 'normal',
  chatFontSize: 13,
  sidebarWidth: 268,
  background: 'mist',
  backgroundImage: '',
  backgroundDim: 30,
  layout: 'cards',
  cardStyle: 'raised',
  animations: true,
  chatBubbles: true,
  showTimestamps: true,
  showMemberState: true,
  showChannelIcons: true,
  showGroupChips: true,
  showChannelCounts: true,
  inputDevice: '',
  nativeInput: '',
  outputDevice: '',
  inputVolume: 100,
  outputVolume: 100,
  inputMode: 'vad',
  inputSensitivity: 'auto',
  noiseFloorDb: -60,
  voiceHoldMs: 300,
  vadThreshold: -45,
  echoCancel: true,
  noiseSuppressor: 'chromium',
  highPass: true,
  gateDepth: 18,
  autoGain: true,
  nativeMic: false,
  musicMode: false,
  bitrate: 64,
  frameSize: 20,
  jitterBuffer: 80,
  latencyMode: 'balanced',
  audioProfiles: [],
  activeProfileId: '',
  hotkeys: {
    ptt: 'V',
    mute: 'Ctrl+Shift+M',
    deafen: 'Ctrl+Shift+D',
    settings: 'Ctrl+,',
    disconnect: 'Ctrl+Shift+Q',
    layout: 'Ctrl+Shift+L',
  },
  desktopNotify: true,
  notifySound: true,
  mentionOnly: false,
  dnd: false,
  notifyTone: '叮咚',
  allowDm: true,
  showPresence: true,
  presenceStatus: 'online',
  awayMessage: '暂时离开',
  notifyJoinLeave: true,
  joinLeaveSound: true,
  blocked: [],
  fileTransfer: true,
  autoReconnect: true,
  timeout: 20,
  demoEvents: false,
}

const STORAGE_KEY = 'rayspeak.settings.v2'
const DEFAULTS_KEY = 'rayspeak.settings.defaults'


/**
 * 旧版本里明显不合理的默认值。升级时只把「仍然等于旧默认值」的字段换成新默认值，
 * 用户手动改过的配置保持不变。
 */
const LEGACY_DEFAULTS: Partial<Record<keyof Settings, unknown>> = {
  inputVolume: 78,
  outputVolume: 82,
  vadThreshold: -38,
  jitterBuffer: 60,
  timeout: 15,
  blur: 18,
  backgroundDim: 40,
  autoGain: false,
}
const DEFAULTS_VERSION = '3'

function migrateDefaults(parsed: Partial<Settings>): Partial<Settings> {
  try {
    if (localStorage.getItem(DEFAULTS_KEY) === DEFAULTS_VERSION) return parsed
    localStorage.setItem(DEFAULTS_KEY, DEFAULTS_VERSION)
  } catch {
    return parsed
  }
  const next: Partial<Settings> = { ...parsed }
  for (const [key, legacy] of Object.entries(LEGACY_DEFAULTS)) {
    const field = key as keyof Settings
    if (next[field] === legacy) {
      ;(next as Record<string, unknown>)[field] = defaultSettings[field]
    }
  }
  return next
}

/**
 * 语音处理预设：参考 TeamSpeak 3 的 DSP 预设与 Discord 的三开关组合，
 * 预设只写入开关本身，不额外保存状态，用户改任一开关即视为「自定义」。
 */
export const voiceProcessPresets: Array<{
  id: 'off' | 'light' | 'standard' | 'music'
  name: string
  desc: string
  patch: Partial<Settings>
}> = [
  {
    id: 'off',
    name: '关闭',
    desc: '不做任何处理，延迟最低',
    patch: { echoCancel: false, noiseSuppressor: 'off', autoGain: false, musicMode: false },
  },
  {
    id: 'light',
    name: '轻度',
    desc: '只消回声，保留环境声',
    patch: { echoCancel: true, noiseSuppressor: 'off', autoGain: false, musicMode: false },
  },
  {
    id: 'standard',
    name: '标准',
    desc: '回声消除 + 降噪 + 自动增益',
    patch: { echoCancel: true, noiseSuppressor: 'chromium', autoGain: true, musicMode: false },
  },
  {
    id: 'music',
    name: '音乐',
    desc: '关处理，立体声高码率',
    patch: {
      echoCancel: false,
      noiseSuppressor: 'off',
      autoGain: false,
      musicMode: true,
      bitrate: 96,
    },
  },
]

/**
 * 降噪方式元数据。`path` 说明该方式在哪种采集链路下真正生效：
 * WebView 只能用 Chromium 内置 NS 与噪声门；SpeexDSP / RNNoise 需要原生采集。
 */
export const noiseSuppressors: Array<{
  id: NoiseSuppressor
  name: string
  short: string
  desc: string
  path: 'webview' | 'native'
}> = [
  {
    id: 'off',
    name: '关闭',
    short: '不做降噪',
    desc: '保留原始环境声，适合外接声卡且环境安静的场景',
    path: 'webview',
  },
  {
    id: 'gate',
    name: '噪声门',
    short: '轻量 · 低延迟',
    desc: '低于阈值的底噪整体压暗，几乎不增加延迟，对键盘、风扇有效',
    path: 'webview',
  },
  {
    id: 'chromium',
    name: '智能降噪',
    short: 'WebView 内置 · 通用',
    desc: 'Chromium 的谱减降噪，日常通话最稳，CPU 占用低',
    path: 'webview',
  },
  {
    id: 'speex',
    name: 'SpeexDSP',
    short: '原生 · 强度可控',
    desc: 'Mumble 同源的谱减降噪，稳态噪声抑制更强，需开启原生麦克风',
    path: 'native',
  },
  {
    id: 'rnnoise',
    name: 'RNNoise',
    short: '原生 · 神经网络',
    desc: 'Xiph 的循环神经网络降噪，对人声保留更好，需开启原生麦克风',
    path: 'native',
  },
]

export function effectiveNoiseSuppressor(settings: Settings) {
  if (settings.nativeMic) return settings.noiseSuppressor
  // WebView 链路只有 Chromium 与噪声门两种能力，其余降级为噪声门。
  return settings.noiseSuppressor === 'speex' || settings.noiseSuppressor === 'rnnoise'
    ? 'gate'
    : settings.noiseSuppressor
}

export function activeProcessPreset(settings: Settings) {
  const match = voiceProcessPresets.find(
    (preset) =>
      (preset.patch.echoCancel ?? false) === !!settings.echoCancel &&
      (preset.patch.noiseSuppressor ?? 'off') === settings.noiseSuppressor &&
      (preset.patch.autoGain ?? false) === !!settings.autoGain &&
      (preset.patch.musicMode ?? false) === !!settings.musicMode,
  )
  return match?.id ?? 'custom'
}

/**
 * 自动灵敏度：以环境底噪为基准上浮固定余量，并夹在可用区间内。
 * 与 Discord「自动输入灵敏度」、Mumble 的噪声底噪估计思路一致。
 */
export function autoVadThreshold(noiseFloorDb: number) {
  const floor = Number.isFinite(noiseFloorDb) ? noiseFloorDb : -60
  return Math.max(-60, Math.min(-20, Math.round(floor + 9)))
}

export function effectiveVadThreshold(settings: Settings) {
  return settings.inputSensitivity === 'auto'
    ? autoVadThreshold(settings.noiseFloorDb)
    : settings.vadThreshold
}

/** 保证至少有一套配置，并且 activeProfileId 指向存在的配置。 */
export function ensureProfiles(settings: Settings): Settings {
  if (settings.audioProfiles.length > 0) {
    // 旧配置档没有 nativeInput 字段，补齐为「跟随系统默认」。
    const profiles = settings.audioProfiles.map((profile) => ({
      ...profile,
      nativeInput: typeof profile.nativeInput === 'string' ? profile.nativeInput : '',
    }))
    const active = profiles.some((item) => item.id === settings.activeProfileId)
    return {
      ...settings,
      audioProfiles: profiles,
      activeProfileId: active ? settings.activeProfileId : profiles[0].id,
    }
  }
  const profile = captureAudioProfile(settings, newProfileId(), '默认')
  return { ...settings, audioProfiles: [profile], activeProfileId: profile.id }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return ensureProfiles({ ...defaultSettings, audioProfiles: [], activeProfileId: '' })
    const parsed = migrateDefaults(JSON.parse(raw) as Partial<Settings>)
    const legacyDevice = (value: unknown) =>
      typeof value === 'string' && value.includes('(') && value.includes(')') ? '' : value
    // 旧版本用布尔 noiseSuppress；升级时按「关 → off、开 → chromium」映射。
    const legacySuppress = (parsed as { noiseSuppress?: boolean }).noiseSuppress
    const suppressor: NoiseSuppressor = noiseSuppressors.some(
      (item) => item.id === parsed.noiseSuppressor,
    )
      ? (parsed.noiseSuppressor as NoiseSuppressor)
      : legacySuppress === false
        ? 'off'
        : defaultSettings.noiseSuppressor
    const result: Settings = {
      ...defaultSettings,
      ...parsed,
      inputDevice: (legacyDevice(parsed.inputDevice) as string) ?? defaultSettings.inputDevice,
      nativeInput: typeof parsed.nativeInput === 'string' ? parsed.nativeInput : '',
      outputDevice:
        (legacyDevice(parsed.outputDevice) as string) ?? defaultSettings.outputDevice,
      inputMode:
        parsed.inputMode === 'ptt' || parsed.inputMode === 'open' ? parsed.inputMode : 'vad',
      inputSensitivity: parsed.inputSensitivity === 'manual' ? 'manual' : 'auto',
      noiseSuppressor: suppressor,
      highPass: parsed.highPass !== false,
      gateDepth: Number.isFinite(parsed.gateDepth)
        ? Math.max(0, Math.min(40, Number(parsed.gateDepth)))
        : defaultSettings.gateDepth,
      noiseFloorDb: Number.isFinite(parsed.noiseFloorDb)
        ? Math.max(-90, Math.min(-20, Number(parsed.noiseFloorDb)))
        : defaultSettings.noiseFloorDb,
      voiceHoldMs: Number.isFinite(parsed.voiceHoldMs)
        ? Math.max(100, Math.min(1000, Number(parsed.voiceHoldMs)))
        : defaultSettings.voiceHoldMs,
      hotkeys: { ...defaultSettings.hotkeys, ...(parsed.hotkeys ?? {}) },
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
      audioProfiles: Array.isArray(parsed.audioProfiles) ? parsed.audioProfiles : [],
      activeProfileId:
        typeof parsed.activeProfileId === 'string' ? parsed.activeProfileId : '',
    }
    return ensureProfiles(result)
  } catch {
    return ensureProfiles({ ...defaultSettings, audioProfiles: [], activeProfileId: '' })
  }
}

export function saveSettings(settings: Settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* storage unavailable */
  }
}

export function safeImage(url: string) {
  const trimmed = url.trim()
  if (!trimmed) return ''
  try {
    const parsed = new URL(trimmed)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || trimmed.startsWith('data:image/')) {
      return trimmed
    }
  } catch {
    return ''
  }
  return ''
}

export function isDark(theme: ThemeMode) {
  if (theme === 'dark') return true
  if (theme === 'light') return false
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

export function applySettings(settings: Settings) {
  const root = document.documentElement
  const dark = isDark(settings.theme)
  root.dataset.theme = dark ? 'dark' : 'light'
  root.dataset.density = settings.density
  root.dataset.motion = settings.animations ? 'on' : 'off'
  root.dataset.chatBubbles = settings.chatBubbles ? 'on' : 'off'
  root.dataset.cards = settings.cardStyle
  root.dataset.timestamps = settings.showTimestamps ? 'on' : 'off'
  root.dataset.memberState = settings.showMemberState ? 'on' : 'off'
  root.dataset.groupChips = settings.showGroupChips ? 'on' : 'off'
  root.dataset.channelCounts = settings.showChannelCounts ? 'on' : 'off'
  root.dataset.contrast = settings.contrast ?? 'normal'
  root.style.setProperty('--accent', settings.accent)
  root.style.setProperty('--radius-card', `${settings.radius}px`)
  root.style.setProperty('--panel-blur', `${settings.blur}px`)
  root.style.setProperty('--chat-font', `${settings.chatFontSize ?? 13}px`)
  root.style.setProperty('--sidebar-w', `${settings.sidebarWidth ?? 268}px`)
  // 纯色面板不透明度：100% 完全不透明，默认 80% 保持轻微透出背景
  const panelOpacity = Math.min(100, Math.max(30, settings.panelOpacity ?? 80))
  root.style.setProperty('--opacity-k', (panelOpacity / 80).toFixed(3))

  const preset = backgroundPresets[settings.background] ?? backgroundPresets.mist
  const image = safeImage(settings.backgroundImage)
  if (image) {
    const dim = Math.min(90, Math.max(0, settings.backgroundDim)) / 100
    const alpha = (dark ? 0.4 : 0.36) + dim * 0.48
    const overlay = dark
      ? `linear-gradient(rgba(9,13,21,${alpha}), rgba(9,13,21,${Math.min(0.96, alpha + 0.08)}))`
      : `linear-gradient(rgba(240,245,255,${alpha}), rgba(236,242,252,${Math.min(0.96, alpha + 0.08)}))`
    root.style.setProperty('--app-bg', `${overlay}, url(${JSON.stringify(image)})`)
  } else {
    root.style.setProperty('--app-bg', dark ? preset.dark : preset.light)
  }
}

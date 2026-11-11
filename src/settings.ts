import type {
  BackgroundId,
  CardStyle,
  Density,
  LayoutId,
  ThemeMode,
} from './types'

export interface Settings {
  nickname: string
  description: string
  theme: ThemeMode
  accent: string
  density: Density
  radius: number
  blur: number
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
  outputDevice: string
  inputVolume: number
  outputVolume: number
  inputMode: 'vad' | 'ptt'
  vadThreshold: number
  echoCancel: boolean
  noiseSuppress: boolean
  autoGain: boolean
  musicMode: boolean
  bitrate: number
  frameSize: number
  stereo: boolean
  jitterBuffer: number
  latencyMode: 'low' | 'balanced' | 'stable'
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
  blur: 18,
  background: 'mist',
  backgroundImage: '',
  backgroundDim: 40,
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
  outputDevice: '',
  inputVolume: 78,
  outputVolume: 82,
  inputMode: 'vad',
  vadThreshold: -38,
  echoCancel: true,
  noiseSuppress: true,
  autoGain: false,
  musicMode: false,
  bitrate: 64,
  frameSize: 20,
  stereo: false,
  jitterBuffer: 60,
  latencyMode: 'balanced',
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
  blocked: [],
  fileTransfer: true,
  autoReconnect: true,
  timeout: 15,
  demoEvents: false,
}

const STORAGE_KEY = 'rayspeak.settings.v2'

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...defaultSettings }
    const parsed = JSON.parse(raw) as Partial<Settings>
    const legacyDevice = (value: unknown) =>
      typeof value === 'string' && value.includes('(') && value.includes(')') ? '' : value
    return {
      ...defaultSettings,
      ...parsed,
      inputDevice: (legacyDevice(parsed.inputDevice) as string) ?? defaultSettings.inputDevice,
      outputDevice:
        (legacyDevice(parsed.outputDevice) as string) ?? defaultSettings.outputDevice,
      hotkeys: { ...defaultSettings.hotkeys, ...(parsed.hotkeys ?? {}) },
      blocked: Array.isArray(parsed.blocked) ? parsed.blocked : [],
    }
  } catch {
    return { ...defaultSettings }
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
  root.style.setProperty('--accent', settings.accent)
  root.style.setProperty('--radius-card', `${settings.radius}px`)
  root.style.setProperty('--panel-blur', `${settings.blur}px`)

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

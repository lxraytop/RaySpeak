import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  ArrowRightLeft,
  Ban,
  Check,
  ChevronDown,
  Columns2,
  Copy,
  Headphones,
  ImagePlus,
  Info,
  LayoutGrid,
  Link2,
  Lock,
  LogOut,
  MessageSquare,
  Mic,
  MicOff,
  Moon,
  MonitorUp,
  RefreshCw,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserMinus,
  UserRound,
  UserRoundPlus,
  Volume2,
  VolumeX,
} from 'lucide-react'
import {
  channels as channelSeed,
  clientsSeed,
  dmSeed,
  filesSeed,
  groupMap,
  messagesSeed,
  systemSeed,
} from './data/mock'
import type {
  ChatMessage,
  Client,
  DmMessage,
  FileItem,
  LayoutId,
  Presence,
  SystemLine,
  VoiceChannel,
} from './types'
import {
  applySettings,
  defaultSettings,
  isDark,
  loadSettings,
  saveSettings,
  type Settings,
} from './settings'
import { renderTsText, stripTsTags } from './utils/tsText'
import { parseRayLink, rayInviteLink } from './components/MessageText'
import { channelIconUrl, groupIconUrl, registerChannelIcon, registerGroupIcon } from './utils/icons'
import {
  errorText,
  isTauri,
  listenEvent,
  openLocalFile,
  pickSavePath,
  protocol,
  type ClientDetailsDto,
  type MessageEvent,
  type PokeEvent,
  type SnapshotDto,
  type VoiceEvent,
} from './protocol'
import { registerLiveGroups, toChannels, toClients, toFiles } from './utils/live'
import {
  cacheAvatar,
  dropCachedAvatar,
  getCachedAvatar,
  getContact,
  rememberClients,
} from './utils/localStore'
import { useVoice } from './useVoice'
import { playJoinLeaveTone, playNotifyTone, showDesktopNotification } from './notify'
import { LoginScreen } from './components/LoginScreen'
import { ContextMenu, type ContextItem } from './components/ContextMenu'
import { TitleBar } from './components/TitleBar'
import { ServerRail } from './components/ServerRail'
import { ChannelSidebar } from './components/ChannelSidebar'
import { MemberGrid, MemberPanel } from './components/MemberGrid'
import { ChatPanel } from './components/ChatPanel'
import { VoiceBar } from './components/VoiceBar'
import { ChannelEventsModal, InviteModal, PasswordModal } from './components/Modals'
import { ProfileModal } from './components/ProfileModal'
import { ContactsPage } from './components/ContactsPage'
import {
  ChannelDraft,
  ConfirmModal,
  CreateChannelModal,
  FilePanelModal,
  MoveClientModal,
  RoomSettingsModal,
  ScreenShareModal,
} from './components/CapabilityModals'
import { SettingsPage, type SettingsSection } from './components/SettingsPage'

const VOLUME_KEY = 'rayspeak.volumes.v1'
const NICKNAME_KEY = 'rayspeak.nickname'
const params = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const demoMode =
  params.get('login') === '1' ? false : !isTauri || params.get('demo') === '1'
const sections: SettingsSection[] = [
  'account',
  'audio',
  'appearance',
  'hotkeys',
  'notify',
  'privacy',
  'advanced',
  'about',
]
const initialSection = sections.includes(params.get('section') as SettingsSection)
  ? (params.get('section') as SettingsSection)
  : 'account'
const initialChannel = channelSeed.some((channel) => channel.id === params.get('channel'))
  ? (params.get('channel') as string)
  : 'hall'
const initialProfile = clientsSeed.some((client) => client.id === params.get('profile'))
  ? params.get('profile')
  : null
const initialDm = clientsSeed.some(
  (client) => client.id === params.get('dm') && !client.self,
)
  ? (params.get('dm') as string)
  : 'asara'
const initialPage: 'voice' | 'contacts' | 'settings' =
  params.get('screen') === 'settings'
    ? 'settings'
    : params.get('screen') === 'contacts' || params.get('dm')
      ? 'contacts'
      : 'voice'
const rawModal = params.get('modal')
const initialModal =
  rawModal === 'invite' ||
  rawModal === 'queue' ||
  rawModal === 'create' ||
  rawModal === 'files' ||
  rawModal === 'screen' ||
  rawModal === 'room'
    ? rawModal
    : null

type VolumeState = Record<string, { volume: number; localMuted: boolean }>
type ModalState = 'invite' | 'queue' | 'create' | 'files' | 'screen' | 'room' | null
type SelfPresence = 'online' | 'away' | 'busy'
type ConfirmState =
  | { kind: 'kick' | 'ban'; client: Client }
  | { kind: 'delete-channel'; channel: VoiceChannel }
  | null

const presenceOptions: Array<{ id: SelfPresence; label: string; hint: string }> = [
  { id: 'online', label: '在线', hint: '正常接收语音、私聊与提醒' },
  { id: 'away', label: '离开', hint: '状态同步为离开，仍会收到提醒' },
  { id: 'busy', label: '勿扰', hint: '静音所有提醒，状态显示为勿扰' },
]

const presenceLabel: Record<SelfPresence, string> = {
  online: '在线',
  away: '离开',
  busy: '勿扰',
}

const EMPTY_CHANNEL: VoiceChannel = {
  id: '',
  parentId: null,
  section: 'public',
  name: '频道',
  kind: 'voice',
  order: 0,
  codec: 'Opus',
  bitrate: 64,
}

function loadVolumes(): VolumeState {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as VolumeState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function powerOf(client: Client) {
  return Math.max(0, ...client.serverGroups.map((id) => groupMap.get(id)?.power ?? 0))
}

function clock() {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

function seenLabel(timestamp: number) {
  const delta = Date.now() - timestamp
  if (delta < 60_000) return '刚刚在线'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前在线`
  const date = new Date(timestamp)
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = date.toDateString() === new Date().toDateString()
  return sameDay ? `今天 ${time} 在线` : `${date.getMonth() + 1}-${date.getDate()} ${time} 在线`
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => {
    const base = loadSettings()
    const layout = params.get('layout')
    const theme = params.get('theme')
    return {
      ...base,
      layout: layout === 'grid' || layout === 'cards' ? layout : base.layout,
      theme:
        theme === 'dark' || theme === 'light' || theme === 'system' ? theme : base.theme,
    }
  })
  const [page, setPage] = useState<'voice' | 'contacts' | 'settings'>(initialPage)
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSection)
  const [settingsReturn, setSettingsReturn] = useState<'voice' | 'contacts'>('voice')

  const [channels, setChannels] = useState<VoiceChannel[]>(channelSeed)
  const [clients, setClients] = useState<Client[]>(() => {
    const stored = loadVolumes()
    return clientsSeed.map((client) => {
      const saved = stored[client.id]
      return saved ? { ...client, volume: saved.volume, localMuted: saved.localMuted } : client
    })
  })
  const [messages, setMessages] = useState<ChatMessage[]>(messagesSeed)
  const [system, setSystem] = useState<SystemLine[]>(systemSeed)
  const [dmMessages, setDmMessages] = useState<DmMessage[]>(dmSeed)
  const [files, setFiles] = useState<FileItem[]>(filesSeed)

  const [activeId, setActiveId] = useState(initialChannel)
  const [activeDmId, setActiveDmId] = useState<string | null>(initialDm)
  const [profileId, setProfileId] = useState<string | null>(initialProfile)
  const [modal, setModal] = useState<ModalState>(initialModal)
  const [inviteTarget, setInviteTarget] = useState<Client | null>(null)
  const [moveTarget, setMoveTarget] = useState<Client | null>(null)
  const [confirm, setConfirm] = useState<ConfirmState>(null)
  const [passwordChannel, setPasswordChannel] = useState<VoiceChannel | null>(null)

  const [auth, setAuth] = useState<'login' | 'connecting' | 'ready'>(
    demoMode ? 'ready' : 'login',
  )
  const [authError, setAuthError] = useState<string | null>(null)
  const [permissions, setPermissions] = useState<string[]>([])
  const [connected, setConnected] = useState(demoMode)
  const [latency, setLatency] = useState(32)
  const [serverInfo, setServerInfo] = useState({
    name: demoMode ? 'RaySpeak 社区' : '',
    maxClients: 0,
    onlineClients: 0,
    iconId: 0,
  })
  const [serverIcon, setServerIcon] = useState('')
  const serverIconRequested = useRef(0)
  const serverInfoBlocked = useRef(false)
  const [muted, setMuted] = useState(false)
  const [deafened, setDeafened] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [shareMock, setShareMock] = useState(false)
  const [shareStream, setShareStream] = useState<MediaStream | null>(null)
  const [presenceMenu, setPresenceMenu] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    target:
      | { kind: 'channel'; channel: VoiceChannel }
      | { kind: 'client'; client: Client }
      | { kind: 'message'; text: string }
      | { kind: 'app' }
  } | null>(null)

  const [loginName, setLoginName] = useState(() => {
    try {
      return localStorage.getItem(NICKNAME_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [unread, setUnread] = useState<Record<string, number>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [pttHeld, setPttHeld] = useState(false)
  const connectedRef = useRef(connected)
  connectedRef.current = connected
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId
  const pageRef = useRef(page)
  pageRef.current = page
  const activeDmRef = useRef(activeDmId)
  activeDmRef.current = activeDmId
  const manualLeave = useRef(false)
  const kickedRef = useRef(false)
  const selfUidRef = useRef('')
  const iconRequests = useRef(new Set<string>())
  const avatarRequests = useRef(new Set<string>())
  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [, setIconTick] = useState(0)
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const clientsRef = useRef(clients)
  clientsRef.current = clients
  const channelsRef = useRef(channels)
  channelsRef.current = channels
  const sessionCreds = useRef<{ nickname: string; password: string } | null>(null)
  const audioErrorShown = useRef(false)
  const deepLinkRef = useRef<string | null>(null)
  const clientDetailsRef = useRef<Record<number, ClientDetailsDto>>({})
  const detailsRequested = useRef<Set<number>>(new Set())
  const pendingSentRef = useRef<
    Array<{ kind: 'channel' | 'dm'; target: string; text: string; at: number; id: string }>
  >([])
  const savedVolumesRef = useRef<VolumeState>(loadVolumes())
  const joinToneAt = useRef(0)
  const [deviceLabels, setDeviceLabels] = useState<Record<string, string>>({})

  useEffect(() => {
    applySettings(settings)
    saveSettings(settings)
  }, [settings])

  useEffect(() => {
    if (settings.theme !== 'system') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applySettings(settings)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [settings])

  useEffect(() => {
    const map: VolumeState = {}
    for (const client of clients) {
      if (!client.self) map[client.id] = { volume: client.volume, localMuted: client.localMuted }
    }
    savedVolumesRef.current = map
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify(map))
    } catch {
      /* storage unavailable */
    }
  }, [clients])

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const update = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        const labels: Record<string, string> = {}
        for (const device of list) {
          if (device.deviceId) labels[device.deviceId] = device.label
        }
        setDeviceLabels(labels)
      } catch {
        /* enumeration unavailable */
      }
    }
    void update()
    navigator.mediaDevices.addEventListener?.('devicechange', update)
    return () => navigator.mediaDevices.removeEventListener?.('devicechange', update)
  }, [])

  useEffect(() => {
    if (!connected) return
    if (!demoMode) {
      let alive = true
      serverInfoBlocked.current = false
      const poll = () => {
        protocol
          .getStats()
          .then((stats) => {
            if (alive) setLatency(Math.max(0, Math.round(stats.ping)))
          })
          .catch(() => {})
        if (serverInfoBlocked.current) return
        protocol
          .getServerInfo()
          .then((info) => {
            if (alive) {
              setServerInfo({
                name: info.name,
                maxClients: info.maxClients,
                onlineClients: info.onlineClients,
                iconId: info.iconId ?? 0,
              })
            }
          })
          .catch(() => {
            serverInfoBlocked.current = true
          })
      }
      poll()
      const timer = window.setInterval(poll, 6000)
      return () => {
        alive = false
        window.clearInterval(timer)
      }
    }
    const timer = window.setInterval(() => setLatency(28 + Math.floor(Math.random() * 9)), 2600)
    return () => window.clearInterval(timer)
  }, [connected])

  useEffect(() => {
    if (demoMode || !settings.fileTransfer || !serverInfo.iconId) return
    if (serverIconRequested.current === serverInfo.iconId) return
    serverIconRequested.current = serverInfo.iconId
    protocol
      .fetchChannelIcon(serverInfo.iconId)
      .then(setServerIcon)
      .catch(() => {
        serverIconRequested.current = 0
      })
  }, [demoMode, settings.fileTransfer, serverInfo.iconId])

  useEffect(() => {
    if (demoMode || !connected) return
    for (const client of clients) {
      const uid = client.uid || client.id
      const hash = client.avatarHash
      if (!uid || !hash || client.avatarUrl) continue
      const key = `${uid}:${hash}`
      const cached = getCachedAvatar(uid, hash)
      if (cached) {
        if (avatarRequests.current.has(key)) continue
        avatarRequests.current.add(key)
        setClients((prev) =>
          prev.map((item) =>
            item.id === client.id && item.avatarHash === hash
              ? { ...item, avatarUrl: cached }
              : item,
          ),
        )
        continue
      }
      if (avatarRequests.current.has(key)) continue
      avatarRequests.current.add(key)
      protocol
        .fetchClientAvatar(uid, hash)
        .then((url) => {
          cacheAvatar(uid, hash, url)
          setClients((prev) =>
            prev.map((item) =>
              item.id === client.id && item.avatarHash === hash
                ? { ...item, avatarUrl: url }
                : item,
            ),
          )
        })
        .catch(() => {})
    }
  }, [clients, connected, demoMode])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 2100)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!demoMode) return
    if (!connected) {
      setClients((prev) =>
        prev.some((client) => client.talking)
          ? prev.map((client) => (client.talking ? { ...client, talking: false } : client))
          : prev,
      )
      return
    }
    let decay: number | undefined
    const timer = window.setInterval(() => {
      const candidates = clientsRef.current.filter(
        (client) => !client.self && !client.micMuted && client.presence === 'online',
      )
      if (candidates.length === 0) return
      const target = candidates[Math.floor(Math.random() * candidates.length)]
      setClients((prev) =>
        prev.map((client) => {
          if (client.id === target.id) return { ...client, talking: true }
          if (client.talking && Math.random() > 0.72) return { ...client, talking: false }
          return client
        }),
      )
      window.clearTimeout(decay)
      decay = window.setTimeout(() => {
        setClients((prev) =>
          prev.map((client) =>
            client.id === target.id ? { ...client, talking: false } : client,
          ),
        )
      }, 1900)
    }, 2700)
    return () => {
      window.clearInterval(timer)
      window.clearTimeout(decay)
    }
  }, [connected])

  useEffect(() => {
    if (!demoMode || !settings.demoEvents) return
    const voiceChannels = channels.filter((channel) => channel.kind === 'voice')
    const timer = window.setInterval(() => {
      const movers = clientsRef.current.filter((client) => !client.self)
      if (movers.length === 0) return
      const mover = movers[Math.floor(Math.random() * movers.length)]
      const dest = voiceChannels[Math.floor(Math.random() * voiceChannels.length)]
      if (!dest || mover.channelId === dest.id) return
      setClients((prev) =>
        prev.map((client) =>
          client.id === mover.id ? { ...client, channelId: dest.id, connectedAt: '刚刚' } : client,
        ),
      )
      if (settingsRef.current.joinLeaveSound && !settingsRef.current.dnd) {
        playJoinLeaveTone('join')
      }
    }, 7000)
    return () => window.clearInterval(timer)
  }, [settings.demoEvents, channels])

  const notify = useCallback((message: string) => setToast(message), [])

  const updateSettings = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => ({ ...prev, ...patch }))
  }, [])

  const applyClientDetails = useCallback((clid: number, payload: ClientDetailsDto) => {
    setClients((prev) =>
      prev.map((item) =>
        item.clid === clid
          ? {
              ...item,
              description: payload.description ?? item.description,
              avatarHash: payload.avatarHash ?? item.avatarHash,
              avatarUrl:
                (payload.avatarHash ?? item.avatarHash) === item.avatarHash
                  ? item.avatarUrl
                  : undefined,
              platform: payload.platform ?? item.platform,
              version: payload.version ?? item.version,
              dbId: payload.databaseId ?? item.dbId,
              uid: payload.uid ?? item.uid,
              device: /mobile|android|ios|iphone|ipad/i.test(payload.platform ?? '')
                ? 'mobile'
                : item.device,
              channelGroups: payload.channelGroupId
                ? [payload.channelGroupId]
                : item.channelGroups,
            }
          : item,
      ),
    )
  }, [])

  const applySnapshot = useCallback((snapshot: SnapshotDto, focusSelf = false) => {
    registerLiveGroups(snapshot.groups)
    const nextChannels = toChannels(snapshot)
    const config = settingsRef.current
    if (!focusSelf && clientsRef.current.length > 0) {
      const previous = new Map(
        clientsRef.current
          .filter((client) => typeof client.clid === 'number')
          .map((client) => [client.clid as number, client]),
      )
      const incoming = new Map(snapshot.clients.map((client) => [client.clid, client]))
      const channelName = (id: string) =>
        stripTsTags(nextChannels.find((channel) => channel.id === id)?.name ?? '') ||
        '频道'
      let joins = 0
      let leaves = 0
      const lines: string[] = []
      for (const client of snapshot.clients) {
        const name = client.isSelf ? '你' : stripTsTags(client.name) || '成员'
        const old = previous.get(client.clid)
        if (!old) {
          if (client.isSelf) continue
          joins += 1
          lines.push(`${name} 加入了服务器`)
        } else if (old.channelId !== client.channelId) {
          joins += 1
          lines.push(
            client.isSelf
              ? `你加入了「${channelName(client.channelId)}」`
              : `${name} 加入了「${channelName(client.channelId)}」`,
          )
        }
      }
      for (const old of clientsRef.current) {
        if (typeof old.clid !== 'number') continue
        if (!incoming.has(old.clid)) {
          leaves += 1
          lines.push(old.self ? '你已离开服务器' : `${stripTsTags(old.name) || '成员'} 离开了服务器`)
        }
      }
      if (lines.length > 0 && config.notifyJoinLeave) {
        setSystem((prev) => [
          ...prev,
          ...lines.map((text) => ({
            id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channelId: activeIdRef.current,
            text,
          })),
        ])
      }
      if (config.joinLeaveSound && !config.dnd && joins + leaves > 0) {
        // 大频道连续进出时最多每 900ms 响一次，避免提示音连成一片
        const now = Date.now()
        if (now - joinToneAt.current > 900) {
          joinToneAt.current = now
          playJoinLeaveTone(leaves > joins ? 'leave' : 'join')
        }
      }
    }
    setChannels(nextChannels)
    const nextClients = toClients(snapshot, clientsRef.current, savedVolumesRef.current)
    setClients(nextClients)
    rememberClients(nextClients)
    const present = new Set(snapshot.clients.map((client) => client.clid))
    for (const clid of Array.from(detailsRequested.current)) {
      if (!present.has(clid)) {
        detailsRequested.current.delete(clid)
        delete clientDetailsRef.current[clid]
      }
    }
    for (const client of snapshot.clients) {
      if (client.isSelf || !client.clid || detailsRequested.current.has(client.clid)) continue
      detailsRequested.current.add(client.clid)
      protocol
        .getClientDetails(client.clid)
        .then((payload) => {
          clientDetailsRef.current[client.clid] = payload
          applyClientDetails(client.clid, payload)
        })
        .catch(() => {})
    }
    const self = snapshot.clients.find((client) => client.isSelf)
    selfUidRef.current = self?.id ?? ''
    if (focusSelf && self) {
      setActiveId(self.channelId)
    }
    const knownChannel = nextChannels.some((channel) => channel.id === activeIdRef.current)
    if (!knownChannel && nextChannels.length > 0) {
      const target = nextChannels.find((channel) => channel.id === self?.channelId)
      setActiveId(target?.id ?? nextChannels[0].id)
    }
    for (const channel of nextChannels) {
      if (!settingsRef.current.fileTransfer) break
      if (!channel.iconId || channelIconUrl(channel.iconId)) continue
      if (iconRequests.current.has(channel.iconId)) continue
      iconRequests.current.add(channel.iconId)
      const iconKey = channel.iconId
      protocol
        .fetchChannelIcon(Number(iconKey))
        .then((url) => {
          registerChannelIcon(iconKey, url)
          setIconTick((value) => value + 1)
        })
        .catch(() => {})
    }
    for (const group of snapshot.groups) {
      if (!settingsRef.current.fileTransfer) break
      if (!group.iconId || group.iconId < 1000 || groupIconUrl(group.id)) continue
      const iconKey = `g:${group.id}`
      if (iconRequests.current.has(iconKey)) continue
      iconRequests.current.add(iconKey)
      protocol
        .fetchChannelIcon(group.iconId)
        .then((url) => {
          registerGroupIcon(group.id, url)
          setIconTick((value) => value + 1)
        })
        .catch(() => {})
    }
  }, [applyClientDetails])

  const connectToServer = useCallback(
    async (nickname: string, password: string, retries = 0) => {
      sessionCreds.current = { nickname, password }
      const attempt = async (remaining: number): Promise<void> => {
        setLoginName(nickname)
        setAuth('connecting')
        setAuthError(
          remaining > 0 ? `正在重新连接服务器（剩余 ${remaining} 次）…` : null,
        )
        try {
          const result = await protocol.connect(
            nickname,
            password,
            settingsRef.current.timeout,
          )
          try {
            localStorage.setItem(NICKNAME_KEY, nickname)
          } catch {
            /* storage unavailable */
          }
          setSettings((prev) => ({ ...prev, nickname }))
          manualLeave.current = false
          kickedRef.current = false
          audioErrorShown.current = false
          detailsRequested.current.clear()
          clientDetailsRef.current = {}
          pendingSentRef.current = []
          avatarRequests.current.clear()
          applySnapshot(result.snapshot, true)
          const self = result.snapshot.clients.find((client) => client.isSelf)
          selfUidRef.current = self?.id ?? ''
          let storedDm: DmMessage[] = []
          if (self?.id) {
            try {
              const raw = localStorage.getItem(`rayspeak.dm.v1:${self.id}`)
              const parsed = raw ? JSON.parse(raw) : null
              if (Array.isArray(parsed)) storedDm = parsed as DmMessage[]
            } catch {
              storedDm = []
            }
          }
          setDmMessages(storedDm)
          setUnread({})
          setMessages([])
          setSystem([])
          setFiles([])
          setActiveDmId(
            result.snapshot.clients.find((client) => !client.isSelf)?.id ?? null,
          )
          setConnected(true)
          setPage('voice')
          setAuth('ready')
          const selfChannel = toChannels(result.snapshot).find(
            (channel) => channel.id === self?.channelId,
          )
          const spacer = /^\[(c|r|l|\*)?spacer\d*\]/i.test(selfChannel?.name ?? '')
          const target = toChannels(result.snapshot).find(
            (channel) => channel.kind === 'voice' && !channel.password,
          )
          const inviteUrl = deepLinkRef.current
          const invite = inviteUrl ? parseRayLink(inviteUrl) : null
          if (invite) {
            deepLinkRef.current = null
            const invited = toChannels(result.snapshot).find(
              (channel) => channel.id === invite.channelId,
            )
            if (!invited) {
              notify('邀请的频道不存在或已被删除')
            } else if (invited.password) {
              setPasswordChannel(invited)
              setActiveId(invited.id)
            } else {
              setActiveId(invited.id)
              void protocol
                .joinChannel(invited.id)
                .then(() => notify(`已加入邀请频道「${stripTsTags(invited.name)}」`))
                .catch((error) => notify(errorText(error)))
            }
          } else if (spacer && target) {
            setActiveId(target.id)
            void protocol
              .joinChannel(target.id)
              .catch(() => setActiveId(selfChannel?.id ?? target.id))
          }
          protocol
            .getMyPermissions()
            .then(setPermissions)
            .catch(() => setPermissions([]))
          if (self?.clid) {
            protocol
              .getClientDetails(self.clid)
              .then((payload) => {
                clientDetailsRef.current[self.clid] = payload
                applyClientDetails(self.clid, payload)
                // 服务器上的个人简介是权威值：连上后即回填，避免本地默认文案覆盖服务器内容
                setSettings((prev) => ({ ...prev, description: payload.description ?? '' }))
              })
              .catch(() => {})
          }
        } catch (error) {
          setConnected(false)
          setClients([])
          if (remaining > 0 && settingsRef.current.autoReconnect) {
            await new Promise((resolve) => window.setTimeout(resolve, 1800))
            if (manualLeave.current) return
            return attempt(remaining - 1)
          }
          setAuth('login')
          setAuthError(errorText(error))
        }
      }
      await attempt(retries)
    },
    [applySnapshot],
  )

  const leaveServer = useCallback(async () => {
    manualLeave.current = true
    sessionCreds.current = null
    try {
      await protocol.disconnect()
    } catch {
      /* already gone */
    }
    setAuth('login')
    setConnected(false)
    setAuthError(null)
    setClients([])
    setMessages([])
    setDmMessages([])
    setSystem([])
    setFiles([])
    setPermissions([])
    setProfileId(null)
    setActiveDmId(null)
    setUnread({})
    setMuted(false)
    setDeafened(false)
    setPttHeld(false)
    setServerInfo({ name: '', maxClients: 0, onlineClients: 0, iconId: 0 })
    setServerIcon('')
    serverIconRequested.current = 0
    avatarRequests.current.clear()
  }, [])

  useEffect(() => {
    if (demoMode) return
    let disposed = false
    const unlisteners: Array<() => void> = []

    const notifyForeign = (title: string, text: string) => {
      const config = settingsRef.current
      if (config.dnd) return
      if (config.notifySound) playNotifyTone(config.notifyTone)
      if (config.desktopNotify && (document.hidden || pageRef.current !== 'contacts')) {
        void showDesktopNotification(title, text.slice(0, 160))
      }
    }

    const onMessage = (event: MessageEvent) => {
      const selfUid = selfUidRef.current
      const mine =
        (Boolean(selfUid) && event.invokerUid === selfUid) ||
        clientsRef.current.some(
          (client) => client.self && client.clid === event.invokerClid,
        )
      const config = settingsRef.current
      if (!mine && config.blocked.includes(event.invokerUid)) return
      const author = stripTsTags(event.invokerName) || '未知用户'
      const hue = Math.abs(
        Array.from(event.invokerUid).reduce((acc, char) => acc * 31 + char.charCodeAt(0), 0),
      ) % 360
      const avatarUrl = mine
        ? clientsRef.current.find((client) => client.self)?.avatarUrl
        : clientsRef.current.find(
            (client) => client.uid === event.invokerUid || client.id === event.invokerUid,
          )?.avatarUrl
      if (event.targetMode === 1) {
        if (!mine && !config.allowDm) return
        if (mine) {
          const pending = pendingSentRef.current
          const index = pending.findIndex(
            (item) =>
              item.kind === 'dm' && item.text === event.message && Date.now() - item.at < 10000,
          )
          if (index >= 0) {
            pending.splice(index, 1)
            return
          }
        }
        const target = clientsRef.current.find(
          (client) => client.clid === Number(event.targetId),
        )
        const contactId = mine ? (target?.id ?? `clid-${event.targetId}`) : event.invokerUid
        setDmMessages((prev) => [
          ...prev,
          {
            id: `dm-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            contactId,
            author: mine ? config.nickname || '我' : author,
            letter: (mine ? config.nickname || '我' : author).slice(0, 1),
            hue: mine ? 214 : hue,
            avatarUrl,
            time: clock(),
            text: event.message,
            self: mine,
          },
        ])
        if (!mine) {
          if (activeDmRef.current !== contactId || pageRef.current !== 'contacts') {
            setUnread((prev) => ({
              ...prev,
              [contactId]: (prev[contactId] ?? 0) + 1,
            }))
          }
          notifyForeign(author, event.message)
        }
        return
      }
      if (event.targetMode === 3) {
        setSystem((prev) => [
          ...prev,
          {
            id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`,
            channelId: activeIdRef.current,
            text: `[服务器] ${author}：${event.message}`,
          },
        ])
        return
      }
      if (mine) {
        const pending = pendingSentRef.current
        const index = pending.findIndex(
          (item) =>
            item.kind === 'channel' &&
            item.text === event.message &&
            Date.now() - item.at < 10000,
        )
        if (index >= 0) {
          pending.splice(index, 1)
          return
        }
      }
      const channelId = channelsRef.current.some(
        (channel) => channel.id === event.targetId,
      )
        ? event.targetId
        : clientsRef.current.find((client) => client.clid === event.invokerClid)
            ?.channelId ?? activeIdRef.current
      setMessages((prev) => [
        ...prev,
        {
          id: `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          channelId,
          clientId: event.invokerUid,
          author,
          letter: author.slice(0, 1),
          hue,
          avatarUrl,
          time: clock(),
          text: event.message,
          self: mine,
        },
      ])
      if (!mine) {
        const nickname = config.nickname
        const mention =
          event.message.includes(`@${nickname}`) ||
          event.message.toLowerCase().includes('@all')
        if (mention) {
          notifyForeign(`${author} 在频道中提到了你`, event.message)
        } else if (!config.mentionOnly && !config.dnd && config.desktopNotify) {
          if (document.hidden || pageRef.current !== 'voice') {
            void showDesktopNotification(`${author} 在频道发言`, event.message.slice(0, 160))
          }
        }
      }
    }

    const onPoke = (event: PokeEvent) => {
      const config = settingsRef.current
      if (config.blocked.includes(event.invokerUid) || !config.allowDm) return
      const author = stripTsTags(event.invokerName) || '未知用户'
      setDmMessages((prev) => [
        ...prev,
        {
          id: `poke-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          contactId: event.invokerUid,
          author: '',
          letter: '',
          hue: 0,
          time: clock(),
          text: `${author} 戳了戳你${event.message ? `：${event.message}` : ''}`,
          system: true,
        },
      ])
      if (!config.dnd) setToast(`${author} 戳了戳你`)
      notifyForeign(`${author} 戳了戳你`, event.message || '有人戳了戳你')
    }

    const onKicked = (event: { reason: string }) => {
      kickedRef.current = true
      sessionCreds.current = null
      setConnected(false)
      setAuth('login')
      setClients([])
      setAuthError(`你已被移出服务器：${event.reason || '未提供原因'}`)
    }

    const onDisconnected = (event: { error: string | null }) => {
      if (manualLeave.current) {
        manualLeave.current = false
        return
      }
      if (kickedRef.current) {
        kickedRef.current = false
        return
      }
      if (!connectedRef.current) return
      setConnected(false)
      setClients([])
      const config = settingsRef.current
      const creds = sessionCreds.current
      if (config.autoReconnect && creds) {
        setAuthError('与服务器的连接已断开，正在自动重连…')
        void connectToServer(creds.nickname, creds.password, 3)
        return
      }
      setAuth('login')
      setAuthError(event.error ?? '与服务器的连接已断开')
    }

    const onPermissions = () => {
      protocol
        .getMyPermissions()
        .then(setPermissions)
        .catch(() => {})
    }

    void (async () => {
      const listeners = await Promise.all([
        listenEvent<SnapshotDto>('ts://snapshot', (snapshot) => applySnapshot(snapshot)),
        listenEvent<MessageEvent>('ts://message', onMessage),
        listenEvent<PokeEvent>('ts://poke', onPoke),
        listenEvent<{ reason: string }>('ts://kicked', onKicked),
        listenEvent<{ error: string | null }>('ts://disconnected', onDisconnected),
        listenEvent<unknown>('ts://permissions', onPermissions),
        listenEvent<VoiceEvent>('ts://voice', (event) => {
          window.dispatchEvent(new CustomEvent('rayspeak:voice', { detail: event }))
        }),
      ])
      if (disposed) listeners.forEach((off) => off())
      else unlisteners.push(...listeners)
    })()

    return () => {
      disposed = true
      unlisteners.forEach((off) => off())
    }
  }, [applySnapshot, connectToServer])

  const openProfile = useCallback((id: string) => {
    setProfileId(id)
    if (demoMode) return
    const client = clientsRef.current.find((item) => item.id === id)
    const clid = client?.clid
    if (!clid) return
    const cached = clientDetailsRef.current[clid]
    if (cached) applyClientDetails(clid, cached)
    protocol
      .getClientDetails(clid)
      .then((payload) => {
        clientDetailsRef.current[clid] = payload
        applyClientDetails(clid, payload)
      })
      .catch(() => {})
  }, [applyClientDetails])

  const selfRaw = clients.find((client) => client.self)
  const selfId = selfRaw?.id ?? 'me'

  const viewClients = useMemo(() => {
    const hydrate = (client: Client): Client => {
      const uid = client.uid || client.id
      return {
        ...client,
        avatarUrl: client.avatarUrl ?? getCachedAvatar(uid, client.avatarHash),
      }
    }
    const selfPresence: Presence = settings.dnd ? 'busy' : settings.presenceStatus
    const base = clients.map((client) =>
      client.self
        ? hydrate({
            ...client,
            name: settings.nickname || client.name,
            description: settings.description ?? client.description,
            micMuted: muted || client.micMuted,
            outputMuted: deafened || client.outputMuted,
            presence: settings.showPresence ? selfPresence : 'offline',
          })
        : hydrate(client),
    )
    if (demoMode) return base
    const known = new Set(base.map((client) => client.id))
    // 离线联系人来自本地私聊记录 + 联系人目录：头像与昵称都已持久化，
    // 因此重启后仍能看到是谁在什么时候聊过，并据此判断当前是否在线。
    const offline = new Map<string, Client>()
    for (const message of dmMessages) {
      if (message.self || message.system || !message.contactId) continue
      const id = message.contactId
      if (known.has(id) || offline.has(id)) continue
      const record = getContact(id)
      const name = record?.name || message.author || '离线用户'
      let hue = 0
      for (const char of id) hue = (hue * 31 + char.charCodeAt(0)) % 360
      offline.set(id, {
        id,
        name,
        letter: stripTsTags(name).slice(0, 1) || '?',
        hue,
        description: record?.description || '离线 · 历史会话',
        avatarHash: record?.avatarHash,
        avatarUrl: getCachedAvatar(id, record?.avatarHash),
        channelId: '',
        serverGroups: [],
        channelGroups: [],
        micMuted: true,
        outputMuted: true,
        talking: false,
        volume: 100,
        localMuted: false,
        presence: 'offline',
        device: 'desktop',
        awayMessage: undefined,
        connectedAt: record?.lastSeen ? seenLabel(record.lastSeen) : '历史会话',
        platform: undefined,
        version: undefined,
        uid: id,
        dbId: undefined,
      })
    }
    return [...base, ...offline.values()]
  }, [
    clients,
    demoMode,
    dmMessages,
    settings.nickname,
    settings.description,
    settings.showPresence,
    settings.dnd,
    settings.presenceStatus,
    muted,
    deafened,
  ])

  const visibleClients = useMemo(
    () => viewClients.filter((client) => client.self || !settings.blocked.includes(client.id)),
    [viewClients, settings.blocked],
  )

  const activeChannel = useMemo(
    () => channels.find((channel) => channel.id === activeId) ?? channels[0] ?? EMPTY_CHANNEL,
    [channels, activeId],
  )

  const members = useMemo(() => {
    const list = visibleClients.filter((client) => client.channelId === activeChannel.id)
    return list.sort(
      (a, b) => Number(Boolean(b.self)) - Number(Boolean(a.self)) || powerOf(b) - powerOf(a),
    )
  }, [visibleClients, activeChannel.id])

  const otherStats = useMemo(() => {
    const others = visibleClients.filter(
      (client) => client.channelId && client.channelId !== activeChannel.id,
    )
    return {
      people: others.length,
      channels: new Set(others.map((client) => client.channelId)).size,
    }
  }, [visibleClients, activeChannel.id])

  const selfClient = viewClients.find((client) => client.self)
  const profileClient = viewClients.find((client) => client.id === profileId) ?? null
  const activeDmClient =
    viewClients.find((client) => client.id === activeDmId && !client.self) ?? null
  const groupAdmin = (selfClient?.serverGroups ?? []).some((id) =>
    /admin|owner|管理员|服主|管理/i.test(groupMap.get(id)?.name ?? ''),
  )
  const canModerate = demoMode
    ? Boolean(selfClient?.serverGroups.some((id) => id === 'sg-admin' || id === 'sg-commander'))
    : groupAdmin ||
      permissions.some((name) =>
        [
          'i_client_kick_power',
          'i_client_ban_power',
          'i_client_move_power',
          'i_channel_create_modify_with_codec_opusvoice',
          'b_channel_create_permanent',
          'b_channel_create_child',
          'i_channel_delete_power',
          'b_channel_delete_flag_force',
        ].includes(name),
      )

  const channelMessages = useMemo(
    () =>
      messages
        .filter(
          (message) =>
            message.channelId === activeId && !settings.blocked.includes(message.clientId),
        )
        .map((message) => {
          if (message.avatarUrl) return message
          // 历史消息只存了 UID：渲染时按当前成员表补全头像，换头像或缓存命中都能生效
          const owner = viewClients.find((client) => client.id === message.clientId)
          return owner?.avatarUrl ? { ...message, avatarUrl: owner.avatarUrl } : message
        }),
    [messages, activeId, settings.blocked, viewClients],
  )

  const channelSystem = useMemo(
    () => system.filter((line) => line.channelId === activeId),
    [system, activeId],
  )

  const channelFiles = useMemo(
    () => files.filter((file) => file.channelId === activeId),
    [files, activeId],
  )

  const pushSystem = useCallback(
    (text: string, channelId = activeId) => {
      setSystem((prev) => [
        ...prev,
        { id: `sys-${Date.now()}-${Math.random().toString(16).slice(2)}`, channelId, text },
      ])
    },
    [activeId],
  )

  const pushDmSystem = useCallback((contactId: string, text: string) => {
    setDmMessages((prev) => [
      ...prev,
      {
        id: `dms-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        contactId,
        author: '',
        letter: '',
        hue: 0,
        time: clock(),
        text,
        system: true,
      },
    ])
  }, [])

  const openSettings = (section: SettingsSection = 'account') => {
    if (page !== 'settings') setSettingsReturn(page === 'contacts' ? 'contacts' : 'voice')
    setSettingsSection(section)
    setPage('settings')
  }

  const toggleMute = () => {
    const next = !muted
    setMuted(next)
    if (next) setDeafened(false)
    if (!demoMode) {
      protocol.setAudioState(next, next ? false : deafened).catch(() => {})
    }
  }

  const toggleDeafen = () => {
    const next = !deafened
    setDeafened(next)
    if (next) setMuted(true)
    if (!demoMode) {
      protocol.setAudioState(next ? true : muted, next).catch(() => {})
    }
  }

  const setLayout = (layout: LayoutId) => updateSettings({ layout })

  const sendMessage = (text: string) => {
    const channelId = activeIdRef.current
    const author = settings.nickname || '我'
    const id = `local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    const message: ChatMessage = {
      id,
      channelId,
      clientId: selfId,
      author,
      letter: author.slice(0, 1),
      hue: 214,
      avatarUrl: clientsRef.current.find((client) => client.self)?.avatarUrl,
      time: clock(),
      text,
      self: true,
    }
    setMessages((prev) => [...prev, message])
    pendingSentRef.current.push({
      kind: 'channel',
      target: channelId,
      text,
      at: Date.now(),
      id,
    })
    if (demoMode) return
    protocol.sendChannelMessage(channelId, text).catch((error) => {
      pendingSentRef.current = pendingSentRef.current.filter((item) => item.id !== id)
      setMessages((prev) => prev.filter((item) => item.id !== id))
      notify(errorText(error))
    })
  }

  const sendDm = (text: string) => {
    if (!activeDmId) return
    const contactId = activeDmId
    const target = activeDmClient
    const author = settings.nickname || '我'
    const id = `dm-local-${Date.now()}-${Math.random().toString(16).slice(2)}`
    setDmMessages((prev) => [
      ...prev,
      {
        id,
        contactId,
        author,
        letter: author.slice(0, 1),
        hue: 214,
        avatarUrl: clientsRef.current.find((client) => client.self)?.avatarUrl,
        time: clock(),
        text,
        self: true,
      },
    ])
    pendingSentRef.current.push({
      kind: 'dm',
      target: contactId,
      text,
      at: Date.now(),
      id,
    })
    if (demoMode) return
    if (!target?.clid) {
      pendingSentRef.current = pendingSentRef.current.filter((item) => item.id !== id)
      setDmMessages((prev) => prev.filter((item) => item.id !== id))
      notify('该成员当前不在线')
      return
    }
    protocol.sendPrivateMessage(target.clid, text).catch((error) => {
      pendingSentRef.current = pendingSentRef.current.filter((item) => item.id !== id)
      setDmMessages((prev) => prev.filter((item) => item.id !== id))
      notify(errorText(error))
    })
  }

  const selectDm = (id: string) => {
    setActiveDmId(id)
    setPage('contacts')
    setUnread((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }

  const openDm = (client: Client) => {
    if (client.self) {
      openSettings('audio')
      return
    }
    setProfileId(null)
    setActiveDmId(client.id)
    setPage('contacts')
    setUnread((prev) => {
      if (!prev[client.id]) return prev
      const next = { ...prev }
      delete next[client.id]
      return next
    })
  }

  const pokeClient = (client: Client) => {
    if (!demoMode) {
      if (!client.clid) {
        notify('该成员当前不在线')
        return
      }
      pushDmSystem(client.id, `你戳了戳 ${stripTsTags(client.name)}`)
      notify(`已戳了戳 ${stripTsTags(client.name)}`)
      protocol.pokeClient(client.clid, '戳了戳你').catch((error) => notify(errorText(error)))
      return
    }
    pushDmSystem(client.id, `你戳了戳 ${stripTsTags(client.name)}`)
    notify(`已戳了戳 ${stripTsTags(client.name)}`)
    window.setTimeout(() => {
      pushDmSystem(client.id, `${stripTsTags(client.name)} 戳了回来`)
    }, 1400)
  }

  const moveSelf = (channel: VoiceChannel) => {
    setClients((prev) =>
      prev.map((client) => (client.self ? { ...client, channelId: channel.id } : client)),
    )
    setActiveId(channel.id)
    if (settingsRef.current.joinLeaveSound && !settingsRef.current.dnd) {
      playJoinLeaveTone('join')
    }
    notify(`已加入「${stripTsTags(channel.name)}」`)
  }

  const joinChannel = (id: string, password?: string) => {
    const channel = channels.find((item) => item.id === id)
    if (!channel || channel.kind !== 'voice') return
    const alreadyHere = clients.some((client) => client.self && client.channelId === channel.id)
    if (alreadyHere) {
      setActiveId(channel.id)
      return
    }
    if (channel.password && password === undefined) {
      setPasswordChannel(channel)
      return
    }
    if (!demoMode) {
      setActiveId(channel.id)
      protocol
        .joinChannel(channel.id, password)
        .then(() => notify(`已加入「${stripTsTags(channel.name)}」`))
        .catch((error) => {
          notify(errorText(error))
          const self = clientsRef.current.find((client) => client.self)
          if (self) setActiveId(self.channelId)
        })
      return
    }
    moveSelf(channel)
  }

  const handleDeepLink = useCallback(
    (url: string) => {
      const parsed = parseRayLink(url)
      if (!parsed) {
        notify('无法识别的邀请链接')
        return
      }
      if (demoMode) {
        notify('演示模式无法处理邀请链接')
        return
      }
      if (!connectedRef.current) {
        deepLinkRef.current = url
        notify('已收到频道邀请，登录后将自动加入')
        return
      }
      const join = (channel: VoiceChannel) => {
        if (channel.kind !== 'voice') {
          notify('邀请链接指向的不是语音频道')
          return
        }
        setPage('voice')
        joinChannel(channel.id)
      }
      const channel = channelsRef.current.find((item) => item.id === parsed.channelId)
      if (channel) {
        join(channel)
        return
      }
      protocol
        .refreshDirectory()
        .then((snapshot) => {
          applySnapshot(snapshot)
          const found = toChannels(snapshot).find((item) => item.id === parsed.channelId)
          if (!found) {
            notify('邀请的频道不存在或已被删除')
            return
          }
          join(found)
        })
        .catch((error) => notify(errorText(error)))
    },
    [applySnapshot, demoMode, joinChannel, notify],
  )

  useEffect(() => {
    if (demoMode) return
    let disposed = false
    let off: (() => void) | undefined
    void listenEvent<string>('ts://deep-link', (url) => handleDeepLink(url)).then((unlisten) => {
      if (disposed) unlisten()
      else off = unlisten
    })
    return () => {
      disposed = true
      off?.()
    }
  }, [demoMode, handleDeepLink])

  useEffect(() => {
    const onLink = (event: Event) => {
      const url = (event as CustomEvent<string>).detail
      if (url) handleDeepLink(url)
    }
    window.addEventListener('rayspeak:deep-link', onLink)
    return () => window.removeEventListener('rayspeak:deep-link', onLink)
  }, [handleDeepLink])

  useEffect(() => {
    if (demoMode) return
    let disposed = false
    protocol
      .takeDeepLink()
      .then((url) => {
        if (url && !disposed) handleDeepLink(url)
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [demoMode, handleDeepLink])

  const changeVolume = (id: string, volume: number) =>
    setClients((prev) =>
      prev.map((client) => (client.id === id ? { ...client, volume } : client)),
    )

  const toggleLocalMute = (id: string) =>
    setClients((prev) =>
      prev.map((client) =>
        client.id === id
          ? { ...client, localMuted: !client.localMuted, talking: false }
          : client,
      ),
    )

  const inviteToChannel = (client: Client) => {
    const dest = channels.find((channel) => channel.id === activeId)
    setProfileId(null)
    if (!demoMode) {
      if (!client.clid || !dest) {
        notify('无法发送邀请')
        return
      }
      protocol
        .sendPrivateMessage(
          client.clid,
          `邀请你加入频道「${stripTsTags(dest.name)}」，在频道列表中点击即可加入。`,
        )
        .then(() => {
          pushDmSystem(client.id, `已发送服务器邀请：加入「${stripTsTags(dest.name)}」`)
          notify(`已向 ${stripTsTags(client.name)} 发送邀请`)
        })
        .catch((error) => notify(errorText(error)))
      return
    }
    setClients((prev) =>
      prev.map((item) => (item.id === client.id ? { ...item, channelId: activeId } : item)),
    )
    notify(
      dest
        ? `已邀请 ${stripTsTags(client.name)} 加入「${stripTsTags(dest.name)}」（演示）`
        : `已邀请 ${stripTsTags(client.name)}`,
    )
  }

  const openInvite = (client?: Client | null) => {
    setInviteTarget(client ?? null)
    setModal('invite')
  }

  const sendInvite = (message: string) => {
    const target = inviteTarget
    if (!target) return
    const name = stripTsTags(target.name)
    const close = () => {
      setModal(null)
      setInviteTarget(null)
    }
    if (!demoMode) {
      if (!target.clid) {
        notify('该成员当前不在线，无法发送私聊邀请')
        return
      }
      protocol
        .sendPrivateMessage(target.clid, message)
        .then(() => {
          pushDmSystem(target.id, `已发送频道邀请：${message}`)
          notify(`邀请已发送给 ${name}`)
          close()
        })
        .catch((error) => notify(errorText(error)))
      return
    }
    pushDmSystem(target.id, `已发送频道邀请：${message}`)
    notify(`邀请已发送给 ${name}`)
    close()
  }

  const pickAvatar = () => avatarInputRef.current?.click()

  const applyAvatarFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      notify('请选择图片文件')
      return
    }
    if (file.size > 10 * 1024 * 1024) {
      notify('图片不能超过 10 MB')
      return
    }
    try {
      const bitmap = await createImageBitmap(file)
      const size = 256
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法处理图片')
      const scale = Math.max(size / bitmap.width, size / bitmap.height)
      const width = Math.round(bitmap.width * scale)
      const height = Math.round(bitmap.height * scale)
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, size, size)
      context.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height)
      bitmap.close?.()
      const dataUrl = canvas.toDataURL('image/jpeg', 0.9)
      if (demoMode) {
        setClients((prev) =>
          prev.map((client) =>
            client.self ? { ...client, avatarHash: 'demo', avatarUrl: dataUrl } : client,
          ),
        )
        notify('头像已更新（演示）')
        return
      }
      const hash = await protocol.uploadAvatar(dataUrl.split(',')[1] ?? '')
      cacheAvatar(selfUidRef.current, hash, dataUrl)
      setClients((prev) =>
        prev.map((client) =>
          client.self ? { ...client, avatarHash: hash, avatarUrl: dataUrl } : client,
        ),
      )
      notify('头像已更新')
    } catch (error) {
      notify(errorText(error))
    }
  }

  const removeSelfAvatar = async () => {
    if (demoMode) {
      setClients((prev) =>
        prev.map((client) =>
          client.self ? { ...client, avatarHash: undefined, avatarUrl: undefined } : client,
        ),
      )
      notify('头像已删除（演示）')
      return
    }
    try {
      await protocol.deleteAvatar()
      dropCachedAvatar(selfUidRef.current)
      setClients((prev) =>
        prev.map((client) =>
          client.self ? { ...client, avatarHash: undefined, avatarUrl: undefined } : client,
        ),
      )
      notify('头像已删除')
    } catch (error) {
      notify(errorText(error))
    }
  }

  const blockClient = (client: Client) => {
    updateSettings({ blocked: [...settings.blocked, client.id] })
    setProfileId(null)
    notify(`已屏蔽 ${stripTsTags(client.name)}，可在设置中解除`)
  }

  const unblockClient = (client: Client) => {
    updateSettings({ blocked: settings.blocked.filter((id) => id !== client.id) })
    notify(`已解除对 ${stripTsTags(client.name)} 的屏蔽`)
  }

  const toggleBlockClient = (client: Client) => {
    if (settings.blocked.includes(client.id)) unblockClient(client)
    else blockClient(client)
  }

  const moveClientTo = (client: Client, channelId: string) => {
    const dest = channels.find((channel) => channel.id === channelId)
    setProfileId(null)
    if (!demoMode) {
      if (!client.clid) {
        notify('该成员当前不在线')
        return
      }
      protocol
        .moveClient(client.clid, channelId)
        .then(() => notify(`${stripTsTags(client.name)} 已移动`))
        .catch((error) => notify(errorText(error)))
      return
    }
    setClients((prev) =>
      prev.map((item) => (item.id === client.id ? { ...item, channelId } : item)),
    )
    pushSystem(
      `${stripTsTags(client.name)} 被移动到「${dest ? stripTsTags(dest.name) : '未知频道'}」`,
    )
    notify(`${stripTsTags(client.name)} 已移动`)
  }

  const kickClient = (client: Client) => {
    if (!demoMode) {
      if (!client.clid) {
        notify('该成员当前不在线')
        return
      }
      protocol
        .kickClient(client.clid, '被管理员移出服务器')
        .then(() => notify(`已踢出 ${stripTsTags(client.name)}`))
        .catch((error) => notify(errorText(error)))
      setProfileId(null)
      return
    }
    setClients((prev) => prev.filter((item) => item.id !== client.id))
    pushSystem(`${stripTsTags(client.name)} 已被移出服务器`)
    if (activeDmId === client.id) setActiveDmId(null)
    setProfileId(null)
    notify(`已踢出 ${stripTsTags(client.name)}`)
  }

  const banClient = (client: Client) => {
    if (!demoMode) {
      if (!client.clid) {
        notify('该成员当前不在线')
        return
      }
      protocol
        .banClient(client.clid, 0, '违反服务器规则')
        .then(() => notify(`已封禁 ${stripTsTags(client.name)}`))
        .catch((error) => notify(errorText(error)))
      setProfileId(null)
      return
    }
    setClients((prev) => prev.filter((item) => item.id !== client.id))
    setMessages((prev) => prev.filter((message) => message.clientId !== client.id))
    pushSystem(`${stripTsTags(client.name)} 已被封禁`)
    if (activeDmId === client.id) setActiveDmId(null)
    setProfileId(null)
    notify(`已封禁 ${stripTsTags(client.name)}`)
  }

  const copyUid = async (client: Client) => {
    try {
      await navigator.clipboard.writeText(client.uid ?? client.id)
    } catch {
      /* clipboard unavailable */
    }
    notify('唯一标识已复制')
  }

  const createChannel = async (draft: ChannelDraft) => {
    const password = draft.password.trim()
    if (!demoMode) {
      try {
        const id = await protocol.createChannel({
          name: draft.name,
          description: draft.description,
          parentId: draft.parentId,
          maxClients: draft.maxClients,
          codec: draft.codec,
          bitrate: draft.bitrate,
          password: password || null,
        })
        setActiveId(id)
        setModal(null)
        notify(
          password
            ? `已创建「${draft.name}」，频道密码：${password}`
            : `已创建「${draft.name}」`,
        )
      } catch (error) {
        notify(errorText(error))
      }
      return
    }
    const id = `tmp-${Date.now()}`
    const order = Math.max(0, ...channels.map((channel) => channel.order)) + 1
    const channel: VoiceChannel = {
      id,
      parentId: draft.parentId,
      section: 'public',
      name: draft.name,
      kind: 'voice',
      password: Boolean(password),
      order,
      codec: draft.codec,
      bitrate: draft.bitrate,
      maxClients: draft.maxClients,
      description: draft.description,
    }
    setChannels((prev) => [...prev, channel])
    setClients((prev) =>
      prev.map((client) => (client.self ? { ...client, channelId: id } : client)),
    )
    setActiveId(id)
    setModal(null)
    notify(`已创建并加入「${draft.name}」`)
  }

  const saveChannel = async (
    patch: Partial<VoiceChannel>,
    newPassword: string | null,
  ) => {
    if (!demoMode) {
      const channel = channels.find((item) => item.id === activeId)
      if (!channel) return
      try {
        await protocol.editChannel({
          channelId: channel.id,
          name: patch.name ?? channel.name,
          description: patch.description ?? channel.description ?? '',
          parentId: patch.parentId !== undefined ? patch.parentId : channel.parentId,
          maxClients: patch.maxClients ?? channel.maxClients ?? 0,
          codec: patch.codec ?? channel.codec,
          bitrate: patch.bitrate ?? channel.bitrate,
          password: newPassword,
        })
        let message = '频道设置已保存'
        if (newPassword) message = `频道设置已保存，新密码：${newPassword}`
        else if (newPassword === '') message = '频道设置已保存，已移除频道密码'
        notify(message)
      } catch (error) {
        notify(errorText(error))
      }
      return
    }
    setChannels((prev) =>
      prev.map((channel) => (channel.id === activeId ? { ...channel, ...patch } : channel)),
    )
    notify('频道设置已保存')
  }

  const deleteChannel = async (channel: VoiceChannel) => {
    if (!demoMode) {
      try {
        await protocol.deleteChannel(channel.id)
        notify(`频道「${stripTsTags(channel.name)}」已删除`)
      } catch (error) {
        notify(errorText(error))
      }
      return
    }
    setChannels((prev) =>
      prev
        .filter((item) => item.id !== channel.id)
        .map((item) =>
          item.parentId === channel.id ? { ...item, parentId: null } : item,
        ),
    )
    setMessages((prev) => prev.filter((message) => message.channelId !== channel.id))
    setFiles((prev) => prev.filter((file) => file.channelId !== channel.id))
    setClients((prev) =>
      prev.map((client) =>
        client.channelId === channel.id ? { ...client, channelId: 'hall' } : client,
      ),
    )
    setActiveId('hall')
    notify(`频道「${stripTsTags(channel.name)}」已删除`)
  }

  const refreshFiles = useCallback(
    async (channelId: string) => {
      if (demoMode) return
      try {
        const rows = await protocol.listFiles(channelId)
        setFiles((prev) => [
          ...prev.filter((file) => file.channelId !== channelId),
          ...toFiles(channelId, rows),
        ])
      } catch (error) {
        notify(errorText(error))
      }
    },
    [notify],
  )

  const uploadFiles = async () => {
    if (!settings.fileTransfer) {
      notify('文件传输已在设置中关闭')
      return
    }
    if (!demoMode) {
      const path = await openLocalFile()
      if (!path) return
      notify('正在上传文件…')
      try {
        await protocol.uploadFile(activeId, path)
        notify('文件已上传到当前频道')
        void refreshFiles(activeId)
      } catch (error) {
        notify(errorText(error))
      }
      return
    }
    const file: FileItem = {
      id: `file-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      channelId: activeId,
      name: `示例文件-${Date.now().toString().slice(-4)}.pdf`,
      size: '1.2 MB',
      uploader: settings.nickname || '我',
      time: '刚刚',
      kind: 'doc',
    }
    setFiles((prev) => [file, ...prev])
    notify(`已开始上传 ${file.name}（演示）`)
  }

  const downloadServerFile = async (file: FileItem) => {
    if (!settings.fileTransfer) {
      notify('文件传输已在设置中关闭')
      return
    }
    if (demoMode) {
      notify(`开始下载 ${file.name}（演示）`)
      return
    }
    const destination = await pickSavePath(file.name)
    if (!destination) return
    notify(`正在下载 ${file.name}…`)
    try {
      await protocol.downloadFile(file.channelId, file.name, destination)
      notify('下载完成')
    } catch (error) {
      notify(errorText(error))
    }
  }

  const deleteServerFile = async (file: FileItem) => {
    if (!settings.fileTransfer) {
      notify('文件传输已在设置中关闭')
      return
    }
    if (demoMode) {
      setFiles((prev) => prev.filter((item) => item.id !== file.id))
      notify(`已删除 ${file.name}`)
      return
    }
    try {
      await protocol.deleteFile(file.channelId, file.name)
      notify(`已删除 ${file.name}`)
      void refreshFiles(file.channelId)
    } catch (error) {
      notify(errorText(error))
    }
  }

  const toggleConnection = () => {
    if (!demoMode) {
      void leaveServer()
      return
    }
    const next = !connected
    setConnected(next)
    if (next) {
      setLatency(32)
      notify('正在重新连接…')
    } else {
      notify('已断开语音连接')
    }
  }

  useEffect(() => {
    if (demoMode || modal !== 'files' || !connected) return
    void refreshFiles(activeChannel.id)
  }, [demoMode, modal, connected, activeChannel.id, refreshFiles])

  useEffect(() => {
    if (demoMode || !connected) return
    const self = clients.find((client) => client.self)
    if (!self) return
    const wantedName = settings.nickname.trim()
    const wantedDesc = settings.description.trim()
    const currentName = stripTsTags(self.name).trim()
    const currentDesc = (self.description ?? '').trim()
    const nameChanged = Boolean(wantedName) && wantedName !== currentName
    const descChanged = wantedDesc !== currentDesc
    if (!nameChanged && !descChanged) return
    const timer = window.setTimeout(() => {
      protocol
        .updateSelf(nameChanged ? wantedName : null, descChanged ? wantedDesc : null)
        .then(() => {
          setClients((prev) =>
            prev.map((client) =>
              client.self
                ? {
                    ...client,
                    name: nameChanged ? wantedName : client.name,
                    description: descChanged ? wantedDesc : client.description,
                  }
                : client,
            ),
          )
        })
        .catch(() => {})
    }, 800)
    return () => window.clearTimeout(timer)
  }, [demoMode, connected, clients, settings.nickname, settings.description])

  const markRemoteTalking = useCallback((clid: number, talking: boolean) => {
    setClients((prev) => {
      const target = prev.find((client) => client.clid === clid)
      if (!target || target.talking === talking) return prev
      return prev.map((client) => (client.clid === clid ? { ...client, talking } : client))
    })
  }, [])

  const markSelfTalking = useCallback((talking: boolean) => {
    setClients((prev) => {
      const self = prev.find((client) => client.self)
      if (!self || self.talking === talking) return prev
      return prev.map((client) => (client.self ? { ...client, talking } : client))
    })
  }, [])

  const audioConfig = {
    inputDevice: settings.inputDevice,
    outputDevice: settings.outputDevice,
    inputVolume: settings.inputVolume,
    outputVolume: settings.outputVolume,
    echoCancel: settings.echoCancel,
    noiseSuppress: settings.noiseSuppress,
    autoGain: settings.autoGain,
    inputMode: settings.inputMode,
    vadThreshold: settings.vadThreshold,
    pttHeld,
    musicMode: settings.musicMode,
    bitrate: settings.bitrate,
    frameSize: settings.frameSize,
    stereo: settings.stereo,
    jitterBuffer: settings.jitterBuffer,
    latencyMode: settings.latencyMode,
  }
  const captureKey = [
    settings.inputDevice,
    settings.echoCancel,
    settings.noiseSuppress,
    settings.autoGain,
    settings.frameSize,
    settings.stereo,
    settings.musicMode,
  ].join('|')

  const voiceClients = useMemo(
    () =>
      clients.map((client) =>
        settings.blocked.includes(client.id)
          ? { ...client, localMuted: true, volume: 0 }
          : client,
      ),
    [clients, settings.blocked],
  )

  useVoice({
    enabled: connected && !demoMode,
    muted,
    deafened,
    clients: voiceClients,
    audio: audioConfig,
    captureKey,
    onTalking: markRemoteTalking,
    onSelfTalking: markSelfTalking,
    onAudioError: (message) => {
      if (audioErrorShown.current) return
      audioErrorShown.current = true
      notify(message)
    },
  })

  const hotkeyActions = useRef({
    toggleMute,
    toggleDeafen,
    leaveServer,
    openSettings,
    setLayout,
  })
  hotkeyActions.current = { toggleMute, toggleDeafen, leaveServer, openSettings, setLayout }

  useEffect(() => {
    const isTyping = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false
      const tag = target.tagName
      return (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target.isContentEditable
      )
    }
    const matches = (event: KeyboardEvent, combo: string) => {
      if (!combo) return false
      const parts = combo.split('+')
      const key = parts.pop() ?? ''
      const wantCtrl = parts.includes('Ctrl')
      const wantShift = parts.includes('Shift')
      const wantAlt = parts.includes('Alt')
      const wantWin = parts.includes('Win')
      if (
        event.ctrlKey !== wantCtrl ||
        event.shiftKey !== wantShift ||
        event.altKey !== wantAlt ||
        event.metaKey !== wantWin
      ) {
        return false
      }
      const pressed = event.key.length === 1 ? event.key.toUpperCase() : event.key
      const wanted = key.length === 1 ? key.toUpperCase() : key
      return pressed === wanted
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return
      const hotkeys = settingsRef.current.hotkeys
      if (matches(event, hotkeys.ptt)) {
        setPttHeld(true)
        return
      }
      if (matches(event, hotkeys.mute)) {
        event.preventDefault()
        hotkeyActions.current.toggleMute()
        return
      }
      if (matches(event, hotkeys.deafen)) {
        event.preventDefault()
        hotkeyActions.current.toggleDeafen()
        return
      }
      if (matches(event, hotkeys.layout)) {
        event.preventDefault()
        const layout =
          settingsRef.current.layout === 'cards' ? 'grid' : 'cards'
        hotkeyActions.current.setLayout(layout)
        return
      }
      if (matches(event, hotkeys.settings)) {
        event.preventDefault()
        hotkeyActions.current.openSettings('account')
        return
      }
      if (matches(event, hotkeys.disconnect) && connectedRef.current) {
        event.preventDefault()
        void hotkeyActions.current.leaveServer()
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (matches(event, settingsRef.current.hotkeys.ptt)) setPttHeld(false)
    }
    const onBlur = () => setPttHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    if (demoMode || !connected) return
    const timer = window.setTimeout(() => {
      const config = settingsRef.current
      const away = config.presenceStatus === 'away' || config.dnd
      protocol
        .setAway(
          away,
          away ? (config.dnd ? '勿扰模式' : config.awayMessage || '暂时离开') : null,
        )
        .catch(() => {})
    }, 500)
    return () => window.clearTimeout(timer)
  }, [connected, settings.presenceStatus, settings.dnd, settings.awayMessage])

  useEffect(() => {
    if (demoMode || !connected) return
    const uid = selfUidRef.current
    if (!uid) return
    try {
      localStorage.setItem(
        `rayspeak.dm.v1:${uid}`,
        JSON.stringify(dmMessages.slice(-400)),
      )
    } catch {
      /* storage unavailable */
    }
  }, [dmMessages, connected])

  useEffect(() => {
    if (page !== 'contacts' || !activeDmId) return
    setUnread((prev) => {
      if (!prev[activeDmId]) return prev
      const next = { ...prev }
      delete next[activeDmId]
      return next
    })
  }, [page, activeDmId])

  const refreshSnapshot = useCallback(() => {
    if (demoMode) {
      notify('演示模式已是最新数据')
      return
    }
    if (refreshing) return
    setRefreshing(true)
    protocol
      .refreshDirectory()
      .then((snapshot) => {
        applySnapshot(snapshot)
        notify('已刷新频道、成员与频道设置')
      })
      .catch((error) => notify(errorText(error)))
      .finally(() => setRefreshing(false))
  }, [applySnapshot, demoMode, notify, refreshing])

  const resetSettings = () => {
    setSettings({ ...defaultSettings, hotkeys: { ...defaultSettings.hotkeys }, blocked: [] })
    notify('已恢复默认设置')
  }

  const startShare = (stream: MediaStream | null, mock: boolean) => {
    setShareStream(stream)
    setShareMock(mock)
    setSharing(true)
  }

  const stopShare = () => {
    shareStream?.getTracks().forEach((track) => track.stop())
    setShareStream(null)
    setShareMock(false)
    setSharing(false)
    notify('已停止屏幕共享')
  }

  const handleAppContextMenu = (event: ReactMouseEvent) => {
    const el = event.target as HTMLElement
    const editing =
      el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable ||
      Boolean(el.closest('input, textarea, [contenteditable="true"]'))
    if (editing) return
    event.preventDefault()
    const memberEl = el.closest('[data-client-id]') as HTMLElement | null
    if (memberEl?.dataset.clientId) {
      const client = viewClients.find((item) => item.id === memberEl.dataset.clientId)
      if (client) {
        setContextMenu({ x: event.clientX, y: event.clientY, target: { kind: 'client', client } })
        return
      }
    }
    const channelEl = el.closest('[data-channel-id]') as HTMLElement | null
    if (channelEl?.dataset.channelId) {
      const channel = channels.find((item) => item.id === channelEl.dataset.channelId)
      if (channel) {
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          target: { kind: 'channel', channel },
        })
        return
      }
    }
    const messageEl = el.closest('.msg')
    if (messageEl) {
      const text = messageEl.querySelector('.msg-text')?.textContent ?? ''
      if (text) {
        setContextMenu({
          x: event.clientX,
          y: event.clientY,
          target: { kind: 'message', text },
        })
        return
      }
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target: { kind: 'app' } })
  }

  const copyText = (text: string, label: string) => {
    void navigator.clipboard
      .writeText(text)
      .then(() => notify(label))
      .catch(() => notify('剪贴板不可用'))
  }

  const contextItems: ContextItem[] = []
  if (contextMenu) {
    const target = contextMenu.target
    if (target.kind === 'channel') {
      const channel = target.channel
      contextItems.push(
        {
          label: '加入频道',
          icon: <Volume2 size={15} strokeWidth={2} />,
          onClick: () => joinChannel(channel.id),
        },
        {
          label: '复制 ray:// 邀请链接',
          icon: <Link2 size={15} strokeWidth={2} />,
          onClick: () =>
            copyText(
              rayInviteLink(channel.id, stripTsTags(channel.name)),
              '邀请链接已复制',
            ),
        },
        {
          label: '频道设置',
          icon: <SlidersHorizontal size={15} strokeWidth={2} />,
          disabled: channel.kind !== 'voice' || !canModerate,
          onClick: () => {
            setActiveId(channel.id)
            setModal('room')
          },
        },
        {
          label: '刷新频道与成员',
          icon: <RefreshCw size={15} strokeWidth={2} />,
          onClick: refreshSnapshot,
        },
      )
    } else if (target.kind === 'client') {
      const client = target.client
      contextItems.push({
        label: '查看资料',
        icon: <UserRound size={15} strokeWidth={2} />,
        onClick: () => openProfile(client.id),
      })
      if (!client.self) {
        contextItems.push(
          {
            label: '私聊',
            icon: <MessageSquare size={15} strokeWidth={2} />,
            onClick: () => openDm(client),
          },
          {
            label: '邀请到我的频道',
            icon: <UserRoundPlus size={15} strokeWidth={2} />,
            onClick: () => inviteToChannel(client),
          },
          {
            label: client.localMuted ? '取消本地静音' : '本地静音',
            icon: client.localMuted ? (
              <Volume2 size={15} strokeWidth={2} />
            ) : (
              <VolumeX size={15} strokeWidth={2} />
            ),
            onClick: () => toggleLocalMute(client.id),
          },
        )
      }
      contextItems.push({
        label: '复制 UID',
        icon: <Copy size={15} strokeWidth={2} />,
        onClick: () => void copyUid(client),
      })
      if (client.self) {
        contextItems.push(
          {
            label: '设置头像',
            icon: <ImagePlus size={15} strokeWidth={2} />,
            onClick: pickAvatar,
          },
          {
            label: '删除头像',
            icon: <Trash2 size={15} strokeWidth={2} />,
            disabled: !client.avatarUrl,
            onClick: () => void removeSelfAvatar(),
          },
        )
      }
      if (!client.self) {
        contextItems.push(
          {
            label: '移动到频道',
            icon: <ArrowRightLeft size={15} strokeWidth={2} />,
            disabled: !canModerate || !client.clid,
            onClick: () => setMoveTarget(client),
          },
          {
            label: '踢出服务器',
            icon: <UserMinus size={16} strokeWidth={2} />,
            danger: true,
            disabled: !canModerate || !client.clid,
            onClick: () => setConfirm({ kind: 'kick', client }),
          },
          {
            label: '封禁',
            icon: <Ban size={15} strokeWidth={2} />,
            danger: true,
            disabled: !canModerate || !client.clid,
            onClick: () => setConfirm({ kind: 'ban', client }),
          },
        )
      }
    } else if (target.kind === 'message') {
      contextItems.push({
        label: '复制消息',
        icon: <Copy size={15} strokeWidth={2} />,
        onClick: () => copyText(target.text, '消息已复制'),
      })
    } else {
      contextItems.push(
        {
          label: '刷新频道与成员',
          icon: <RefreshCw size={15} strokeWidth={2} />,
          onClick: refreshSnapshot,
        },
        {
          label: '打开设置',
          icon: <SlidersHorizontal size={15} strokeWidth={2} />,
          onClick: () => openSettings('account'),
        },
        {
          label: muted ? '取消静音' : '静音麦克风',
          icon: muted ? <Mic size={15} strokeWidth={2} /> : <MicOff size={15} strokeWidth={2} />,
          onClick: toggleMute,
        },
        {
          label: deafened ? '取消闭麦' : '闭麦',
          icon: <Headphones size={15} strokeWidth={2} />,
          onClick: toggleDeafen,
        },
        {
          label: '断开连接',
          icon: <LogOut size={15} strokeWidth={2} />,
          danger: true,
          disabled: !connected,
          onClick: () => void leaveServer(),
        },
      )
    }
  }

  const userName = settings.nickname || '我'
  const currentCodec = `${activeChannel.codec} · ${activeChannel.bitrate} kbps`
  const dark = isDark(settings.theme)
  const selfPresence: SelfPresence = settings.dnd ? 'busy' : settings.presenceStatus
  const setPresence = (next: SelfPresence) => {
    if (next === 'busy') updateSettings({ dnd: true })
    else updateSettings({ dnd: false, presenceStatus: next })
  }
  const toggleTheme = () => updateSettings({ theme: dark ? 'light' : 'dark' })

  if (!demoMode && auth !== 'ready') {
    return (
      <div className="app" onContextMenu={(event) => event.preventDefault()}>
        <TitleBar
          connected={false}
          latency={0}
          status={auth === 'connecting' ? '正在连接服务器…' : '等待登录'}
        />
        <LoginScreen
          connecting={auth === 'connecting'}
          error={authError}
          initialNickname={loginName}
          onConnect={(nickname, password) => {
            void connectToServer(nickname, password)
          }}
        />
      </div>
    )
  }

  return (
    <div className="app" onContextMenu={handleAppContextMenu}>
      <TitleBar connected={connected} latency={latency} />

      <div className={`body ${page === 'contacts' ? 'contacts-mode' : ''}`}>
        <ServerRail
          muted={muted}
          deafened={deafened}
          selfName={userName}
          selfAvatar={selfClient?.avatarUrl}
          selfStatus={settings.dnd ? 'busy' : settings.presenceStatus}
          unreadCount={Object.values(unread).reduce((total, value) => total + value, 0)}
          activeTab={page === 'settings' ? 'settings' : page === 'contacts' ? 'contacts' : 'voice'}
          onToggleMute={toggleMute}
          onToggleDeafen={toggleDeafen}
          onNavigate={(tab) => {
            if (tab === 'voice') setPage('voice')
            else if (tab === 'contacts') setPage('contacts')
            else openSettings('account')
          }}
        />

        {page === 'contacts' ? (
          <ContactsPage
            clients={viewClients}
            self={selfClient}
            messages={dmMessages}
            activeId={activeDmId}
            blocked={settings.blocked}
            unread={unread}
            channels={channels}
            onSelect={selectDm}
            onSend={sendDm}
            onOpenProfile={openProfile}
            onInvite={(client) => openInvite(client)}
            onPoke={pokeClient}
            onBlock={blockClient}
            onUnblock={unblockClient}
            onJoinChannel={(client) => {
              if (!client.channelId) return
              setPage('voice')
              joinChannel(client.channelId)
            }}
            onJumpVoice={() => setPage('voice')}
            onToast={notify}
          />
        ) : (
          <>
            <ChannelSidebar
              channels={channels}
              clients={visibleClients}
              activeId={activeId}
              selfId={selfId}
              serverName={serverInfo.name || 'RaySpeak 社区'}
              serverMax={serverInfo.maxClients}
              serverIcon={serverIcon}
              showIcons={settings.showChannelIcons}
              onCreate={() => setModal('create')}
              onJoin={joinChannel}
              onSelectClient={openProfile}
              onRefresh={refreshSnapshot}
              refreshing={refreshing}
            />

            <main className="stage">
              <header className="room-head">
                <div className="room-heading">
                  <div className="room-title-row">
                    {settings.showChannelIcons && channelIconUrl(activeChannel.iconId) && (
                      <img
                        className="room-icon"
                        src={channelIconUrl(activeChannel.iconId)}
                        alt=""
                        draggable={false}
                      />
                    )}
                    <h1>{renderTsText(activeChannel.name)}</h1>
                    <span className={`live-pill ${connected ? '' : 'offline'}`}>
                      {connected ? '语音中' : '已断开'}
                    </span>
                    {activeChannel.password && (
                      <span className="lock-pill" title="频道已加锁">
                        <Lock size={11} strokeWidth={2.2} />
                      </span>
                    )}
                    {sharing && (
                      <button
                        className="share-pill"
                        title="打开屏幕共享面板"
                        onClick={() => setModal('screen')}
                      >
                        <MonitorUp size={11} strokeWidth={2.2} />
                        屏幕共享中
                      </button>
                    )}
                  </div>
                  <p className="room-sub">
                    {members.length} 人在线 · {currentCodec} · 延迟{' '}
                    {connected ? `${latency}ms` : '--'}
                    {activeChannel.maxClients ? ` · 上限 ${activeChannel.maxClients} 人` : ''}
                  </p>
                </div>

                <div className="room-actions">
                  <div className="layout-switch" role="group" aria-label="房间布局">
                    <button
                      className={settings.layout === 'cards' ? 'active' : ''}
                      title="成员卡片布局"
                      aria-pressed={settings.layout === 'cards'}
                      onClick={() => setLayout('cards')}
                    >
                      <Columns2 size={15} strokeWidth={2.1} />
                    </button>
                    <button
                      className={settings.layout === 'grid' ? 'active' : ''}
                      title="网格式布局"
                      aria-pressed={settings.layout === 'grid'}
                      onClick={() => setLayout('grid')}
                    >
                      <LayoutGrid size={15} strokeWidth={2.1} />
                    </button>
                  </div>

                  <div className="presence-wrap">
                    <button
                      className={`ghost-btn presence-btn ${selfPresence}`}
                      title="调整我的在线状态"
                      aria-haspopup="menu"
                      aria-expanded={presenceMenu}
                      onClick={() => setPresenceMenu((value) => !value)}
                    >
                      <span className={`presence-dot ${selfPresence}`} />
                      {presenceLabel[selfPresence]}
                      <ChevronDown
                        size={12}
                        strokeWidth={2.4}
                        className={`presence-caret ${presenceMenu ? 'open' : ''}`}
                      />
                    </button>
                    {presenceMenu && (
                      <>
                        <div
                          className="presence-scrim"
                          onClick={() => setPresenceMenu(false)}
                        />
                        <div className="presence-menu" role="menu">
                          {presenceOptions.map((option) => (
                            <button
                              key={option.id}
                              role="menuitemradio"
                              aria-checked={selfPresence === option.id}
                              className={selfPresence === option.id ? 'active' : ''}
                              onClick={() => {
                                setPresence(option.id)
                                setPresenceMenu(false)
                              }}
                            >
                              <span className={`presence-dot ${option.id}`} />
                              <span className="presence-copy">
                                <strong>{option.label}</strong>
                                <em>{option.hint}</em>
                              </span>
                              {selfPresence === option.id && (
                                <Check size={13} strokeWidth={2.6} />
                              )}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <button
                    className="ghost-btn theme-toggle"
                    title={dark ? '切换到浅色模式' : '切换到深色模式'}
                    onClick={toggleTheme}
                  >
                    {dark ? <Sun size={14} strokeWidth={2} /> : <Moon size={14} strokeWidth={2} />}
                    {dark ? '浅色' : '深色'}
                  </button>

                  <button className="ghost-btn" onClick={() => setModal('queue')}>
                    <UserRoundPlus size={14} strokeWidth={2} />
                    频道动态
                  </button>
                  <button className="ghost-btn" onClick={() => openInvite(null)}>
                    邀请
                  </button>
                  <button className="ghost-btn" onClick={() => setModal('room')}>
                    房间设置
                  </button>
                </div>
              </header>

              <div className="room-body">
                {settings.layout === 'cards' ? (
                  <div className="room-split">
                    <MemberPanel
                      members={members}
                      limit={activeChannel.maxClients ?? 0}
                      others={otherStats}
                      onOpenProfile={openProfile}
                      onVolume={changeVolume}
                      onToggleLocalMute={toggleLocalMute}
                      onQueue={() => setModal('queue')}
                      onRefresh={refreshSnapshot}
                    />
                    <ChatPanel
                      channel={activeChannel}
                      messages={channelMessages}
                      system={channelSystem}
                      selfGroups={selfClient?.serverGroups ?? []}
                      onSend={sendMessage}
                      onMore={() => setModal('queue')}
                      onSelectClient={openProfile}
                    />
                  </div>
                ) : (
                  <div className="room-stack">
                    <MemberGrid
                      members={members}
                      limit={activeChannel.maxClients ?? 0}
                      others={otherStats}
                      onOpenProfile={openProfile}
                      onVolume={changeVolume}
                      onToggleLocalMute={toggleLocalMute}
                      onQueue={() => setModal('queue')}
                      onRefresh={refreshSnapshot}
                    />
                    <ChatPanel
                      channel={activeChannel}
                      messages={channelMessages}
                      system={channelSystem}
                      selfGroups={selfClient?.serverGroups ?? []}
                      onSend={sendMessage}
                      onMore={() => setModal('queue')}
                      onSelectClient={openProfile}
                    />
                  </div>
                )}
              </div>

              <VoiceBar
                muted={muted}
                deafened={deafened}
                connected={connected}
                deviceName={
                  settings.inputDevice
                    ? deviceLabels[settings.inputDevice] || '已选麦克风'
                    : '系统默认麦克风'
                }
                inputVolume={settings.inputVolume}
                codecLabel={`${settings.musicMode ? 'Opus Music' : 'Opus'} · ${
                  settings.bitrate
                }kbps · ${connected ? `${latency}ms` : '--'}`}
                layout={settings.layout}
                onToggleMute={toggleMute}
                onToggleDeafen={toggleDeafen}
                onOpenSettings={() => openSettings('audio')}
                onToggleConnection={toggleConnection}
                onLayout={setLayout}
              />
            </main>
          </>
        )}
      </div>

      {page === 'settings' && (
        <SettingsPage
          settings={settings}
          clients={viewClients}
          section={settingsSection}
          connected={connected}
          latency={latency}
          permissions={permissions}
          demoMode={demoMode}
          onSection={setSettingsSection}
          onChange={updateSettings}
          onReset={resetSettings}
          onClose={() => setPage(settingsReturn)}
          onToast={notify}
        />
      )}

      {modal === 'invite' && (
        <InviteModal
          channel={activeChannel}
          contact={inviteTarget ? stripTsTags(inviteTarget.name) : null}
          onClose={() => {
            setModal(null)
            setInviteTarget(null)
          }}
          onCopy={() => {
            notify('邀请信息已复制')
          }}
          onSend={inviteTarget ? sendInvite : undefined}
        />
      )}

      {modal === 'queue' && (
        <ChannelEventsModal
          channelName={stripTsTags(activeChannel.name)}
          lines={channelSystem}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'create' && (
        <CreateChannelModal
          channels={channels}
          onCreate={createChannel}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'room' && (
        <RoomSettingsModal
          channel={activeChannel}
          channels={channels}
          memberCount={members.length}
          canManage={canModerate}
          onSave={saveChannel}
          onDelete={() => {
            setModal(null)
            setConfirm({ kind: 'delete-channel', channel: activeChannel })
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'files' && (
        <FilePanelModal
          channel={activeChannel}
          files={channelFiles}
          canUpload={settings.fileTransfer}
          onUpload={() => {
            void uploadFiles()
          }}
          onDownload={(file) => {
            void downloadServerFile(file)
          }}
          onDelete={(file) => {
            void deleteServerFile(file)
          }}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'screen' && (
        <ScreenShareModal
          channel={activeChannel}
          sharing={sharing}
          mock={shareMock}
          stream={shareStream}
          onStart={startShare}
          onStop={stopShare}
          onClose={() => setModal(null)}
          onToast={notify}
        />
      )}

      {moveTarget && (
        <MoveClientModal
          client={moveTarget}
          channels={channels}
          memberCount={(id) => clients.filter((client) => client.channelId === id).length}
          onMove={(channelId) => moveClientTo(moveTarget, channelId)}
          onClose={() => setMoveTarget(null)}
        />
      )}

      {confirm && (
        <ConfirmModal
          title={
            confirm.kind === 'kick'
              ? '踢出成员'
              : confirm.kind === 'ban'
                ? '封禁成员'
                : '删除频道'
          }
          subtitle={
            confirm.kind === 'delete-channel' ? '频道内的服务器文件会一并删除' : undefined
          }
          message={
            confirm.kind === 'delete-channel'
              ? `确定要删除频道「${stripTsTags(confirm.channel.name)}」吗？频道成员会被移出。`
              : confirm.kind === 'kick'
                ? `确定要把 ${stripTsTags(confirm.client.name)} 移出服务器吗？`
                : `确定要封禁 ${stripTsTags(confirm.client.name)} 吗？该成员将无法重新加入。`
          }
          confirmLabel={
            confirm.kind === 'kick' ? '踢出' : confirm.kind === 'ban' ? '封禁' : '删除频道'
          }
          danger
          onConfirm={() => {
            if (confirm.kind === 'delete-channel') deleteChannel(confirm.channel)
            else if (confirm.kind === 'kick') kickClient(confirm.client)
            else banClient(confirm.client)
          }}
          onClose={() => setConfirm(null)}
        />
      )}

      {passwordChannel && (
        <PasswordModal
          channel={passwordChannel}
          onClose={() => setPasswordChannel(null)}
          onSubmit={(password) => {
            joinChannel(passwordChannel.id, password)
            setPasswordChannel(null)
          }}
        />
      )}

      {profileClient && (
        <ProfileModal
          client={profileClient}
          channelName={
            profileClient.presence === 'offline'
              ? '不在服务器'
              : channels.find((channel) => channel.id === profileClient.channelId)?.name ??
                '未知频道'
          }
          canModerate={canModerate}
          blocked={settings.blocked.includes(profileClient.id)}
          onClose={() => setProfileId(null)}
          onVolume={(volume) => changeVolume(profileClient.id, volume)}
          onToggleLocalMute={() => toggleLocalMute(profileClient.id)}
          onInvite={() => inviteToChannel(profileClient)}
          onDm={() => openDm(profileClient)}
          onBlock={() => toggleBlockClient(profileClient)}
          onPoke={() => pokeClient(profileClient)}
          onMove={() => {
            setProfileId(null)
            setMoveTarget(profileClient)
          }}
          onKick={() => setConfirm({ kind: 'kick', client: profileClient })}
          onBan={() => setConfirm({ kind: 'ban', client: profileClient })}
          onCopyUid={() => copyUid(profileClient)}
          onSetAvatar={pickAvatar}
          onRemoveAvatar={() => void removeSelfAvatar()}
          hasAvatar={Boolean(profileClient.avatarUrl)}
        />
      )}

      {toast && (
        <div className="toast">
          <Info size={14} strokeWidth={2} />
          {toast}
        </div>
      )}

      <input
        ref={avatarInputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void applyAvatarFile(file)
        }}
      />

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}

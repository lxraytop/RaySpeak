export type Presence = 'online' | 'away' | 'busy' | 'offline'

export type GroupIcon =
  | 'shield'
  | 'crown'
  | 'flag'
  | 'music'
  | 'star'
  | 'badge'
  | 'users'
  | 'swords'
  | 'radio'
  | 'spark'

export interface ServerGroup {
  id: string
  name: string
  icon: GroupIcon
  color: string
  type: 'server' | 'channel'
  power?: number
}

export interface Client {
  id: string
  clid?: number
  name: string
  letter: string
  hue: number
  description: string
  avatarHash?: string
  avatarUrl?: string
  channelId: string
  serverGroups: string[]
  channelGroups: string[]
  micMuted: boolean
  outputMuted: boolean
  talking: boolean
  volume: number
  localMuted: boolean
  presence: Presence
  device: 'desktop' | 'mobile'
  awayMessage?: string
  connectedAt: string
  platform?: string
  version?: string
  uid?: string
  dbId?: string
  self?: boolean
}

export interface VoiceChannel {
  id: string
  parentId: string | null
  section: 'public' | 'mine'
  name: string
  kind: 'voice' | 'spacer'
  iconId?: string
  password?: boolean
  maxClients?: number
  order: number
  codec: string
  bitrate: number
  description?: string
}

export interface ChatMessage {
  id: string
  channelId: string
  clientId: string
  author: string
  letter: string
  hue: number
  avatarUrl?: string
  time: string
  text: string
  self?: boolean
}

export interface SystemLine {
  id: string
  channelId: string
  text: string
  strong?: string
}

export interface DmMessage {
  id: string
  contactId: string
  author: string
  letter: string
  hue: number
  avatarUrl?: string
  time: string
  text: string
  self?: boolean
  system?: boolean
}

export interface FileItem {
  id: string
  channelId: string
  name: string
  size: string
  uploader: string
  time: string
  kind: 'image' | 'audio' | 'video' | 'doc' | 'archive' | 'other'
}

export type LayoutId = 'cards' | 'grid'

export type ThemeMode = 'light' | 'dark' | 'system'
export type Density = 'compact' | 'cozy' | 'spacious'
export type CardStyle = 'flat' | 'raised' | 'outline'
export type BackgroundId = 'mist' | 'mint' | 'sunset' | 'aurora' | 'plain'

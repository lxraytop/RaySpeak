import { groupMap } from '../data/mock'
import type { Client, FileItem, GroupIcon, VoiceChannel } from '../types'
import type { ChannelDto, ClientDto, FileDto, GroupDto, SnapshotDto } from '../protocol'
import { stripTsTags } from './tsText'

const GROUP_ICONS: GroupIcon[] = [
  'shield',
  'crown',
  'flag',
  'music',
  'star',
  'badge',
  'users',
  'swords',
  'radio',
  'spark',
]

const GROUP_COLORS = [
  '#3d6bf5',
  '#8b5cf6',
  '#14b8a6',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#10b981',
  '#64748b',
  '#ec4899',
  '#84cc16',
]

function hash(text: string) {
  let value = 0
  for (let index = 0; index < text.length; index += 1) {
    value = (value * 31 + text.charCodeAt(index)) | 0
  }
  return Math.abs(value)
}

function clockLabel() {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

const BUILTIN_GROUP_ICONS: Record<number, { icon: GroupIcon; color: string }> = {
  '-2': { icon: 'shield', color: '#64748b' },
  '-1': { icon: 'users', color: '#0ea5e9' },
  100: { icon: 'shield', color: '#3d6bf5' },
  200: { icon: 'flag', color: '#14b8a6' },
  300: { icon: 'crown', color: '#f59e0b' },
  500: { icon: 'badge', color: '#8b5cf6' },
  600: { icon: 'radio', color: '#0ea5e9' },
}

export function registerLiveGroups(groups: GroupDto[]) {
  for (const group of groups) {
    const builtin = group.iconId ? BUILTIN_GROUP_ICONS[group.iconId] : undefined
    groupMap.set(group.id, {
      id: group.id,
      name: group.name,
      icon: builtin?.icon ?? GROUP_ICONS[hash(group.id) % GROUP_ICONS.length],
      color: builtin?.color ?? GROUP_COLORS[hash(group.name) % GROUP_COLORS.length],
      type: group.kind === 'channel' ? 'channel' : 'server',
      power: Math.max(1, 100 - group.order),
    })
  }
}

const CODEC_NAMES: Record<number, string> = {
  0: 'Speex Narrow',
  1: 'Speex Wide',
  2: 'Speex Ultra',
  3: 'CELT Mono',
  4: 'Opus',
  5: 'Opus Music',
}

function isSpacer(name: string) {
  return /^\[(c?spacer|\*spacer)/i.test(name)
}

export function toChannel(dto: ChannelDto): VoiceChannel {
  return {
    id: dto.id,
    parentId: dto.parentId || null,
    section: 'public',
    name: dto.name,
    kind: isSpacer(dto.name) ? 'spacer' : 'voice',
    iconId: dto.iconId ? String(dto.iconId) : undefined,
    password: dto.password,
    maxClients: dto.maxClients ?? undefined,
    order: dto.order,
    codec: CODEC_NAMES[dto.codec ?? 4] ?? 'Opus',
    bitrate: dto.bitrate || 64,
    description: dto.description || undefined,
  }
}

export function toChannels(snapshot: SnapshotDto): VoiceChannel[] {
  return snapshot.channels.map(toChannel)
}

export interface SavedVolume {
  volume: number
  localMuted: boolean
}

export function toClient(
  dto: ClientDto,
  previous?: Client,
  saved?: SavedVolume,
): Client {
  const name = dto.name || '未命名'
  const clean = stripTsTags(name).trim() || name
  const avatarHash = dto.avatarHash ?? undefined
  return {
    id: dto.id,
    clid: dto.clid,
    name,
    letter: clean.slice(0, 1).toUpperCase() || 'R',
    hue: hash(dto.id) % 360,
    description: previous?.description ?? '',
    avatarHash,
    avatarUrl: previous?.avatarHash === avatarHash ? previous?.avatarUrl : undefined,
    channelId: dto.channelId,
    serverGroups: dto.serverGroups,
    channelGroups: previous?.channelGroups ?? [],
    micMuted: dto.micMuted,
    outputMuted: dto.outputMuted,
    talking: previous?.talking ?? false,
    volume: previous?.volume ?? saved?.volume ?? 100,
    localMuted: previous?.localMuted ?? saved?.localMuted ?? false,
    presence: dto.away ? 'away' : 'online',
    device: previous?.device ?? 'desktop',
    awayMessage: dto.awayMessage ?? undefined,
    connectedAt: previous?.connectedAt ?? clockLabel(),
    platform: previous?.platform,
    version: previous?.version,
    uid: dto.id,
    dbId: previous?.dbId,
    self: dto.isSelf,
  }
}

export function toClients(
  snapshot: SnapshotDto,
  previous: Client[],
  saved: Record<string, SavedVolume> = {},
): Client[] {
  const byId = new Map(previous.map((client) => [client.id, client]))
  return snapshot.clients.map((dto) => toClient(dto, byId.get(dto.id), saved[dto.id]))
}

export function fileKind(name: string): FileItem['kind'] {
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image'
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a'].includes(ext)) return 'audio'
  if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'video'
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive'
  if (['txt', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'md'].includes(ext)) {
    return 'doc'
  }
  return 'other'
}

export function sizeLabel(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function toFiles(channelId: string, rows: FileDto[]): FileItem[] {
  return rows.map((row) => {
    const stamp = Number(row.datetime) * 1000
    const date = Number.isFinite(stamp) && stamp > 0 ? new Date(stamp) : null
    return {
      id: `${channelId}:${row.name}`,
      channelId,
      name: row.name,
      size: sizeLabel(Number(row.size)),
      uploader: '服务器文件',
      time: date
        ? `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
        : '—',
      kind: fileKind(row.name),
    }
  })
}

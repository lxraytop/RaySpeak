import { invoke } from '@tauri-apps/api/core'

export interface ChannelDto {
  id: string
  parentId: string
  name: string
  description: string
  order: number
  password: boolean
  maxClients: number | null
  codec: number | null
  bitrate: number
  iconId: number | null
}

export interface ClientDto {
  id: string
  clid: number
  name: string
  avatarHash: string | null
  channelId: string
  serverGroups: string[]
  micMuted: boolean
  outputMuted: boolean
  away: boolean
  awayMessage: string | null
  channelCommander: boolean
  clientType: number
  isSelf: boolean
}

export interface GroupDto {
  id: string
  name: string
  kind: 'server' | 'channel'
  iconId: number | null
  order: number
}

export interface SnapshotDto {
  channels: ChannelDto[]
  clients: ClientDto[]
  groups: GroupDto[]
  selfClid: number
  truncated: boolean
}

export interface ConnectResultDto {
  selfClid: number
  snapshot: SnapshotDto
}

export interface ClientDetailsDto {
  clid: number
  description: string | null
  avatarHash: string | null
  platform: string | null
  version: string | null
  databaseId: string | null
  channelGroupId: string | null
  channelGroupName: string | null
  uid: string | null
}

export interface FileDto {
  name: string
  size: string
  datetime: string
  directory: boolean
}

export interface StatsDto {
  ping: number
  packetLoss: number
  bandwidthSent: number
  bandwidthReceived: number
}

export interface ServerInfoDto {
  name: string
  platform: string
  version: string
  maxClients: number
  onlineClients: number
  uptime: number
  iconId?: number | null
}

export interface AppInfoDto {
  version: string
  dataDir: string
}

export interface MessageEvent {
  invokerClid: number
  invokerUid: string
  invokerName: string
  message: string
  targetMode: number
  targetId: string
  invokerGroups: string[]
}

export interface PokeEvent {
  invokerClid: number
  invokerUid: string
  invokerName: string
  message: string
}

export interface VoiceEvent {
  clientId: number
  codec: number
  data: string
}

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export const protocol = {
  connect: (nickname: string, password: string, timeout?: number) =>
    invoke<ConnectResultDto>('connect_server', { nickname, password, timeout: timeout ?? null }),
  disconnect: () => invoke<void>('disconnect_server'),
  getIdentity: () => invoke<string>('get_identity_string'),
  exportIdentity: (destination: string) =>
    invoke<void>('export_identity', { destination }),
  getSnapshot: () => invoke<SnapshotDto>('get_snapshot'),
  refreshDirectory: () => invoke<SnapshotDto>('refresh_directory'),
  takeDeepLink: () => invoke<string | null>('take_deep_link'),
  joinChannel: (channelId: string, password?: string) =>
    invoke<void>('join_channel', { channelId, password: password ?? null }),
  sendChannelMessage: (channelId: string, message: string) =>
    invoke<void>('send_channel_message', { channelId, message }),
  sendPrivateMessage: (targetClid: number, message: string) =>
    invoke<void>('send_private_message', { targetClid, message }),
  sendServerMessage: (message: string) =>
    invoke<void>('send_server_message', { message }),
  pokeClient: (targetClid: number, message: string) =>
    invoke<void>('poke_client', { targetClid, message }),
  moveClient: (targetClid: number, channelId: string) =>
    invoke<void>('move_client', { targetClid, channelId }),
  kickClient: (targetClid: number, reason?: string) =>
    invoke<void>('kick_client', { targetClid, reason: reason ?? null }),
  banClient: (targetClid: number, seconds?: number, reason?: string) =>
    invoke<void>('ban_client', { targetClid, seconds: seconds ?? null, reason: reason ?? null }),
  createChannel: (payload: {
    name: string
    description: string
    parentId?: string | null
    maxClients: number
    codec: string
    bitrate: number
    password?: string | null
  }) => invoke<string>('create_channel', payload),
  editChannel: (payload: {
    channelId: string
    name: string
    description: string
    parentId?: string | null
    maxClients: number
    codec: string
    bitrate: number
    password?: string | null
  }) => invoke<void>('edit_channel', payload),
  deleteChannel: (channelId: string) => invoke<void>('delete_channel', { channelId }),
  updateSelf: (nickname?: string | null, description?: string | null) =>
    invoke<void>('update_self', { nickname: nickname ?? null, description: description ?? null }),
  getClientDetails: (clid: number) =>
    invoke<ClientDetailsDto>('get_client_details', { clid }),
  getMyPermissions: () => invoke<string[]>('get_my_permissions'),
  getStats: () => invoke<StatsDto>('get_stats'),
  getServerInfo: () => invoke<ServerInfoDto>('get_server_info'),
  getAppInfo: () => invoke<AppInfoDto>('get_app_info'),
  openDataDir: () => invoke<void>('open_data_dir'),
  listFiles: (channelId: string) => invoke<FileDto[]>('list_files', { channelId }),
  uploadFile: (channelId: string, localPath: string) =>
    invoke<void>('upload_file', { channelId, localPath }),
  downloadFile: (channelId: string, fileName: string, destination: string) =>
    invoke<void>('download_file', { channelId, fileName, destination }),
  deleteFile: (channelId: string, fileName: string) =>
    invoke<void>('delete_file', { channelId, fileName }),
  fetchChannelIcon: (iconId: number) =>
    invoke<string>('fetch_channel_icon', { iconId }),
  fetchClientAvatar: (uid: string, avatarHash: string) =>
    invoke<string>('fetch_client_avatar', { uid, avatarHash }),
  uploadAvatar: (data: string) => invoke<string>('upload_avatar', { data }),
  deleteAvatar: () => invoke<void>('delete_avatar'),
  setVoiceEnabled: (enabled: boolean) => invoke<void>('set_voice_enabled', { enabled }),
  sendVoiceData: (data: string, codec: number) =>
    invoke<void>('send_voice_data', { data, codec }),
  setAudioState: (inputMuted: boolean, outputMuted: boolean) =>
    invoke<void>('set_audio_state', { inputMuted, outputMuted }),
  setAway: (away: boolean, message?: string | null) =>
    invoke<void>('set_away', { away, message: message ?? null }),
  sendPluginCommand: (name: string, data: string, target: number, targetId?: number) =>
    invoke<void>('send_plugin_command_backend', {
      name,
      data,
      target,
      targetId: targetId ?? null,
    }),
}

export async function listenEvent<T>(
  event: string,
  handler: (payload: T) => void,
): Promise<() => void> {
  if (!isTauri) return () => {}
  const { listen } = await import('@tauri-apps/api/event')
  return listen<T>(event, (message) => handler(message.payload))
}

export async function openLocalFile(): Promise<string | null> {
  if (!isTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const picked = await open({ multiple: false, directory: false })
  return typeof picked === 'string' ? picked : null
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null
  const { save } = await import('@tauri-apps/plugin-dialog')
  return (await save({ defaultPath: defaultName })) ?? null
}

export function errorText(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  return '操作失败，请稍后重试'
}

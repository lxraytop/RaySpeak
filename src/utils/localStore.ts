/**
 * 本地持久化：头像缓存与联系人目录。
 *
 * 目的：
 * - 头像只在协议层下载一次，之后即便对方离线、或重启应用，也能立刻显示；
 * - 记录见过的联系人（昵称 / 头像 hash / 简介 / 最后所在频道），
 *   配合当前快照即可在本地判断“是否在线”，让私聊与聊天记录在没有服务器
 *   历史消息能力的前提下仍然可读。
 *
 * 所有写入都做了去抖与容量上限，避免频繁快照导致 localStorage 抖动。
 */

import type { Client } from '../types'

const AVATAR_KEY = 'rayspeak.avatars.v1'
const CONTACT_KEY = 'rayspeak.contacts.v1'
const AVATAR_LIMIT = 48
const AVATAR_MAX_CHARS = 190_000
const CONTACT_LIMIT = 500
const CONTACT_TTL = 1000 * 60 * 60 * 24 * 60

export interface ContactRecord {
  id: string
  name: string
  avatarHash?: string
  description?: string
  channelId?: string
  lastSeen: number
}

interface AvatarEntry {
  hash: string
  url: string
  at: number
}

type AvatarMap = Record<string, AvatarEntry>
type ContactMap = Record<string, ContactRecord>

let avatars: AvatarMap | null = null
let contacts: ContactMap | null = null
let avatarTimer: number | undefined
let contactTimer: number | undefined

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

function persist(key: string, value: unknown, trim: () => void) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 配额不足时丢弃一半旧数据后重试一次
    trim()
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      /* 仍然失败则放弃本次写入，内存中的缓存继续有效 */
    }
  }
}

function flushAvatars() {
  avatarTimer = undefined
  if (!avatars) return
  persist(AVATAR_KEY, avatars, () => {
    const entries = Object.entries(avatars ?? {}).sort((a, b) => a[1].at - b[1].at)
    const drop = Math.ceil(entries.length / 2)
    for (const [uid] of entries.slice(0, drop)) delete avatars![uid]
  })
}

function flushContacts() {
  contactTimer = undefined
  if (!contacts) return
  persist(CONTACT_KEY, contacts, () => {
    const entries = Object.entries(contacts ?? {}).sort(
      (a, b) => a[1].lastSeen - b[1].lastSeen,
    )
    const drop = Math.ceil(entries.length / 2)
    for (const [id] of entries.slice(0, drop)) delete contacts![id]
  })
}

function scheduleAvatarFlush() {
  if (avatarTimer || typeof window === 'undefined') return
  avatarTimer = window.setTimeout(flushAvatars, 1200)
}

function scheduleContactFlush() {
  if (contactTimer || typeof window === 'undefined') return
  contactTimer = window.setTimeout(flushContacts, 1500)
}

function avatarMap(): AvatarMap {
  if (!avatars) {
    avatars = read<AvatarMap>(AVATAR_KEY, {})
    for (const [uid, entry] of Object.entries(avatars)) {
      if (!entry || typeof entry.url !== 'string' || !entry.url.startsWith('data:image/')) {
        delete avatars[uid]
      }
    }
  }
  return avatars
}

function contactMap(): ContactMap {
  if (!contacts) {
    contacts = read<ContactMap>(CONTACT_KEY, {})
    const now = Date.now()
    for (const [id, record] of Object.entries(contacts)) {
      if (!record || typeof record.id !== 'string' || !record.id) {
        delete contacts[id]
      } else if (now - (record.lastSeen ?? 0) > CONTACT_TTL) {
        delete contacts[id]
      }
    }
  }
  return contacts
}

/** 读取缓存头像；hash 不匹配时视为已更换头像，返回空。 */
export function getCachedAvatar(uid: string | undefined, hash: string | undefined) {
  if (!uid || !hash) return undefined
  const entry = avatarMap()[uid]
  if (!entry || entry.hash !== hash) return undefined
  return entry.url
}

/** 缓存头像 data URL，超过上限时按最久未使用淘汰。 */
export function cacheAvatar(uid: string | undefined, hash: string | undefined, url: string) {
  if (!uid || !hash || !url.startsWith('data:image/')) return
  if (url.length > AVATAR_MAX_CHARS) return
  const map = avatarMap()
  map[uid] = { hash, url, at: Date.now() }
  const entries = Object.entries(map)
  if (entries.length > AVATAR_LIMIT) {
    entries
      .sort((a, b) => a[1].at - b[1].at)
      .slice(0, entries.length - AVATAR_LIMIT)
      .forEach(([id]) => delete map[id])
  }
  scheduleAvatarFlush()
}

export function dropCachedAvatar(uid: string | undefined) {
  if (!uid) return
  const map = avatarMap()
  if (map[uid]) {
    delete map[uid]
    scheduleAvatarFlush()
  }
}

/** 记录当前在线成员，供离线状态下的资料卡与私聊列表使用。 */
export function rememberClients(clients: Client[]) {
  const map = contactMap()
  const now = Date.now()
  let changed = false
  for (const client of clients) {
    if (client.self || !client.id) continue
    const previous = map[client.id]
    const next: ContactRecord = {
      id: client.id,
      name: client.name,
      avatarHash: client.avatarHash ?? previous?.avatarHash,
      description: client.description || previous?.description,
      channelId: client.channelId || previous?.channelId,
      lastSeen: now,
    }
    if (
      previous &&
      previous.name === next.name &&
      previous.avatarHash === next.avatarHash &&
      previous.description === next.description &&
      previous.channelId === next.channelId
    ) {
      previous.lastSeen = now
      continue
    }
    map[client.id] = next
    changed = true
  }
  const ids = Object.keys(map)
  if (ids.length > CONTACT_LIMIT) {
    ids
      .sort((a, b) => map[a].lastSeen - map[b].lastSeen)
      .slice(0, ids.length - CONTACT_LIMIT)
      .forEach((id) => delete map[id])
    changed = true
  }
  if (changed) scheduleContactFlush()
}

export function getContact(id: string): ContactRecord | undefined {
  return contactMap()[id]
}

export function listContacts(): ContactRecord[] {
  return Object.values(contactMap()).sort((a, b) => b.lastSeen - a.lastSeen)
}

/** 清理本地缓存（头像 / 联系人目录）。 */
export function clearLocalStore() {
  avatars = {}
  contacts = {}
  try {
    localStorage.removeItem(AVATAR_KEY)
    localStorage.removeItem(CONTACT_KEY)
  } catch {
    /* storage unavailable */
  }
}

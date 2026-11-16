// 屏幕共享邀请码。
//
// 只包含「频道 + 共享 PIN + 主中继节点」：房间名与密钥仍由 Rust 按
// SERVER_ADDR + 频道 ID 本地派生，所以邀请码里没有服务器地址，也不含密钥。
// 好友必须在同一台 TeamSpeak 服务器上，导入后会切到同一频道、套用同一 PIN 与节点。

export interface ShareInvite {
  version: 1
  channelId: string
  channelName: string
  nodeId: string
  /** 自定义中继 URI（tcp/udp/ws/wss）；内置节点仍然只用 nid */
  customNode: string
  pin: string
}

const PREFIX = 'RS1.'
// 频道 ID 在真实会话里是纯数字；兼容历史/演示数据里的 c 前缀。
const CHANNEL_ID = /^c?\d{1,20}$/
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const NODE_URI = /^(tcp|udp|ws|wss):\/\/[^\s/]{3,120}$/i

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function encodeInvite(invite: ShareInvite): string {
  const custom = invite.customNode.trim()
  const payload = {
    v: 1,
    cid: invite.channelId.replace(/^c/, ''),
    cname: invite.channelName.slice(0, 64),
    nid: invite.nodeId,
    pin: invite.pin.slice(0, 32),
    ...(NODE_URI.test(custom) ? { nuri: custom.slice(0, 128) } : {}),
  }
  return PREFIX + toBase64Url(JSON.stringify(payload))
}

export function decodeInvite(raw: string): ShareInvite | null {
  const code = raw.trim()
  if (!code.startsWith(PREFIX)) return null
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fromBase64Url(code.slice(PREFIX.length)))
  } catch {
    return null
  }
  if (!parsed || parsed.v !== 1) return null
  const rawCid = typeof parsed.cid === 'string' ? parsed.cid : ''
  if (!CHANNEL_ID.test(rawCid)) return null
  const channelId = rawCid.replace(/^c/, '')
  const nodeId = typeof parsed.nid === 'string' ? parsed.nid : ''
  const customNode = typeof parsed.nuri === 'string' ? parsed.nuri : ''
  const pin = typeof parsed.pin === 'string' ? parsed.pin : ''
  return {
    version: 1,
    channelId,
    channelName: typeof parsed.cname === 'string' ? parsed.cname.slice(0, 64) : '',
    nodeId: NODE_ID.test(nodeId) ? nodeId : '',
    customNode: NODE_URI.test(customNode) ? customNode.slice(0, 128) : '',
    pin: pin.slice(0, 32),
  }
}

const INVITE_IN_TEXT = /RS1\.[A-Za-z0-9_-]{8,4096}/

/** 从一段聊天文本里找出可用的屏幕共享邀请码（没有或无效返回 null）。 */
export function findShareInvite(text: string): ShareInvite | null {
  const match = text.match(INVITE_IN_TEXT)
  return match ? decodeInvite(match[0]) : null
}

/** 展示聊天正文时把邀请码本身藏掉，避免一大串 base64 占满气泡。 */
export function stripInviteCode(text: string): string {
  return text.replace(INVITE_IN_TEXT, '').replace(/[ \t]{2,}/g, ' ').trim()
}

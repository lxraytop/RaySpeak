import type { CSSProperties, ReactNode } from 'react'

const SPACER_RE = /^\[(c|r|l|\*)?spacer\d*\](.*)$/i
const TAG_RE = /\[(\/?)(b|i|u|color|size|url)(?:=([^\]]+))?\]/gi

export interface ParsedChannelName {
  spacer: boolean
  align: 'left' | 'center' | 'right'
  text: string
  raw: string
}

export function parseChannelName(raw: string): ParsedChannelName {
  const match = raw.match(SPACER_RE)
  if (match) {
    const tag = (match[1] ?? '').toLowerCase()
    return {
      spacer: true,
      align: tag === 'c' ? 'center' : tag === 'r' ? 'right' : 'left',
      text: match[2] ?? '',
      raw,
    }
  }
  return { spacer: false, align: 'left', text: raw, raw }
}

export function stripTsTags(raw: string) {
  const parsed = parseChannelName(raw)
  return parsed.text.replace(TAG_RE, '')
}

export function stripClientTags(raw: string) {
  return raw.replace(TAG_RE, '')
}

interface TsStyle {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
  size?: number
  url?: string
}

const isColor = (value: string) =>
  /^#[0-9a-f]{3,8}$/i.test(value) ||
  /^rgb(a)?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}/i.test(value)

const isSafeUrl = (value: string) => /^https?:\/\//i.test(value)

export function renderTsText(raw: string): ReactNode {
  const input = parseChannelName(raw).text
  const parts: ReactNode[] = []
  let state: TsStyle = {}
  const stack: TsStyle[] = []
  let lastIndex = 0
  let key = 0

  const pushText = (text: string) => {
    if (!text) return
    const style: CSSProperties = {}
    if (state.bold) style.fontWeight = 700
    if (state.italic) style.fontStyle = 'italic'
    if (state.underline) style.textDecoration = 'underline'
    if (state.color) style.color = state.color
    if (state.size) style.fontSize = `${state.size}px`
    const content = state.url ? (
      <a href={state.url} target="_blank" rel="noreferrer" className="ts-link">
        {text}
      </a>
    ) : (
      text
    )
    if (Object.keys(style).length > 0) {
      parts.push(
        <span key={`ts-${key++}`} style={style}>
          {content}
        </span>,
      )
    } else {
      parts.push(content)
    }
  }

  for (const match of input.matchAll(TAG_RE)) {
    const index = match.index ?? 0
    pushText(input.slice(lastIndex, index))
    lastIndex = index + match[0].length
    const closing = match[1] === '/'
    const tag = match[2].toLowerCase()
    const value = match[3] ?? ''

    if (!closing) {
      stack.push(state)
      const next: TsStyle = { ...state }
      if (tag === 'b') next.bold = true
      else if (tag === 'i') next.italic = true
      else if (tag === 'u') next.underline = true
      else if (tag === 'color' && isColor(value)) next.color = value
      else if (tag === 'size') {
        const size = Number(value)
        if (Number.isFinite(size)) next.size = Math.min(30, Math.max(9, size))
      } else if (tag === 'url' && isSafeUrl(value)) next.url = value
      state = next
    } else {
      state = stack.pop() ?? {}
    }
  }
  pushText(input.slice(lastIndex))
  return <>{parts}</>
}

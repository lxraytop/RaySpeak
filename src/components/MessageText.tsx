const RAY_LINK_RE = /(ray:\/\/[^\s<>"']+)/gi

export function parseRayLink(raw: string) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'ray:') return null
    const action = url.hostname.toLowerCase()
    const channelId = url.pathname.split('/').filter(Boolean)[0]
    if (action !== 'join' || !channelId) return null
    return {
      channelId,
      name: url.searchParams.get('name') ?? undefined,
    }
  } catch {
    return null
  }
}

export function rayInviteLink(channelId: string, channelName: string) {
  return `ray://join/${encodeURIComponent(channelId)}?name=${encodeURIComponent(channelName)}`
}

export function openRayLink(url: string) {
  window.dispatchEvent(new CustomEvent('rayspeak:deep-link', { detail: url }))
}

export function MessageText({ text }: { text: string }) {
  const parts = text.split(RAY_LINK_RE)
  return (
    <>
      {parts.map((part, index) => {
        if (!part.toLowerCase().startsWith('ray://')) return part
        const parsed = parseRayLink(part)
        return (
          <a
            key={`${index}-${part}`}
            className="ray-link"
            href={part}
            onClick={(event) => {
              event.preventDefault()
              openRayLink(part)
            }}
          >
            {parsed ? `加入频道${parsed.name ? ` · ${parsed.name}` : ''}` : part}
          </a>
        )
      })}
    </>
  )
}

const svgIcon = (bg: string, paths: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="10" fill="${bg}"/><g fill="none" stroke="#ffffff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

export const channelIconUrls: Record<string, string> = {
  '501': svgIcon(
    '#3d6bf5',
    '<rect x="12" y="6" width="8" height="13" rx="4"/><path d="M8.5 15.5a7.5 7.5 0 0 0 15 0"/><path d="M16 23v3.5"/>',
  ),
  '502': svgIcon(
    '#7c5cf6',
    '<rect x="4.5" y="9.5" width="23" height="13.5" rx="6.5"/><path d="M11 13.5v5M8.5 16h5"/><circle cx="21" cy="14.8" r="1.4" fill="#ffffff" stroke="none"/><circle cx="23.4" cy="18" r="1.4" fill="#ffffff" stroke="none"/>',
  ),
  '503': svgIcon(
    '#f59e0b',
    '<circle cx="12" cy="12" r="3.6"/><path d="M5.5 23.5c.6-3.7 3.2-5.7 6.5-5.7s5.9 2 6.5 5.7"/><circle cx="22" cy="13" r="2.6"/><path d="M21 19.8c3.2-.3 5 1.8 5.5 4.2"/>',
  ),
  '504': svgIcon(
    '#ef4444',
    '<path d="M10 7h12v5a6 6 0 0 1-12 0V7Z"/><path d="M10 9H7.5a3 3 0 0 0 3 4.5M22 9h2.5a3 3 0 0 1-3 4.5"/><path d="M16 18v4M12.5 25.5h7"/>',
  ),
  '505': svgIcon(
    '#0ea5e9',
    '<rect x="6.5" y="8" width="19" height="17" rx="4"/><path d="M6.5 13h19M11 6v4M21 6v4"/><circle cx="12" cy="18" r="1.3" fill="#ffffff" stroke="none"/><circle cx="17" cy="18" r="1.3" fill="#ffffff" stroke="none"/>',
  ),
  '506': svgIcon(
    '#64748b',
    '<path d="M23 19.5A8.2 8.2 0 0 1 12.3 9 8.6 8.6 0 1 0 23 19.5Z"/>',
  ),
  '507': svgIcon(
    '#10b981',
    '<path d="M6 15.5 16 7l10 8.5"/><path d="M9 14v10.5h14V14"/><path d="M14 24.5v-5h4v5"/>',
  ),
  '508': svgIcon(
    '#14b8a6',
    '<path d="M16 5.5 26 9v7c0 5.5-4.2 8.8-10 10.5C10.2 24.8 6 21.5 6 16V9l10-3.5Z"/><path d="m12 15.5 3 3 5-5.5"/>',
  ),
}

const liveIconUrls = new Map<string, string>()

export function registerChannelIcon(iconId: string, url: string) {
  liveIconUrls.set(iconId, url)
}

export function channelIconUrl(iconId?: string) {
  if (!iconId) return ''
  return liveIconUrls.get(iconId) ?? channelIconUrls[iconId] ?? ''
}

const liveGroupIconUrls = new Map<string, string>()

export function registerGroupIcon(groupId: string, url: string) {
  liveGroupIconUrls.set(groupId, url)
}

export function groupIconUrl(groupId?: string) {
  if (!groupId) return ''
  return liveGroupIconUrls.get(groupId) ?? ''
}

import type { CSSProperties } from 'react'

interface AvatarProps {
  letter: string
  hue: number
  size?: number
  className?: string
  src?: string
}

export function Avatar({ letter, hue, size = 40, className = '', src }: AvatarProps) {
  const style = {
    '--h': hue,
    width: size,
    height: size,
    fontSize: Math.max(11, Math.round(size * 0.36)),
  } as CSSProperties

  return (
    <span
      className={`avatar ${src ? 'has-image' : ''} ${className}`}
      style={style}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" draggable={false} /> : letter}
    </span>
  )
}

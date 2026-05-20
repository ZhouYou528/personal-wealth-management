interface SparklineProps {
  data: number[]
  width?: number
  height?: number
  positive?: boolean
}

export function Sparkline({ data, width = 60, height = 24, positive }: SparklineProps) {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1

  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width
    const y = height - ((v - min) / range) * height
    return `${x},${y}`
  })

  const isPositive = positive ?? data[data.length - 1] >= data[0]
  const color = isPositive ? '#10B981' : '#EF4444'

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none">
      <polyline
        points={pts.join(' ')}
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}

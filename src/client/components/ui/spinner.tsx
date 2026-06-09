type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg'

const SIZES: Record<SpinnerSize, { px: number; stroke: number }> = {
  xs: { px: 14, stroke: 1.5 },
  sm: { px: 20, stroke: 2 },
  md: { px: 32, stroke: 2.5 },
  lg: { px: 44, stroke: 3 },
}

export function Spinner({ size = 'md', className = '' }: { size?: SpinnerSize; className?: string }) {
  const { px, stroke } = SIZES[size]
  return (
    <div
      role="status"
      aria-label="Loading"
      className={`animate-spin flex-shrink-0 ${className}`}
      style={{
        width: px,
        height: px,
        borderRadius: '50%',
        // Conic gradient: transparent tail fading into solid accent at the head
        background: `conic-gradient(from 0deg, hsl(var(--accent) / 0) 0%, hsl(var(--accent)) 100%)`,
        WebkitMask: `radial-gradient(farthest-side, transparent calc(100% - ${stroke}px), #000 calc(100% - ${stroke}px))`,
        mask: `radial-gradient(farthest-side, transparent calc(100% - ${stroke}px), #000 calc(100% - ${stroke}px))`,
      }}
    />
  )
}

/** Full-page centered loading state for early-return cases */
export function PageLoader() {
  return (
    <div className="loader-fade flex flex-col items-center justify-center py-32">
      <div className="relative">
        <Spinner size="lg" />
        {/* Soft glow halo behind the spinner */}
        <div
          className="absolute inset-0 rounded-full blur-xl opacity-30 pointer-events-none"
          style={{ background: 'hsl(var(--accent))', transform: 'scale(0.65)' }}
        />
      </div>
    </div>
  )
}

/** Inline loading state for list / card areas */
export function ListLoader() {
  return (
    <div className="loader-fade flex justify-center items-center py-12">
      <Spinner size="md" />
    </div>
  )
}

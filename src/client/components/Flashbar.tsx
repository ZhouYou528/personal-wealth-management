import { useEffect, useRef } from 'react'
import { X, AlertCircle } from 'lucide-react'
import { useErrorStore, type FlashError } from '@/lib/errors'

const AUTO_DISMISS_MS = 8000

function Flash({ err, onDismiss }: { err: FlashError; onDismiss: () => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    timerRef.current = setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [onDismiss])

  return (
    <div
      className="flex items-start gap-3 px-4 py-3 rounded-lg shadow-lg border
        bg-red-50 border-red-200 text-red-900
        dark:bg-red-950/90 dark:border-red-800/60 dark:text-red-100
        animate-in slide-in-from-right-4 fade-in duration-200"
      style={{ maxWidth: 380, minWidth: 280 }}
      role="alert"
    >
      <AlertCircle size={16} className="flex-shrink-0 mt-0.5 text-red-500 dark:text-red-400" />
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium leading-snug">{err.message}</p>
        {err.detail && (
          <p className="text-[11.5px] mt-0.5 opacity-70 truncate">{err.detail}</p>
        )}
      </div>
      <button
        onClick={onDismiss}
        className="flex-shrink-0 -mt-0.5 -mr-1 p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
        aria-label="Dismiss"
      >
        <X size={13} />
      </button>
    </div>
  )
}

export function Flashbar() {
  const { errors, dismissError } = useErrorStore()

  if (errors.length === 0) return null

  return (
    <div className="fixed top-14 right-4 z-[100] flex flex-col gap-2 pointer-events-none">
      {errors.map((err) => (
        <div key={err.id} className="pointer-events-auto">
          <Flash err={err} onDismiss={() => dismissError(err.id)} />
        </div>
      ))}
    </div>
  )
}

import { useEffect, useRef, useState } from 'react'
import type { Quote } from '@shared/types'
import { market } from '@/lib/api'

/** Polls /api/market/quotes for the given symbols every 60 seconds. */
export function useQuotes(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({})
  const [status, setStatus] = useState<'idle' | 'live' | 'error'>('idle')
  const symbolsKey = symbols.slice().sort().join(',')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (!symbolsKey) return

    async function refresh() {
      try {
        const { quotes: q } = await market.quotes(symbolsKey.split(','))
        setQuotes((prev) => ({ ...prev, ...q }))
        setStatus('live')
      } catch {
        setStatus('error')
      }
    }

    refresh()
    timerRef.current = setInterval(refresh, 60_000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [symbolsKey])

  return { quotes, status }
}

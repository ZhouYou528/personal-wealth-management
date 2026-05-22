import { useQuery } from '@tanstack/react-query'
import { useCallback } from 'react'
import { fx as fxApi } from './api'
import { useStore } from './store'

/**
 * Centralized money formatting that respects the user's display currency.
 *
 *   const { fmt, currency, rate } = useMoney()
 *   <p>{fmt(value)}</p>            // formatted with currency conversion applied
 *   <p>{fmt(value, { compact })}</p>
 *
 * `value` is expected to be in USD (the system's storage currency for now).
 * If/when we add multi-currency transactions, the caller will need to convert
 * to USD before passing in — or this hook gets a per-call `from` arg.
 */
export function useMoney() {
  const currency = useStore(s => s.currency)
  const { data: fxRates } = useQuery({
    queryKey: ['fx', 'USD'],
    queryFn: () => fxApi.rates('USD'),
    staleTime: 60 * 60 * 1000,     // 1 hour — matches the server-side KV TTL
    refetchOnWindowFocus: false,
  })
  const rate = fxRates?.rates?.[currency] ?? 1

  const fmt = useCallback((value: number): string => {
    const converted = value * rate
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(converted)
  }, [rate, currency])

  // Compact like "$220.7K" / "$1.2M" — used in the donut and condensed legends.
  const fmtCompact = useCallback((value: number): string => {
    const v = value * rate
    if (Math.abs(v) < 1000) return fmt(value)
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(v)
  }, [rate, currency, fmt])

  return { fmt, fmtCompact, currency, rate }
}

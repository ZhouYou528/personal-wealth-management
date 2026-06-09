import { useState } from 'react'
import { Lock } from 'lucide-react'
import { Button } from './ui/button'
import { useStore } from '@/lib/store'

export function LoginGate() {
  const [value, setValue] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { setApiSecret } = useStore()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const key = value.trim()
    if (!key) return

    setLoading(true)
    setError('')

    try {
      const res = await fetch('/api/accounts', {
        headers: { Authorization: `Bearer ${key}` },
      })

      if (res.status === 401) {
        setError('Invalid access key. Please try again.')
        setLoading(false)
        return
      }

      if (res.ok) {
        setApiSecret(key)
        return
      }

      setError('Unexpected error — please try again.')
    } catch {
      setError('Connection error.')
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-[340px]">
        <div className="text-center mb-8">
          <span className="font-display text-[34px] text-text italic tracking-tight">Meridian</span>
          <p className="text-text-3 text-[13px] mt-0.5">Personal Wealth</p>
        </div>

        <div className="bg-surface rounded-xl border border-border p-6 shadow-md">
          <div className="flex items-center gap-2 mb-4">
            <Lock size={14} className="text-text-3" />
            <span className="text-[13px] font-medium text-text-2">Enter your access key</span>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <input
              type="password"
              className="field-input"
              placeholder="Access key"
              value={value}
              onChange={e => { setValue(e.target.value); setError('') }}
              autoFocus
              autoComplete="current-password"
            />

            {error && (
              <p className="text-[12px] text-down">{error}</p>
            )}

            <Button
              type="submit"
              className="w-full"
              disabled={!value.trim() || loading}
            >
              {loading ? 'Verifying…' : 'Unlock'}
            </Button>
          </form>
        </div>

        <p className="text-center text-[11px] text-text-3 mt-4">
          Set your access key with{' '}
          <code className="font-mono text-text-2">wrangler secret put APP_SECRET</code>
        </p>
      </div>
    </div>
  )
}

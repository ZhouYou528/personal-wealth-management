import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Transaction } from '@shared/types'

interface UIStore {
  // API auth secret (stored in localStorage, entered once at login)
  apiSecret: string | null
  setApiSecret: (s: string | null) => void

  // Account filter — null = all accounts
  selectedAccountId: string | null
  setSelectedAccountId: (id: string | null) => void

  // Privacy mode
  privacyMode: boolean
  togglePrivacy: () => void

  // Dark mode
  darkMode: boolean
  toggleDarkMode: () => void

  // Accent colour
  accent: 'emerald' | 'sapphire' | 'violet' | 'amber' | 'pink'
  setAccent: (a: UIStore['accent']) => void

  // Display currency
  currency: string
  setCurrency: (c: string) => void

  // Add/edit transaction modal
  addTxOpen: boolean
  addTxPrefill: {
    symbol?: string
    accountId?: string
    type?: string
    // Option prefill — when set, hides the option-fields block in the modal
    optionType?: 'call' | 'put'
    strike?: string
    expiry?: string
    qty?: string
    hideOptionFields?: boolean
  } | null
  editTx: Transaction | null
  openAddTx: (prefill?: UIStore['addTxPrefill']) => void
  openEditTx: (tx: Transaction) => void
  closeAddTx: () => void

  // Mobile nav drawer
  mobileNavOpen: boolean
  setMobileNavOpen: (open: boolean) => void
}

export const useStore = create<UIStore>()(
  persist(
    (set) => ({
      apiSecret: null,
      setApiSecret: (apiSecret) => set({ apiSecret }),

      selectedAccountId: null,
      setSelectedAccountId: (id) => set({ selectedAccountId: id }),

      privacyMode: false,
      togglePrivacy: () => set((s) => ({ privacyMode: !s.privacyMode })),

      darkMode: false,
      toggleDarkMode: () => set((s) => {
        const next = !s.darkMode
        document.documentElement.classList.toggle('dark', next)
        return { darkMode: next }
      }),

      accent: 'emerald',
      setAccent: (accent) => set(() => {
        document.documentElement.dataset.accent = accent === 'emerald' ? '' : accent
        return { accent }
      }),

      currency: 'USD',
      setCurrency: (currency) => set({ currency }),

      addTxOpen: false,
      addTxPrefill: null,
      editTx: null,
      openAddTx: (prefill = null) => set({ addTxOpen: true, addTxPrefill: prefill, editTx: null }),
      openEditTx: (tx) => set({ addTxOpen: true, addTxPrefill: null, editTx: tx }),
      closeAddTx: () => set({ addTxOpen: false, addTxPrefill: null, editTx: null }),

      mobileNavOpen: false,
      setMobileNavOpen: (mobileNavOpen) => set({ mobileNavOpen }),
    }),
    {
      name: 'meridian-ui',
      partialize: (s: UIStore) => ({
        apiSecret: s.apiSecret,
        darkMode: s.darkMode,
        accent: s.accent,
        currency: s.currency,
        privacyMode: s.privacyMode,
      }),
    }
  )
)

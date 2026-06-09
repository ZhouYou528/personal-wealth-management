import { create } from 'zustand'

export interface FlashError {
  id: string
  message: string
  detail?: string
}

interface ErrorStore {
  errors: FlashError[]
  pushError: (message: string, detail?: string) => void
  dismissError: (id: string) => void
}

export const useErrorStore = create<ErrorStore>((set) => ({
  errors: [],
  pushError: (message, detail) =>
    set((s) => ({ errors: [...s.errors, { id: crypto.randomUUID(), message, detail }] })),
  dismissError: (id) =>
    set((s) => ({ errors: s.errors.filter((e) => e.id !== id) })),
}))

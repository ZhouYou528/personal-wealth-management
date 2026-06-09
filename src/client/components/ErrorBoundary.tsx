import { Component, type ErrorInfo, type ReactNode } from 'react'
import { useErrorStore } from '@/lib/errors'

interface Props { children: ReactNode }
interface State { hasError: boolean }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    const detail = info.componentStack?.split('\n')[1]?.trim()
    useErrorStore.getState().pushError(
      error.message || 'An unexpected error occurred',
      detail
    )
    // Reset so the tree can try to re-render on next navigation
    this.setState({ hasError: false })
  }

  render() {
    return this.props.children
  }
}

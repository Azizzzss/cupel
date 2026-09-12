import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error?: Error
}

/**
 * A page that fails says so, in a panel, with a way out.
 *
 * Without this a thrown error unmounts the whole tree, and a reader who opened
 * a block that a client answered strangely gets a blank page and no idea why.
 * The strip and the rest of the page keep running; only what threw is
 * replaced.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <section className="panel">
        <div className="panel-head">
          <h2>This page failed</h2>
        </div>
        <div className="panel-body">
          <pre className="wire">{error.message}</pre>
          <p className="panel-note" style={{ margin: 0 }}>
            The rest of the control room is unaffected.{' '}
            <a className="plain" href="#/">
              Back to the overview
            </a>
            .
          </p>
        </div>
      </section>
    )
  }
}

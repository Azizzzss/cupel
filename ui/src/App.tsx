import { Overview } from './pages/Overview'
import { ErrorBoundary } from './shell/ErrorBoundary'
import { ChainProvider } from './store/ChainProvider'

export default function App() {
  return (
    <ChainProvider>
      <div className="app">
        <ErrorBoundary>
          <Overview />
        </ErrorBoundary>
      </div>
    </ChainProvider>
  )
}

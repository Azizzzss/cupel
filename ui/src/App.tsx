import { Shell } from './shell/Shell'
import { ChainProvider } from './store/ChainProvider'

export default function App() {
  return (
    <ChainProvider>
      <Shell />
    </ChainProvider>
  )
}

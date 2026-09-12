import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './styles.css'
import { applyTheme, storedTheme } from './theme'

// Before the first paint, so a remembered dark page never flashes light.
applyTheme(storedTheme(), document.documentElement)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

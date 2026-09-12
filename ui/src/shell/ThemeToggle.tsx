import { useTheme, type Theme } from '../theme'

const CHOICES: Theme[] = ['light', 'system', 'dark']

/** Light, dark, or whatever the system says — remembered. */
export function ThemeToggle() {
  const [theme, choose] = useTheme()
  return (
    <span className="segmented" role="group" aria-label="theme">
      {CHOICES.map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={theme === choice}
          onClick={() => choose(choice)}
        >
          {choice}
        </button>
      ))}
    </span>
  )
}

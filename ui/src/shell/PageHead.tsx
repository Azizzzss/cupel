import type { ReactNode } from 'react'

/** A page's title and the sentence under it. */
export function PageHead({ title, lede }: { title: string; lede?: ReactNode }) {
  return (
    <header className="page-head stack" style={{ gap: '0.3rem' }}>
      <h1>{title}</h1>
      {lede && (
        <p className="dim" style={{ margin: 0, fontSize: '0.9rem' }}>
          {lede}
        </p>
      )}
    </header>
  )
}

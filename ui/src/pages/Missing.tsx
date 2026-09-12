import { PageHead } from '../shell/PageHead'

/** A hash nothing lives at. */
export function Missing({ hash }: { hash: string }) {
  return (
    <>
      <PageHead title="Nothing lives here" />
      <section className="panel">
        <div className="panel-body">
          <p className="dim" style={{ margin: 0 }}>
            There is no page at <span className="mono">{hash || '(empty)'}</span>.{' '}
            <a className="plain" href="#/">
              Back to the overview
            </a>
            .
          </p>
        </div>
      </section>
    </>
  )
}

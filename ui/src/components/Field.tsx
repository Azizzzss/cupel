/** A label, a value, and a word about it, on one line. */
export function Field({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <span className="row" style={{ gap: '0.5rem' }}>
        {note && <span className="panel-note">{note}</span>}
        <span className="field-value">{value}</span>
      </span>
    </div>
  )
}

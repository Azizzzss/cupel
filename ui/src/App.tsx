import { LAB, NETWORK, chainId, detectMode, type Mode } from './api/chain'
import { Agreement } from './components/Agreement'
import { BlockFeed } from './components/BlockFeed'
import { Gateway } from './components/Gateway'
import { SlotClock } from './components/SlotClock'
import { usePoll } from './usePoll'

export default function App() {
  // Which mode is running is itself polled, so bringing a devnet up in another
  // terminal changes this page without anybody reloading it.
  const { data: mode, loading } = usePoll(detectMode, 4000, [])

  return (
    <div className="app">
      <Header mode={mode ?? 'none'} loading={loading} />
      {mode === 'network' && <NetworkView />}
      {mode === 'lab' && <LabView />}
      {mode === 'none' && !loading && <Nothing />}
    </div>
  )
}

function Header({ mode, loading }: { mode: Mode; loading: boolean }) {
  const { data: id } = usePoll(
    () => chainId(mode === 'network' ? NETWORK[0].rpc : LAB[0].rpc),
    10_000,
    [mode],
  )

  const label =
    mode === 'network'
      ? 'network mode — nine containers, three consensus clients'
      : mode === 'lab'
        ? 'lab mode — one node, a producer on the host'
        : loading
          ? 'looking for a chain…'
          : 'no chain running'

  return (
    <header className="stack" style={{ gap: '0.4rem' }}>
      <p className="eyebrow">Cupel · control room</p>
      <div className="row">
        <h1 style={{ fontSize: '1.9rem', fontWeight: 700, letterSpacing: '-0.01em' }}>
          {mode === 'none' ? 'Nothing is running' : 'Watching the chain'}
        </h1>
        <span className="spacer" />
        {id?.ok && <span className="panel-note mono">chain id {id.value}</span>}
      </div>
      <p className="dim" style={{ fontSize: '0.9rem' }}>
        {label}
      </p>
    </header>
  )
}

function NetworkView() {
  return (
    <>
      <Agreement />
      <div className="grid grid-2">
        <SlotClock />
        <BlockFeed key={NETWORK[0].rpc} rpc={NETWORK[0].rpc} />
      </div>
      <Gateway />
    </>
  )
}

function LabView() {
  return (
    <>
      <div className="grid grid-2">
        <BlockFeed key={LAB[0].rpc} rpc={LAB[0].rpc} />
        <Gateway />
      </div>
      <section className="panel">
        <div className="panel-head">
          <h2>No consensus here, and that is the trade</h2>
        </div>
        <div className="panel-body">
          <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
            Lab mode is one execution client told what to do by a producer on
            the host: four authenticated Engine API calls, and a block. There
            are no slots, no attestations and no finality, because there is
            nobody to vote. That is what buys the eight-second start.
          </p>
          <p className="panel-note" style={{ margin: 0 }}>
            For slots, epochs, three clients and a chain that finalises, run{' '}
            <span className="mono">cupel network up</span> — this page will
            follow it without a reload.
          </p>
        </div>
      </section>
    </>
  )
}

function Nothing() {
  return (
    <section className="panel">
      <div className="panel-body">
        <p className="dim" style={{ margin: 0 }}>
          Nothing is answering on the usual ports. Start either mode and this
          page picks it up on its own:
        </p>
        <div className="stack" style={{ gap: '0.45rem', marginTop: '0.5rem' }}>
          <code className="mono glow">cupel up</code>
          <span className="panel-note">a chain in about eight seconds, one node</span>
          <code className="mono glow" style={{ marginTop: '0.4rem' }}>
            cupel network up
          </code>
          <span className="panel-note">
            nine containers, three consensus clients, finality about
            twenty-five minutes in
          </span>
        </div>
      </div>
    </section>
  )
}

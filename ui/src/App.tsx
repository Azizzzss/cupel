import {
  LAB,
  NETWORK,
  VIEWING_LOCALLY,
  chainId,
  detectMode,
  type Answer,
  type Mode,
} from './api/chain'
import { Agreement } from './components/Agreement'
import { BlockFeed } from './components/BlockFeed'
import { Gateway } from './components/Gateway'
import { SlotClock } from './components/SlotClock'
import { Walkthrough } from './components/Walkthrough'
import { usePoll } from './usePoll'

/**
 * Which mode is running, as something the poller can keep.
 *
 * The control room's own API is this origin, always: served by the binary it
 * is the same origin by construction, and under `npm run dev` or `preview`
 * Vite proxies `/api` to it. Detection itself never fails — "nothing is
 * running" is an answer, not an error.
 */
async function currentMode(): Promise<Answer<Mode>> {
  return { ok: true, value: await detectMode('') }
}

export default function App() {
  // Which mode is running is itself polled, so bringing a devnet up in another
  // terminal changes this page without anybody reloading it.
  const { value: mode, loading } = usePoll(currentMode, 4000, [])

  return (
    <div className="app">
      <Header mode={mode ?? 'none'} loading={loading} />
      <Elsewhere />
      {mode === 'network' && <NetworkView />}
      {mode === 'lab' && <LabView />}
      {mode === 'none' && !loading && <Nothing />}
    </div>
  )
}

function Header({ mode, loading }: { mode: Mode; loading: boolean }) {
  const { value: id } = usePoll(
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
        {id !== undefined && <span className="panel-note mono">chain id {id}</span>}
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
      <Gateway mode="network" />
      <NobodyInCharge />
    </>
  )
}

/**
 * Network mode's counterpart to lab mode's closing panel.
 *
 * Lab mode ends by saying what it gave up to start in eight seconds. This ends
 * by saying what replaced the thing lab mode has: there is no producer here to
 * ask for a block, so there is no button, and the reason is the interesting
 * part rather than an apology for a missing control.
 */
function NobodyInCharge() {
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Nobody here is asked to make a block</h2>
      </div>
      <div className="panel-body">
        <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
          In lab mode a producer on the host asks one client for a block, four
          authenticated calls at a time, and the control room there has a
          button that runs that sequence. There is no such caller here. Sixty-four validators split
          across these three nodes propose and attest on a schedule nobody
          controls, and the chain above is whatever they agreed on — which is
          why it can stop finalising, and why that is worth watching.
        </p>
        <p className="panel-note" style={{ margin: 0 }}>
          For the machinery underneath, run{' '}
          <span className="mono">cupel lab 3</span> for slots, epochs and
          finality, or <span className="mono">cupel lab 4</span> for what each
          of the three clients believes.
        </p>
      </div>
    </section>
  )
}

function LabView() {
  return (
    <>
      <div className="grid grid-2">
        <BlockFeed key={LAB[0].rpc} rpc={LAB[0].rpc} />
        <Gateway mode="lab" />
      </div>
      <Walkthrough />
      <section className="panel">
        <div className="panel-head">
          <h2>No consensus here, and that is the trade</h2>
        </div>
        <div className="panel-body">
          <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
            Lab mode is one execution client told what to do by a producer on
            the host: four authenticated Engine API calls, and a block. There
            are no slots and no attestations, because there is nobody to vote —
            and no finality in the sense network mode means it. Geth will still
            call every block finalised, because the producer names each one
            safe and finalised the moment it makes it: the only answer
            available when a single party decides. That is what buys the
            eight-second start.
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

/**
 * Said out loud when this page is opened from another machine.
 *
 * The gateway and this page follow `--bind`, so they can be reached from
 * elsewhere. The clients cannot: Docker publishes every client port on
 * 127.0.0.1. Without this, those panels sit on "not answering" with nothing to
 * say why, which reads as a broken devnet rather than a boundary.
 */
function Elsewhere() {
  if (VIEWING_LOCALLY) return null
  return (
    <section className="panel">
      <div className="panel-body">
        <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
          You are looking at this from another machine. The gateway and this
          page follow <span className="mono">--bind</span>, so they answer
          here; each client&apos;s own ports are published on 127.0.0.1 only, so
          the panels that read clients directly can only be seen on the machine
          running Cupel.
        </p>
      </div>
    </section>
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

import type { Mode } from '../api/chain'
import type { Page } from '../router'
import { PageHead } from '../shell/PageHead'

/** A page the running mode does not have, and which mode does. */
export function WrongMode({ page, mode }: { page: Page; mode: Mode }) {
  if (mode === 'none') {
    return (
      <>
        <PageHead title="Nothing is running" />
        <section className="panel">
          <div className="panel-body">
            <p className="dim" style={{ margin: 0 }}>
              This page needs a chain. Start either mode and it will fill in on its
              own: <span className="mono glow">cupel up</span> for one node in about
              eight seconds, or <span className="mono glow">cupel network up</span>{' '}
              for three consensus clients and real finality.
            </p>
          </div>
        </section>
      </>
    )
  }

  if (page === 'consensus') {
    return (
      <>
        <PageHead title="No consensus here" lede="This page reads the three consensus clients, which only network mode has." />
        <section className="panel">
          <div className="panel-body">
            <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
              Lab mode is one execution client told what to do by a producer on
              the host. There are no slots, no attestations and nobody to vote, so
              there is nothing here to agree about. Run{' '}
              <span className="mono">cupel network up</span> for Lighthouse, Prysm
              and Teku reaching finality on one chain — this page will follow it
              without a reload.
            </p>
          </div>
        </section>
      </>
    )
  }

  return (
    <>
      <PageHead title="Nobody here is asked to make a block" lede="The walkthrough asks this process to produce a block, which only lab mode's producer can do." />
      <section className="panel">
        <div className="panel-body">
          <p className="dim" style={{ margin: 0, fontSize: '0.88rem' }}>
            Sixty-four validators split across three nodes propose and attest on a
            schedule nobody controls, and a block asked for from the host would not
            join that chain — it would start another beside it. For the four
            Engine API calls that make a block, run <span className="mono">cupel up</span>{' '}
            and press the button, or <span className="mono">cupel lab 1</span> for
            the same sequence in the terminal.
          </p>
        </div>
      </section>
    </>
  )
}

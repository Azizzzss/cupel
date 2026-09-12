import { Agreement } from '../components/Agreement'
import { SlotClock } from '../components/SlotClock'
import { PageHead } from '../shell/PageHead'
import { NobodyInCharge } from './Overview'

export function Consensus() {
  return (
    <>
      <PageHead
        title="Three clients, one chain"
        lede="Lighthouse, Prysm and Teku, written by different teams in different languages, answering the same question at the same moment."
      />
      <Agreement />
      <div className="grid grid-2">
        <SlotClock />
        <NobodyInCharge />
      </div>
    </>
  )
}

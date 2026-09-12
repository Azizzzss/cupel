import { Walkthrough } from '../components/Walkthrough'
import { PageHead } from '../shell/PageHead'

export function WalkthroughPage() {
  return (
    <>
      <PageHead
        title="Make a block, and watch what it took"
        lede="The four Engine API calls the producer makes once a second, run once for you, with everything that went over the wire."
      />
      <Walkthrough />
    </>
  )
}

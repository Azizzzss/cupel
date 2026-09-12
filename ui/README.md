# The control room

The page `cupel up` and `cupel network up` serve on `http://127.0.0.1:8544`.
React and TypeScript, built with Vite, compiled into the `cupel` binary — the
rest of the repository never needs a JavaScript toolchain to run it.

## Working on it

```bash
npm ci
npm run dev      # Vite on 5173; /api is proxied to a running cupel on 8544
npm test         # Vitest, node environment: the arithmetic, no DOM
npm run lint     # oxlint
npx tsc -b --noEmit
npm run build    # writes dist/ — commit it
```

`dist/` is committed on purpose. It is compiled into the binary with
`rust-embed`, so `cargo build` and every release target produce a working
control room with no `npm` anywhere near them — the same trade the contracts
make by committing bytecode into genesis. CI rebuilds it from source and fails
on any difference, so rebuild and commit it with every change under `src/`.

The dev server reads the clients directly, like the served page does, and
proxies `/api` to the binary; start `cupel up` or `cupel network up` first or
the mode is probed from the ports and the walkthrough button has nothing to
talk to.

## Shape

| | |
|---|---|
| `api/` | talking to the chain and to the binary: `transport` (fetch with a timeout, the two ways a request fails), `chain` (heads, beacon state, gateway health, mode probing), `execution` (blocks in full, transactions, receipts, balances, `eth_call`), `control` (`/api/mode`) |
| `lib/` | pure and tested: hex, ABI encoding and decoding, event logs, formatting, the blocks window, the agreement verdict, slot arithmetic, freshness, the known addresses, the tab title, block and transaction parsing |
| `live/` | the WebSocket `newHeads` subscription and the beacon event stream, with the frames they speak in modules of their own |
| `store/` | one provider that fetches everything, `useChain()` for everyone that reads it |
| `shell/` | the strip, the navigation, the theme switch, the error boundary |
| `pages/` | one component per route |
| `components/` | the panels the pages are made of |
| `router.ts` | hash routes — the bundle refers to its assets relatively so the binary can mount it anywhere, and a path with a second segment would resolve them under it |
| `theme.ts` | light, dark, or the system's, remembered |

Tests sit beside the modules they test, as `*.test.ts`, and `tsc -b` checks
them like everything else. They are for pure functions; the first thing that
needs a browser to be tested should be asked why.

## Rules of the house

- No runtime dependency beyond `react` and `react-dom`. Selectors and topic
  hashes are constants read off the deployed bytecode rather than computed,
  because hashing is the one thing the page carries no library for.
- Nothing is simulated. Every number comes from the chain, and `null` from a
  client is kept apart from a refusal all the way to the page: "not on this
  chain yet" and "the client would not say" are different things.
- Numbers are derived from the chain, never held as constants — the slot time
  and epoch length come from the spec endpoint, and a client that does not
  report them gets no clock rather than a guessed one. The two exceptions are
  the four development accounts and the three contract addresses in
  `lib/known.ts`, mirrored from the Rust side and checked by a Rust test.
- Every source remembers when it last succeeded. A panel keeps its numbers
  across a failed request and greys them after three intervals, saying when
  they were last true. A stopped chain must not look like a running one.
- Sockets are doorbells, not data paths. They say a block exists; the block is
  fetched over HTTP, and polling stretches while a socket is open but never
  stops.

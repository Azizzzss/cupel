#!/usr/bin/env python3
"""Emit the README's architecture diagrams, one file per theme.

GitHub serves repository SVGs through a proxy that does not reliably honour a
media query inside the file, so the documented way to be theme-aware is a
<picture> with two sources. One template here, two palettes, four files — which
also means the light and dark versions cannot drift apart.
"""
import pathlib

LIGHT = dict(ink="#1A1712", muted="#6B6459", faint="#8C8478",
             rule="#D6D0C3", surface="#F8F6F1", surface2="#E5E1D6",
             glow="#B84A15", bead="#3D5E6E", bg="none")
DARK = dict(ink="#EFEADF", muted="#9B9285", faint="#7C7469",
            rule="#332E27", surface="#1C1A17", surface2="#24211D",
            glow="#F0813E", bead="#A3BAC8", bg="none")

TWO_MODES = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980 330" width="980" height="330" role="img" aria-label="Lab mode has one geth node driven by a block producer on the host over the Engine API. Network mode has two geth nodes and a Reth node, each paired with a different consensus client, gossiping between themselves, with a bootnode for execution-layer discovery.">
  <defs>
    <marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{ink}"/></marker>
    <marker id="g" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{glow}"/></marker>
    <marker id="b" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{bead}"/></marker>
  </defs>
  <g font-family="ui-monospace, SFMono-Regular, Menlo, monospace">
    <text x="14" y="22" font-size="13" font-weight="700" fill="{ink}">LAB MODE</text>
    <text x="512" y="22" font-size="13" font-weight="700" fill="{ink}">NETWORK MODE</text>
  </g>
  <g font-family="system-ui, -apple-system, Segoe UI, sans-serif">
    <text x="14" y="40" font-size="11.5" fill="{muted}">cupel up — eight seconds, one node</text>
    <text x="512" y="40" font-size="11.5" fill="{muted}">cupel network up — nine containers</text>

    <line x1="486" y1="10" x2="486" y2="320" stroke="{rule}" stroke-width="1" stroke-dasharray="4 5"/>

    <!-- ============ lab ============ -->
    <rect x="150" y="60" width="210" height="32" rx="4" fill="none" stroke="{ink}" stroke-width="1.3"/>
    <text x="255" y="80" font-size="12" text-anchor="middle" fill="{ink}">cast · forge · MetaMask · viem</text>
    <line x1="255" y1="92" x2="255" y2="116" stroke="{ink}" stroke-width="1.3" marker-end="url(#a)"/>

    <rect x="150" y="116" width="210" height="42" rx="4" fill="{surface2}" stroke="{ink}" stroke-width="1.6"/>
    <text x="255" y="134" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}">gateway</text>
    <text x="255" y="149" font-size="11" text-anchor="middle" fill="{muted}" font-family="ui-monospace, monospace">:8545</text>
    <line x1="255" y1="158" x2="255" y2="186" stroke="{ink}" stroke-width="1.3" marker-end="url(#a)"/>

    <rect x="150" y="186" width="210" height="46" rx="4" fill="none" stroke="{ink}" stroke-width="1.6"/>
    <text x="255" y="206" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}">geth</text>
    <text x="255" y="222" font-size="11" text-anchor="middle" fill="{muted}" font-family="ui-monospace, monospace">:8546 · one container</text>

    <rect x="18" y="186" width="110" height="46" rx="4" fill="none" stroke="{glow}" stroke-width="1.6" stroke-dasharray="4 3"/>
    <text x="73" y="205" font-size="11.5" font-weight="600" text-anchor="middle" fill="{glow}">producer</text>
    <text x="73" y="220" font-size="10.5" text-anchor="middle" fill="{glow}">on the host</text>
    <line x1="128" y1="209" x2="148" y2="209" stroke="{glow}" stroke-width="1.5" marker-end="url(#g)"/>
    <text x="73" y="252" font-size="10.5" text-anchor="middle" fill="{glow}">Engine API — four</text>
    <text x="73" y="266" font-size="10.5" text-anchor="middle" fill="{glow}">authenticated calls</text>
    <text x="73" y="280" font-size="10.5" text-anchor="middle" fill="{glow}">per block</text>

    <text x="255" y="256" font-size="11" text-anchor="middle" fill="{muted}">no consensus · no peers · no finality</text>
    <text x="255" y="272" font-size="11" text-anchor="middle" fill="{muted}">nothing to sync, nothing to store</text>

    <!-- ============ network ============ -->
    <rect x="620" y="60" width="230" height="28" rx="4" fill="none" stroke="{ink}" stroke-width="1.3"/>
    <text x="735" y="78" font-size="12" text-anchor="middle" fill="{ink}">the same clients, the same code</text>
    <line x1="735" y1="88" x2="735" y2="104" stroke="{ink}" stroke-width="1.3" marker-end="url(#a)"/>

    <rect x="620" y="104" width="230" height="34" rx="4" fill="{surface2}" stroke="{ink}" stroke-width="1.6"/>
    <text x="735" y="120" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}">gateway</text>
    <text x="735" y="133" font-size="10.5" text-anchor="middle" fill="{muted}" font-family="ui-monospace, monospace">:8545 — three upstreams</text>

    <path d="M735 138 L735 150 L575 150 L575 162" fill="none" stroke="{ink}" stroke-width="1.2" marker-end="url(#a)"/>
    <path d="M735 138 L735 162" fill="none" stroke="{ink}" stroke-width="1.2" marker-end="url(#a)"/>
    <path d="M735 138 L735 150 L895 150 L895 162" fill="none" stroke="{ink}" stroke-width="1.2" marker-end="url(#a)"/>

    <g font-size="11.5" text-anchor="middle" fill="{ink}">
      <rect x="529" y="162" width="92" height="28" rx="4" fill="none" stroke="{ink}" stroke-width="1.4"/><text x="575" y="180">geth</text>
      <rect x="689" y="162" width="92" height="28" rx="4" fill="none" stroke="{ink}" stroke-width="1.4"/><text x="735" y="180">geth</text>
      <rect x="849" y="162" width="92" height="28" rx="4" fill="none" stroke="{ink}" stroke-width="1.4"/><text x="895" y="180">Reth</text>
    </g>

    <g stroke="{glow}" stroke-width="1.3">
      <line x1="575" y1="190" x2="575" y2="212" marker-end="url(#g)"/>
      <line x1="735" y1="190" x2="735" y2="212" marker-end="url(#g)"/>
      <line x1="895" y1="190" x2="895" y2="212" marker-end="url(#g)"/>
    </g>
    <text x="660" y="205" font-size="10" text-anchor="middle" fill="{glow}">Engine API</text>

    <g font-size="11.5" text-anchor="middle">
      <rect x="529" y="212" width="92" height="34" rx="4" fill="{surface2}" stroke="{bead}" stroke-width="1.6"/>
      <text x="575" y="227" font-weight="600" fill="{ink}">Lighthouse</text><text x="575" y="240" font-size="10" fill="{muted}">22 validators</text>
      <rect x="689" y="212" width="92" height="34" rx="4" fill="{surface2}" stroke="{bead}" stroke-width="1.6"/>
      <text x="735" y="227" font-weight="600" fill="{ink}">Prysm</text><text x="735" y="240" font-size="10" fill="{muted}">21 validators</text>
      <rect x="849" y="212" width="92" height="34" rx="4" fill="{surface2}" stroke="{bead}" stroke-width="1.6"/>
      <text x="895" y="227" font-weight="600" fill="{ink}">Teku</text><text x="895" y="240" font-size="10" fill="{muted}">21 validators</text>
    </g>

    <g stroke="{bead}" stroke-width="1.4">
      <line x1="575" y1="246" x2="575" y2="260"/><line x1="735" y1="246" x2="735" y2="260"/><line x1="895" y1="246" x2="895" y2="260"/>
      <path d="M621 260 L689 260" fill="none" marker-end="url(#b)" marker-start="url(#b)"/>
      <path d="M781 260 L849 260" fill="none" marker-end="url(#b)" marker-start="url(#b)"/>
    </g>
    <text x="735" y="277" font-size="10.5" text-anchor="middle" fill="{bead}">blocks and attestations, over gossip</text>

    <rect x="655" y="288" width="160" height="20" rx="10" fill="none" stroke="{faint}" stroke-width="1.2" stroke-dasharray="3 3"/>
    <text x="735" y="302" font-size="10" text-anchor="middle" fill="{muted}">bootnode — the three find each other</text>
  </g>
</svg>
"""

STARTUP = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 235" width="900" height="235" role="img" aria-label="Startup sequence: init stamps genesis with the current time and picks a free subnet; wave one starts the bootnode and node one; the control plane then reads node one's identity from its beacon API and writes it into the environment; only then does wave two start nodes two and three.">
  <defs>
    <marker id="s" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{ink}"/></marker>
    <marker id="sg" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="{glow}"/></marker>
  </defs>
  <g font-family="system-ui, -apple-system, Segoe UI, sans-serif">
    <text x="8" y="20" font-size="11.5" fill="{muted}">A consensus client finds its peers from an ENR. Node 1's ENR does not exist until node 1 does.</text>

    <rect x="8" y="46" width="176" height="76" rx="6" fill="{surface}" stroke="{ink}" stroke-width="1.5"/>
    <text x="96" y="70" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}" font-family="ui-monospace, monospace">network init</text>
    <text x="96" y="89" font-size="10.5" text-anchor="middle" fill="{muted}">genesis stamped now</text>
    <text x="96" y="104" font-size="10.5" text-anchor="middle" fill="{muted}">a free subnet chosen</text>
    <text x="96" y="119" font-size="10.5" text-anchor="middle" fill="{muted}">64 validator keys</text>
    <line x1="184" y1="84" x2="222" y2="84" stroke="{ink}" stroke-width="1.5" marker-end="url(#s)"/>

    <rect x="222" y="46" width="176" height="76" rx="6" fill="{surface}" stroke="{ink}" stroke-width="1.5"/>
    <text x="310" y="70" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}">wave one</text>
    <text x="310" y="89" font-size="10.5" text-anchor="middle" fill="{muted}">bootnode</text>
    <text x="310" y="104" font-size="10.5" text-anchor="middle" fill="{muted}">node 1 — geth, Lighthouse,</text>
    <text x="310" y="119" font-size="10.5" text-anchor="middle" fill="{muted}">its validator client</text>
    <line x1="398" y1="84" x2="436" y2="84" stroke="{ink}" stroke-width="1.5" marker-end="url(#s)"/>

    <rect x="436" y="38" width="192" height="92" rx="6" fill="{surface2}" stroke="{glow}" stroke-width="2"/>
    <text x="532" y="62" font-size="12.5" font-weight="600" text-anchor="middle" fill="{glow}">read the identity</text>
    <text x="532" y="81" font-size="10.5" text-anchor="middle" fill="{muted}">poll node 1's beacon API</text>
    <text x="532" y="96" font-size="10.5" text-anchor="middle" fill="{muted}">for its ENR and peer id</text>
    <text x="532" y="115" font-size="10" text-anchor="middle" fill="{glow}" font-family="ui-monospace, monospace">→ network.env</text>
    <line x1="628" y1="84" x2="666" y2="84" stroke="{ink}" stroke-width="1.5" marker-end="url(#s)"/>

    <rect x="666" y="46" width="176" height="76" rx="6" fill="{surface}" stroke="{ink}" stroke-width="1.5"/>
    <text x="754" y="70" font-size="12.5" font-weight="600" text-anchor="middle" fill="{ink}">wave two</text>
    <text x="754" y="89" font-size="10.5" text-anchor="middle" fill="{muted}">nodes 2 and 3 start</text>
    <text x="754" y="104" font-size="10.5" text-anchor="middle" fill="{muted}">knowing where to find</text>
    <text x="754" y="119" font-size="10.5" text-anchor="middle" fill="{muted}">node 1</text>

    <path d="M532 130 L532 162 Q532 172 542 172 L744 172 Q754 172 754 162 L754 128" fill="none" stroke="{glow}" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#sg)"/>
    <text x="643" y="192" font-size="11" text-anchor="middle" fill="{glow}">a value one container produced, that another needs in order to start</text>
    <text x="643" y="211" font-size="10.5" text-anchor="middle" fill="{muted}">no compose file can express this edge — which is most of the reason there is a control plane</text>
  </g>
</svg>
"""

out = pathlib.Path("docs/img")
out.mkdir(parents=True, exist_ok=True)
for name, template in (("two-modes", TWO_MODES), ("startup", STARTUP)):
    for theme, palette in (("light", LIGHT), ("dark", DARK)):
        path = out / f"{name}-{theme}.svg"
        path.write_text(template.format(**palette), encoding="utf-8")
        print(f"  {path}  {path.stat().st_size} bytes")

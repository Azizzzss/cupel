import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, MathUtils, type Mesh } from 'three'
import { withCommas } from '../lib/format'
import {
  busiestGas,
  cameraDistance,
  frameloopFor,
  lane,
  scaleFor,
  laneCentre,
  laneDepth,
  SPACING,
  standing,
  type Placed,
  type Standing,
} from '../lib/depth'
import { PageHead } from '../shell/PageHead'
import { useChain } from '../store/context'

/**
 * The chain, as a solid object.
 *
 * Every other page reads the chain as text. This one reads the same window of
 * blocks the Blocks page lists and gives it a shape: one box per block, running
 * away from the camera in the order they were made, standing as tall as the gas
 * they used. Nothing here is decoration — the length is the window, the heights
 * are gas, the colour is whether a block carried transactions, and in network
 * mode the markers are where each client says the head is.
 *
 * Loaded on its own, because three.js is larger than the rest of this interface
 * put together and a reader who never opens this page should not pay for it.
 */
export default function Depth() {
  const { blocks, mode, nodes } = useChain()
  const placed = useMemo(() => lane(blocks), [blocks])
  const idle = placed.length > 0 && busiestGas(blocks) === 0
  const scale = scaleFor(busiestGas(blocks))
  const palette = usePalette()
  const [supported] = useState(webglAvailable)
  const [hover, setHover] = useState<Hover | undefined>(undefined)
  const frame = useRef<HTMLDivElement>(null)
  // The frame as state as well as a ref: the visibility observer has to start
  // when it appears, which is after the first block rather than on mount.
  const [frameElement, setFrameElement] = useState<HTMLDivElement | null>(null)
  const attachFrame = useCallback((node: HTMLDivElement | null) => {
    frame.current = node
    setFrameElement(node)
  }, [])
  const reduced = usePrefersReducedMotion()
  const seen = useSeen(frameElement)
  const frameloop = frameloopFor({ ...seen, reduced })
  // Shared with the scene: the camera reads it every frame, and a click has to
  // know whether the pointer was turning the view rather than picking a block.
  const view = useRef<View>({ yaw: 0.75, pitch: 0.34, held: false, engaged: false, moved: 0 })

  const show = (block: Placed, event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation()
    const box = frame.current?.getBoundingClientRect()
    setHover({
      block,
      x: event.clientX - (box?.left ?? 0),
      y: event.clientY - (box?.top ?? 0),
    })
  }

  const open = (block: Placed) => {
    // A drag that ends on a box is somebody turning the scene, not choosing a
    // block. Without this, every attempt to look round it opens a page.
    if (view.current.moved > 4) return
    window.location.hash = `#/block/${block.number}`
  }

  const clients = nodes.map((node) => {
    const head = node.row.value?.execution
    return {
      name: node.target.name,
      consensus: node.target.consensus ?? '',
      standing: standing(placed, head?.ok ? head.value : undefined),
    }
  })

  return (
    <>
      <PageHead
        title="The chain, in depth"
        lede={
          mode === 'network'
            ? 'One box per block, as tall as the gas it used, with each client marked where it says the head is.'
            : 'One box per block, as tall as the gas it used, newest at the front. Every block here was made by the four Engine API calls.'
        }
      />

      {!supported ? (
        <section className="panel">
          <div className="panel-body">
            <span className="faint">
              this browser has no WebGL, so there is nothing to draw with — every
              number on this page is on the Blocks page as text
            </span>
          </div>
        </section>
      ) : placed.length === 0 ? (
        <section className="panel">
          <div className="panel-body">
            <span className="faint pulse">waiting for a block…</span>
          </div>
        </section>
      ) : (
        <div className="canvas-frame" ref={attachFrame} data-frameloop={frameloop}>
          <Canvas
            frameloop={frameloop}
            camera={{ position: [0, 3.4, cameraDistance(placed.length)], fov: 42 }}
            dpr={[1, 2]}
            gl={{ antialias: true }}
          >
            <color attach="background" args={[palette.bg]} />
            {/* The far end of the lane runs into the background rather than
                stopping at a visible edge: the window has a boundary, the chain
                does not. */}
            <fog
              attach="fog"
              args={[palette.bg, cameraDistance(placed.length) * 0.5, cameraDistance(placed.length) * 2.1]}
            />
            {/* Enough ambient light that the short sides of an empty block are
                lit as well as its top: with only a lamp overhead, a low slab is
                a dark shape on a dark floor and reads as a gap in the chain. */}
            <ambientLight intensity={1.05} />
            <directionalLight position={[5, 9, 7]} intensity={1.3} />
            <directionalLight position={[-7, 4, -5]} intensity={0.45} color={palette.glow} />
            <Rig
              centre={laneCentre(placed.length)}
              fit={cameraDistance(placed.length)}
              view={view}
              still={hover !== undefined}
              reduced={reduced}
            >
              <Floor palette={palette} length={laneDepth(placed.length)} />
              <Lane
                placed={placed}
                palette={palette}
                hovered={hover?.block.number}
                onShow={show}
                onHide={() => setHover(undefined)}
                onOpen={open}
              />
              {clients.map((client, index) => (
                <Marker
                  key={client.name}
                  placed={placed}
                  standing={client.standing}
                  lateral={index - (clients.length - 1) / 2}
                  palette={palette}
                  reduced={reduced}
                />
              ))}
            </Rig>
          </Canvas>
          {hover && (
            <div className="scene-tip" style={{ left: hover.x, top: hover.y }}>
              <span className="name">#{hover.block.number}</span>
              <span>
                {hover.block.transactions === 0
                  ? 'empty'
                  : `${hover.block.transactions} transaction${hover.block.transactions === 1 ? '' : 's'}`}
              </span>
              <span className="faint">{withCommas(hover.block.gasUsed)} gas</span>
              <span className="faint">click to open it</span>
            </div>
          )}
        </div>
      )}

      <section className="panel">
        <div className="panel-head">
          <h2>What you are looking at</h2>
          <span className="panel-note">drag to turn · then scroll to move closer</span>
        </div>
        <div className="panel-body">
          <ul className="plain-list">
            <li>
              <Swatch colour={palette.glow} /> a block carrying transactions
            </li>
            <li>
              <Swatch colour={palette.surface2} /> an empty block — still a block,
              still proposed on time
            </li>
            <li>
              height is gas used — a box at full height is{' '}
              <span className="mono">{withCommas(scale)}</span> gas
            </li>
            <li className="faint">
              point at a block for its number, and click to open it
            </li>
          </ul>
          {idle && (
            <p className="panel-note" style={{ marginTop: '0.8rem' }}>
              Every block in this window is empty, so every box is at its floor.
              That is worth seeing rather than hiding: the chain keeps its
              rhythm whether or not anybody uses it. Send a transaction — the
              keys are on the Accounts page — and the block that carries it
              rises.
            </p>
          )}
          {mode === 'network' && (
            <>
              <p className="panel-note" style={{ marginTop: '0.8rem' }}>
                The markers are the three clients, each floating above the block it
                calls the head.
              </p>
              <ul className="plain-list">
                {clients.map((client) => (
                  <li key={client.name}>
                    <Swatch colour={colourFor(client.standing, palette)} />
                    <span className="name">{client.name}</span>{' '}
                    <span className="faint">{client.consensus}</span> —{' '}
                    {describe(client.standing)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </>
  )
}

/** A colour chip, so the legend names a colour by showing it. */
function Swatch({ colour }: { colour: string }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: '0.7rem',
        height: '0.7rem',
        borderRadius: '2px',
        background: colour,
        marginRight: '0.45rem',
        verticalAlign: 'baseline',
      }}
    />
  )
}

function describe(where: Standing): string {
  switch (where) {
    case 'same':
      return 'on the same block, with the same hash'
    case 'different':
      return 'the same block number, a different hash — they disagree'
    case 'ahead':
      return 'ahead of this window; the feed has not caught up'
    case 'behind':
      return 'behind this window'
    case 'silent':
      return 'not answering'
  }
}

function colourFor(where: Standing, palette: Palette): string {
  switch (where) {
    case 'same':
      return palette.bead
    case 'different':
      return palette.wrong
    case 'ahead':
    case 'behind':
      return palette.litharge
    case 'silent':
      return palette.faint
  }
}

/**
 * Something for the blocks to stand on.
 *
 * Without it the lane floats in a void and the far end is unreadable — the eye
 * has nothing to measure the distance against, and an empty block on a dark
 * background is a dark shape on a dark background.
 */
function Floor({ palette, length }: { palette: Palette; length: number }) {
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} receiveShadow>
      <planeGeometry args={[6, length + 6]} />
      <meshStandardMaterial color={palette.surface2} roughness={0.95} />
    </mesh>
  )
}

/** What the pointer is over, and where on the frame to say so. */
interface Hover {
  block: Placed
  x: number
  y: number
}

/** The lane itself: one box per block, each one something to point at. */
function Lane({
  placed,
  palette,
  hovered,
  onShow,
  onHide,
  onOpen,
}: {
  placed: Placed[]
  palette: Palette
  hovered: number | undefined
  onShow: (block: Placed, event: ThreeEvent<PointerEvent>) => void
  onHide: () => void
  onOpen: (block: Placed) => void
}) {
  return (
    <group>
      {placed.map((block) => {
        const busy = block.transactions > 0
        const lit = hovered === block.number
        return (
          <group key={block.hash || block.number}>
            {/* What the pointer actually hits. A block is half a unit wide and
                an empty one a quarter of a unit tall, which at the far end of
                the lane is two or three pixels: a feature nobody can point at
                is not a feature. This stands in front of it, invisible,
                roughly a finger wide. `visible={false}` would take it out of
                the raycast as well, so it is a transparent material instead. */}
            <mesh
              position={[0, HIT_HEIGHT / 2, block.z]}
              onPointerOver={(event) => onShow(block, event)}
              onPointerOut={onHide}
              onClick={() => onOpen(block)}
            >
              <boxGeometry args={[0.9, HIT_HEIGHT, SPACING]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
            <mesh position={[0, block.height / 2, block.z]}>
              <boxGeometry args={[0.46, block.height, 0.5]} />
            {/* Grey for empty, the cupellation orange for a block that carried
                something. An empty block used to take the surface colour, which
                in the dark theme is a dark box on a dark floor. The one under
                the pointer lights up: a tooltip beside a lane of identical
                boxes leaves the reader guessing which one it is about. */}
            <meshStandardMaterial
              color={lit ? palette.bead : busy ? palette.glow : palette.faint}
              emissive={lit ? palette.bead : palette.glow}
              emissiveIntensity={lit ? 0.85 : busy ? 0.3 : 0}
              roughness={0.6}
              metalness={0.05}
              />
            </mesh>
          </group>
        )
      })}
    </group>
  )
}

/**
 * How tall the invisible hit box stands.
 *
 * Taller than most blocks on purpose: pointing somewhere above an empty slab is
 * still pointing at that block, and the alternative is asking a reader to hit a
 * shape a quarter of a unit high.
 */
const HIT_HEIGHT = 1.6

/** One client, above the block it calls the head. */
function Marker({
  placed,
  standing: where,
  lateral,
  palette,
  reduced,
}: {
  placed: Placed[]
  standing: Standing
  lateral: number
  palette: Palette
  reduced: boolean
}) {
  const mesh = useRef<Mesh>(null)
  // Ahead sits just in front of the newest block, behind at the far end: the
  // window cannot show where they actually are, and pretending otherwise would
  // put a client on a block this page never fetched.
  const front = placed[0]
  const back = placed[placed.length - 1]
  const z =
    where === 'ahead' ? SPACING : where === 'behind' ? (back?.z ?? 0) - SPACING : (front?.z ?? 0)
  const height = (front?.height ?? 0.5) + 1.1

  // The spin is the one movement in the scene nobody asked for, so it is the
  // first to go when motion is not wanted. It used to ignore the setting.
  useFrame((state) => {
    if (mesh.current && !reduced) {
      mesh.current.rotation.y = state.clock.elapsedTime * 0.6
    }
  })

  if (where === 'silent') return null
  return (
    <mesh ref={mesh} position={[lateral * 0.75, height, z]}>
      <octahedronGeometry args={[0.16]} />
      <meshStandardMaterial
        color={colourFor(where, palette)}
        emissive={colourFor(where, palette)}
        emissiveIntensity={0.6}
      />
    </mesh>
  )
}

/**
 * Turning, drifting and zooming, without a controls library.
 *
 * The camera orbits the middle of the lane; the lane itself never turns. An
 * earlier version rotated the group instead, which tilts a fifty-unit ribbon
 * about its centre like a seesaw and swings the far end out of frame — the
 * reader is trying to walk around a thing, not tip it over.
 *
 * The resting distance follows the length of the lane until the reader scrolls
 * and takes it over: a view somebody chose is not something to reset every time
 * a block arrives.
 */
function Rig({
  children,
  centre,
  fit,
  view,
  still,
  reduced,
}: {
  children: React.ReactNode
  centre: number
  fit: number
  view: React.RefObject<View>
  /** Held for a moment while the reader is reading something. */
  still: boolean
  /** No sway, and frames only on demand — see `frameloopFor`. */
  reduced: boolean
}) {
  const group = useRef<Group>(null)
  const drift = useRef(0)
  const sway = useRef(0)
  const newest = useRef<number | undefined>(undefined)
  const resting = useRef(fit)
  const { blocks } = useChain()
  const invalidate = useThree((state) => state.invalidate)

  useEffect(() => {
    resting.current = fit
  }, [fit])

  // Drag and wheel are wired by a plain function rather than a hook, so the
  // view it writes to is the ref this component owns. They ask for a frame
  // themselves: on demand, nothing else knows the view has moved.
  useEffect(() => orbitControls(view, resting, invalidate), [view, invalidate])

  // A new block glides in from the front — unless motion is not wanted, when it
  // simply appears. That is also what makes drawing on demand worth anything:
  // a lab block arrives every second and the glide takes about that long, so
  // with it the scene would be asking for a frame almost all the time.
  const top = blocks[0]?.number
  useEffect(() => {
    if (!reduced && top !== undefined && newest.current !== undefined && top > newest.current) {
      drift.current = SPACING
    }
    newest.current = top
  }, [top, reduced])

  useFrame((state, delta) => {
    const step = Math.min(delta, 0.1)
    drift.current = MathUtils.damp(drift.current, 0, 6, step)
    // Nothing moves while a block is being read: a scene that drifts on takes
    // the box out from under the pointer mid-sentence.
    if (!reduced && !view.current.held && !still) sway.current += step * SWAY_SPEED

    if (group.current) group.current.position.z = drift.current + centre

    const distance = view.current.zoom ?? resting.current
    const { pitch } = view.current
    // A gentle sweep either side of wherever the reader left it, rather than a
    // full turn. The lane is fifty blocks long and one wide: keep rotating and
    // most of the time is spent looking straight down its end, where it is a
    // single box wide and says nothing. This never leaves the useful arc.
    const yaw = view.current.yaw + (reduced ? 0 : Math.sin(sway.current) * SWAY_ARC)
    const flat = Math.cos(pitch) * distance
    const camera = state.camera
    const target = [Math.sin(yaw) * flat, TARGET_Y + Math.sin(pitch) * distance, Math.cos(yaw) * flat]
    camera.position.x = MathUtils.damp(camera.position.x, target[0], 8, step)
    camera.position.y = MathUtils.damp(camera.position.y, target[1], 8, step)
    camera.position.z = MathUtils.damp(camera.position.z, target[2], 8, step)
    camera.lookAt(0, TARGET_Y, 0)

    // Drawing on demand, one frame per change would freeze every glide at its
    // first step. Keep asking until the lane and the camera have arrived.
    const settling =
      Math.abs(drift.current) > SETTLED ||
      Math.abs(camera.position.x - target[0]) > SETTLED ||
      Math.abs(camera.position.y - target[1]) > SETTLED ||
      Math.abs(camera.position.z - target[2]) > SETTLED
    if (settling) state.invalidate()
  })

  return <group ref={group}>{children}</group>
}

/** What the camera looks at: a little above the floor, at the lane's middle. */
const TARGET_Y = 0.6

/** Radians either side of the resting angle, and how fast the sweep runs. */
const SWAY_ARC = 0.3
const SWAY_SPEED = 0.22

/** Close enough, in world units, that another frame would not move a pixel. */
const SETTLED = 0.001

interface View {
  yaw: number
  pitch: number
  /** Set once the reader scrolls; until then the distance follows the lane. */
  zoom?: number
  held: boolean
  /** Whether the reader has taken hold of the scene — see the wheel handler. */
  engaged: boolean
  /** Pixels travelled since the pointer went down, so a drag is not a click. */
  moved: number
}

/**
 * Drag to turn, scroll to move closer.
 *
 * The view lives in a ref because it changes on every pointer move and is read
 * on every frame; in state it would re-render the whole lane sixty times a
 * second to move a camera.
 */
function orbitControls(
  view: React.RefObject<View>,
  resting: React.RefObject<number>,
  invalidate: () => void,
): () => void {
  const canvas = document.querySelector('.canvas-frame canvas')
  if (!canvas) return () => {}
  let last: { x: number; y: number } | undefined

  const down = (event: Event) => {
    const pointer = event as PointerEvent
    last = { x: pointer.clientX, y: pointer.clientY }
    view.current.held = true
    view.current.engaged = true
    view.current.moved = 0
    canvas.setPointerCapture?.(pointer.pointerId)
  }
  const move = (event: Event) => {
    const pointer = event as PointerEvent
    if (!last) return
    view.current.moved += Math.abs(pointer.clientX - last.x) + Math.abs(pointer.clientY - last.y)
    view.current.yaw -= (pointer.clientX - last.x) * 0.006
    view.current.pitch = clamp(view.current.pitch + (pointer.clientY - last.y) * 0.004, 0.04, 1.2)
    last = { x: pointer.clientX, y: pointer.clientY }
    invalidate()
  }
  const up = () => {
    last = undefined
    view.current.held = false
  }
  const leave = () => {
    up()
    view.current.engaged = false
  }
  const wheel = (event: Event) => {
    // Only once the reader has taken hold of the scene. A canvas two thirds of
    // the window tall that swallows the wheel is a trap: somebody scrolling
    // down the page stops dead over it, and nothing on screen says why. Until
    // it is grabbed, the wheel belongs to the page.
    if (!view.current.engaged) return
    const scroll = event as WheelEvent
    scroll.preventDefault()
    view.current.zoom = clamp((view.current.zoom ?? resting.current) + scroll.deltaY * 0.01, 3, 90)
    invalidate()
  }

  canvas.addEventListener('pointerdown', down)
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointerleave', leave)
  canvas.addEventListener('wheel', wheel, { passive: false })
  return () => {
    canvas.removeEventListener('pointerdown', down)
    canvas.removeEventListener('pointermove', move)
    canvas.removeEventListener('pointerup', up)
    canvas.removeEventListener('pointerleave', leave)
    canvas.removeEventListener('wheel', wheel)
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

interface Palette {
  bg: string
  surface2: string
  glow: string
  bead: string
  litharge: string
  wrong: string
  faint: string
}

const FALLBACK: Palette = {
  bg: '#131110',
  surface2: '#24211d',
  glow: '#f0813e',
  bead: '#a3bac8',
  litharge: '#cba755',
  wrong: '#e8674f',
  faint: '#7c7469',
}

function readPalette(): Palette {
  if (typeof window === 'undefined') return FALLBACK
  const style = getComputedStyle(document.documentElement)
  const read = (name: keyof Palette, variable: string) =>
    style.getPropertyValue(variable).trim() || FALLBACK[name]
  return {
    bg: read('bg', '--bg'),
    surface2: read('surface2', '--surface-2'),
    glow: read('glow', '--glow'),
    bead: read('bead', '--bead'),
    litharge: read('litharge', '--litharge'),
    wrong: read('wrong', '--wrong'),
    faint: read('faint', '--faint'),
  }
}

/**
 * The palette the stylesheet is currently using.
 *
 * Read from the CSS variables rather than repeated here, so the scene is lit by
 * the same four colours as everything else and follows the theme toggle without
 * knowing the toggle exists.
 */
function usePalette(): Palette {
  const [palette, setPalette] = useState<Palette>(readPalette)
  useEffect(() => {
    const update = () => setPalette(readPalette())
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    media.addEventListener('change', update)
    return () => {
      observer.disconnect()
      media.removeEventListener('change', update)
    }
  }, [])
  return palette
}

/**
 * Whether anybody could be looking at an element: the tab in front, and the
 * element at least partly inside the viewport.
 */
function useSeen(element: HTMLElement | null): { hidden: boolean; onScreen: boolean } {
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden')
  const [onScreen, setOnScreen] = useState(true)

  useEffect(() => {
    const update = () => setHidden(document.visibilityState === 'hidden')
    document.addEventListener('visibilitychange', update)
    return () => document.removeEventListener('visibilitychange', update)
  }, [])

  useEffect(() => {
    if (!element || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1]
      if (entry) setOnScreen(entry.isIntersecting)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [element])

  return { hidden, onScreen }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return reduced
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

import { assert, assertEquals, assertMatch } from 'jsr:@std/assert@1'

import {
  act,
  addPlayer,
  advance,
  beat,
  changeRole,
  createState,
  type Hazard,
  MINUTE,
  openRole,
  rand,
  signal,
  type State,
  toView,
} from './engine.ts'

const T0 = Date.UTC(2026, 9, 7, 9, 0)

function crew(): State {
  const state = createState('DRV-TEST', 42, T0)
  addPlayer(state, { id: 'anna', tokenHash: 'a', nickname: 'Anna', role: 'ingegnere' }, T0)
  addPlayer(state, { id: 'luca', tokenHash: 'l', nickname: 'Luca', role: 'navigatore' }, T0)
  addPlayer(state, { id: 'sara', tokenHash: 's', nickname: 'Sara', role: 'tecnico' }, T0)
  return state
}

function waiting(state: State, now: number, ...ids: string[]): State {
  ids.forEach(id => beat(state, id, now))
  return state
}

function hazard(state: State, kind: Hazard['kind'], inMinutes: number, isScanned = false): Hazard {
  const h = { id: state.nextHazardId++, kind, hitsAt: state.tickAt + inMinutes * MINUTE, isScanned }
  state.hazards.push(h)
  return h
}

/** A seed whose first `minutes` spawn nothing, so a test controls every hazard. */
function quietSeed(minutes: number): number {
  for (let seed = 1; ; seed++) {
    let isQuiet = true
    for (let m = 0; m <= minutes && isQuiet; m++) {
      if (rand(seed, Math.floor(T0 / MINUTE) + m, 1) < 1 / 50) isQuiet = false
    }
    if (isQuiet) return seed
  }
}

Deno.test('systems decay and the ship moves while the reactor is up', () => {
  const state = advance(crew(), T0 + 60 * MINUTE)

  assert(state.ship.reactor < 80)
  assert(state.ship.oxygen < 90)
  assert(state.ship.distance > 1.9 && state.ship.distance <= 2.01)
})

Deno.test('replaying the same stretch of time always gives the same ship', () => {
  const a = advance(crew(), T0 + 600 * MINUTE)
  const b = advance(advance(crew(), T0 + 250 * MINUTE), T0 + 600 * MINUTE)

  assertEquals(a, b)
})

Deno.test('roles fill the emptiest one first', () => {
  const state = createState('DRV-ROLE', 1, T0)
  assertEquals(openRole(state), 'ingegnere')
  addPlayer(state, { id: 'a', tokenHash: '', nickname: 'Aa' }, T0)
  assertEquals(openRole(state), 'navigatore')
})

Deno.test('a nickname is taken once per crew', () => {
  const state = crew()
  const result = addPlayer(state, { id: 'x', tokenHash: '', nickname: 'anna' }, T0)

  assertMatch(result.error ?? '', /già/)
})

Deno.test('energy comes from waiting, one every 30 seconds, up to 10', () => {
  const state = crew()
  beat(state, 'anna', T0)
  beat(state, 'anna', T0 + 10_000)
  assertEquals(state.players[0]?.energy, 4)
  beat(state, 'anna', T0 + 30_000)
  assertEquals(state.players[0]?.energy, 5)
  for (let i = 2; i < 40; i++) beat(state, 'anna', T0 + i * 30_000)
  assertEquals(state.players[0]?.energy, 10)
})

Deno.test('nobody acts unless their Claude is working', () => {
  const state = crew()
  const result = act(state, 'anna', 'ripara_reattore', T0)

  assertMatch(result.error ?? '', /mentre il tuo Claude lavora/)
})

Deno.test('each role does its own job', () => {
  const state = waiting(crew(), T0, 'anna', 'luca')

  assertMatch(act(state, 'luca', 'ripara_reattore', T0).error ?? '', /ingegnere/)
  assertEquals(act(state, 'anna', 'ripara_reattore', T0).error, undefined)
  assertEquals(state.ship.reactor, 100)
})

Deno.test('an unscanned threat cannot be dodged; scanned, it can', () => {
  const state = createState('DRV-SCAN', quietSeed(5), T0)
  addPlayer(state, { id: 'luca', tokenHash: '', nickname: 'Luca', role: 'navigatore' }, T0)
  addPlayer(state, { id: 'sara', tokenHash: '', nickname: 'Sara', role: 'tecnico' }, T0)
  waiting(state, T0, 'luca', 'sara')
  const rocks = hazard(state, 'asteroidi', 30)

  assertMatch(act(state, 'luca', 'evita', T0, rocks.id).error ?? '', /scansionata/)
  assertEquals(toView(state, 'luca', T0)?.hazards[0]?.kind, null)
  act(state, 'sara', 'scansiona', T0)
  assertEquals(toView(state, 'luca', T0)?.hazards[0]?.kind, 'asteroidi')
  assertEquals(act(state, 'luca', 'evita', T0, rocks.id).error, undefined)
  assertEquals(state.hazards.length, 0)
})

Deno.test('shields soak an impact before the hull takes it', () => {
  const state = createState('DRV-HIT', quietSeed(10), T0)
  state.ship.shields = 50
  hazard(state, 'asteroidi', 2)
  advance(state, T0 + 3 * MINUTE)

  assertEquals(state.ship.hull, 100)
  assert(state.ship.shields < 50 - 29)
})

Deno.test('a jump needs a second crew member within the window', () => {
  const state = waiting(crew(), T0, 'anna', 'luca')
  state.players.forEach(p => (p.energy = 5))

  assertEquals(act(state, 'anna', 'salto', T0).error, undefined)
  assertMatch(act(state, 'anna', 'conferma_salto', T0 + 1000).error ?? '', /altro membro/)
  const before = state.ship.distance
  assertEquals(act(state, 'luca', 'conferma_salto', T0 + 5000).error, undefined)
  assertEquals(Math.round(state.ship.distance - before), 15)
  assertEquals(state.jump, null)
})

Deno.test('an unconfirmed jump expires', () => {
  const state = waiting(crew(), T0, 'anna')
  act(state, 'anna', 'salto', T0)
  advance(state, T0 + 25_000)

  assertEquals(state.jump, null)
  assertMatch(state.log.at(-1)?.text ?? '', /annullato/)
})

Deno.test('the view hides the seed and every token', () => {
  const view = toView(crew(), 'anna', T0)
  const text = JSON.stringify(view)

  assert(!text.includes('tokenHash') && !text.includes('seed'))
  assertEquals(view?.you.role, 'ingegnere')
})

Deno.test('signals are rate limited and roles cost energy to change', () => {
  const state = crew()
  assertEquals(signal(state, 'anna', 'serve_tecnico', T0).error, undefined)
  assertMatch(signal(state, 'anna', 'bravi', T0 + 1000).error ?? '', /aspetta/)
  assertEquals(changeRole(state, 'anna', 'tecnico', T0).error, undefined)
  assertEquals(state.players[0]?.energy, 0)
})

Deno.test('reaching the station starts the next, harder mission', () => {
  const state = waiting(crew(), T0, 'anna', 'luca')
  state.players.forEach(p => (p.energy = 5))
  state.ship.distance = 90
  act(state, 'anna', 'salto', T0)
  act(state, 'luca', 'conferma_salto', T0 + 1000)

  assertEquals(state.mission, 2)
  assertEquals(state.ship.distance, 0)
})

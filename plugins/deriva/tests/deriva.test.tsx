import type { On } from 'claude-code'
import type { MockClock } from 'claude-code/testing'
import { expect, mock, test } from 'claude-code/testing'

import type { Membership, Reply, View } from '../types'

const NOW = 1_000_000

const PANE = {
  component: 'Pane',
  requestId: 'deriva',
  props: {
    title: 'Deriva',
    isFocused: false,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const MEMBER: Membership = { code: 'DRV-TEST', playerId: 'p-sara', token: 'segreto-di-sara', nickname: 'Sara' }

const COMMAND = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const

const DONE = { answer: 'fatto', durationMs: 30_000, isAborted: false, reason: 'answer' } as const

function shipView(changes: Partial<View> = {}): View {
  return {
    code: 'DRV-TEST',
    now: NOW,
    mission: 1,
    destination: 100,
    ship: { reactor: 72, hull: 100, oxygen: 64, shields: 18, distance: 34.5, courseUntil: 0 },
    hazards: [{ id: 1, kind: null, hitsAt: NOW + 12 * 60_000 }],
    crew: [
      { nickname: 'Anna', role: 'ingegnere', isWaiting: true, isYou: false },
      { nickname: 'Sara', role: 'tecnico', isWaiting: true, isYou: true },
    ],
    you: { nickname: 'Sara', role: 'tecnico', energy: 4, maxEnergy: 10 },
    jump: null,
    log: [{ at: NOW - 120_000, text: 'Anna ha riparato il reattore.' }],
    ...changes,
  }
}

type Engine = { calls: Record<string, unknown>[]; toasts: string[]; replies: Reply[]; clock: MockClock }

/** What sits beneath the plugin: the deriva server, the store, the clock and the pane surface. */
function engine(on: On, store: Record<string, unknown> = { membership: MEMBER }): Engine {
  mock.store(on, store)
  const world: Engine = { calls: [], toasts: [], replies: [], clock: mock.clock(on) }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('http.fetch', ($, e) => {
    world.calls.push(JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>)
    const reply = world.replies.shift() ?? { view: shipView() }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  return world
}

test('creating a ship shares the room code and keeps the token out of the transcript', async ($, on) => {
  const world = engine(on, {})
  world.replies.push({ code: 'DRV-AB12', playerId: 'p-anna', token: 'segreto-di-anna', view: shipView({ code: 'DRV-AB12' }) })

  const result = await $.command.run({ command: 'deriva', args: 'nuova Anna', ...COMMAND })

  expect(world.calls[0]).toEqual({ op: 'create', nickname: 'Anna' })
  expect(result.text).toContain('DRV-AB12')
  expect(result.text).not.toContain('segreto')
})

test('joining reads the code, the name and an optional role', async ($, on) => {
  const world = engine(on, {})
  world.replies.push({ code: 'DRV-AB12', playerId: 'p-luca', token: 't', view: shipView() })

  await $.command.run({ command: 'deriva', args: 'entra drv-ab12 Luca Bianchi navigatore', ...COMMAND })

  expect(world.calls[0]).toEqual({ op: 'join', code: 'DRV-AB12', nickname: 'Luca Bianchi', role: 'navigatore' })
})

test('the bridge shows the ship and acts only while Claude works', async ($, on) => {
  const world = engine(on)
  const clock = world.clock

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'deriva', surface, ...PANE })

    await $.turn.start({ text: 'refactor', turnId: `turn-${surface}` })
    await clock.settle()
    expect(world.calls.at(-1)).toMatchObject({ op: 'sync', code: 'DRV-TEST', isWaiting: true })
    expect(await ui.find({ text: /Contatto sconosciuto tra 12:00/ })).toBeDefined()
    expect(await ui.find({ text: /sala d'attesa/ })).toBeDefined()

    await ui.press({ key: 'act-scansiona' })
    expect(world.calls.at(-1)).toMatchObject({ op: 'act', action: 'scansiona', isWaiting: true, token: MEMBER.token })

    await $.turn.complete({ ...DONE, turnId: `turn-${surface}` })
    const before = world.calls.length
    await ui.press({ key: 'act-ossigeno' })
    expect(world.calls.length).toBe(before)
    expect(world.toasts.at(-1)).toBe('Si agisce solo mentre Claude lavora.')

    await ui.unmount()
  }
})

test("a teammate's jump asks for a confirmation", async ($, on) => {
  const world = engine(on)
  const clock = world.clock
  world.replies.push({ view: shipView({ jump: { by: 'Anna', isYours: false, expiresAt: NOW + 20_000 } }) })
  world.replies.push({ view: shipView() })

  const ui = await $.ui.mount({ plugin: 'deriva', surface: 'terminal', ...PANE })
  await $.turn.start({ text: 'deploy', turnId: 'turn-1' })
  await clock.settle()

  expect(world.toasts.some(text => text.includes('Anna ha avviato un salto'))).toBe(true)
  await ui.press({ key: 'confirm-jump' })
  expect(world.calls.at(-1)).toMatchObject({ op: 'act', action: 'conferma_salto' })
})

test('without a ship the pane says how to board one', async ($, on) => {
  engine(on, {})

  const ui = await $.ui.mount({ plugin: 'deriva', surface: 'mobile', ...PANE })

  expect(await ui.find({ text: /Non sei ancora su una nave/ })).toBeDefined()
})

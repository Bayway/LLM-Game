import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  component: 'Pane',
  requestId: 'snake',
  props: {
    title: "Snake · sala d'attesa",
    isFocused: false,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DONE = { answer: 'fatto', durationMs: 65_000, isAborted: false, reason: 'answer' } as const

/** What the engine does beneath the plugin: run the turn and hand the toast stack the text. */
function engine(on: On, toasts: string[] = []): void {
  mock.store(on)
  mock.clock(on)
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
}

test('the board is locked while Claude is idle and playable while it works', async ($, on) => {
  engine(on)
  on('ui.panes', () => ({ value: [] }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'waiting-room', surface, ...PANE })
    expect(await ui.find({ in: 'board', text: /si gioca solo mentre lavora/ })).toBeDefined()

    await ui.key({ key: 'right', in: 'board' })
    expect(await ui.find({ in: 'board', text: /Premi una freccia/ })).toBeUndefined()

    await $.turn.start({ text: 'sistema i test', turnId: `turn-${surface}` })
    expect(await ui.find({ in: 'board', text: /Premi una freccia/ })).toBeDefined()

    await ui.key({ key: 'right', in: 'board' })
    expect(await ui.find({ in: 'board', text: /Claude sta lavorando/ })).toBeDefined()
    await ui.advance(600)
    expect(await ui.find({ in: 'board', text: /Claude sta lavorando/ })).toBeDefined()

    await $.turn.complete({ ...DONE, turnId: `turn-${surface}` })
    expect(await ui.find({ in: 'board', text: /si gioca solo mentre lavora/ })).toBeDefined()

    await ui.unmount()
  }
})

test('a game over beats the record', async ($, on) => {
  const toasts: string[] = []
  engine(on, toasts)

  const ui = await $.ui.mount({ plugin: 'waiting-room', surface: 'terminal', ...PANE })
  await ui.post({ type: 'over', score: 7 }, { in: 'board' })

  expect(await ui.find({ in: 'board', text: 'record 7' })).toBeDefined()
  expect(toasts).toContain('🐍 Nuovo record a Snake: 7 punti')
})

test('a permission prompt pauses the game', async ($, on) => {
  engine(on)
  on('classic.PermissionRequest', () => ({}))

  const ui = await $.ui.mount({ plugin: 'waiting-room', surface: 'terminal', ...PANE })
  await $.turn.start({ text: 'deploy', turnId: 'turn-1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })

  expect(await ui.find({ in: 'board', text: /ha bisogno di te/ })).toBeDefined()
})

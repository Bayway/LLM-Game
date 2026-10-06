import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { BoardMessage, BoardProps, Game } from '../types'

const PANE = 'snake'
const TITLE = "Snake · sala d'attesa"
const COLS = 20
const ROWS = 12
const PANE_ROWS = ROWS + 6
const CLOSE_DELAY_MS = 800

/** Tools that stop the turn until the person answers. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const ASKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

const phase = atom({ plugin: 'waiting-room', key: 'phase' } as const, 'idle')
const best = atom({ plugin: 'waiting-room', key: 'best' } as const, 0)
const isAutoOpen = atom({ plugin: 'waiting-room', key: 'isAutoOpen' } as const, true)

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`

  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function isMessage(data: unknown): data is BoardMessage {
  return typeof data === 'object' && data !== null && 'type' in data
}

// Turns running now, the main loop's and its subagents': the room is open while any runs.
const running = new Set<string>()
let pendingClose: Timer | undefined

async function needsYou($: EngineInterface): Promise<void> {
  if (running.size > 0) await update($, phase, () => 'needs-you')
}

async function backToWork($: EngineInterface): Promise<void> {
  if (running.size > 0) await update($, phase, current => (current === 'needs-you' ? 'working' : current))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'snake',
      description: "Apre Snake, giocabile solo mentre Claude lavora (/snake auto on|off)",
    })
    const stored = Number((await $.store.get('best')) ?? 0)
    const isAuto = (await $.store.get('isAutoOpen')) !== false
    await update($, best, current => Math.max(current, stored))
    await update($, isAutoOpen, () => isAuto)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    pendingClose?.cancel()
    pendingClose = undefined
    if (await read($, isAutoOpen)) {
      void $.ui.open({ id: PANE, title: TITLE, rows: PANE_ROWS })
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    running.add(e.turnId)
    await update($, phase, () => 'working')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    running.delete(e.turnId)
    if (running.size > 0 || e.agentId !== undefined) return result

    await update($, phase, () => 'idle')
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      $.ui.toast(`Claude ha finito dopo ${formatDuration(e.durationMs)}: Snake in pausa fino al prossimo prompt`)
      if (await read($, isAutoOpen)) {
        // Leaves the board a moment to save the game before the pane goes.
        pendingClose = $.clock.after(CLOSE_DELAY_MS, () => {
          pendingClose = undefined
          void $.ui.close({ id: PANE })
        })
      }
    }

    return result
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    await needsYou($)

    return next(e)
  })

  on('classic.Notification', async ($, e, next) => {
    if (ASKING_NOTIFICATIONS.has(e.notification_type)) await needsYou($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (ASKING_TOOLS.has(String(e.tool))) await needsYou($)
    const ran = await next(e)
    await backToWork($)

    return ran
  })

  on('ui.message', async ($, e, next) => {
    const data = e.data
    if (isMessage(data) && data.type === 'save') {
      await $.store.set('saved', data.game)
    }
    if (isMessage(data) && data.type === 'over') {
      await $.store.delete('saved')
      const record = await read($, best)
      if (data.score > record) {
        await update($, best, () => data.score)
        await $.store.set('best', data.score)
        $.ui.toast(`🐍 Nuovo record a Snake: ${data.score} punti`)
      }
    }

    return next(e)
  })

  on('command.run', { command: 'snake' }, async ($, e) => {
    const args = e.args.trim()
    if (args === 'auto on' || args === 'auto off') {
      const isAuto = args === 'auto on'
      await update($, isAutoOpen, () => isAuto)
      await $.store.set('isAutoOpen', isAuto)

      return {
        text: isAuto
          ? 'Snake si aprirà da solo a ogni prompt e si chiuderà quando Claude finisce.'
          : 'Snake non si aprirà più da solo: usa /snake quando vuoi giocare.',
      }
    }

    await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: PANE_ROWS })
    const isLocked = (await read($, phase)) !== 'working'

    return {
      text: isLocked
        ? 'Snake aperto: si sblocca appena Claude inizia a lavorare.'
        : 'Snake aperto: buon divertimento!',
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') {
      const { Text } = $.ui.resolve(e)

      return <Text dimColor>Snake si gioca nel terminale o nell'app desktop.</Text>
    }

    const { Client } = $.ui.resolve(e)
    const room = Math.floor((e.props.bodyColumns - 2) / 2)
    const props: BoardProps = {
      phase: await read($, phase),
      best: await read($, best),
      saved: ((await $.store.get('saved')) as Game | undefined) ?? null,
      cols: Math.max(8, Math.min(COLS, room)),
      rows: ROWS,
    }

    return <Client key="board" module="./board.tsx" props={props} />
  })
}

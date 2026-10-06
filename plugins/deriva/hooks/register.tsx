import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Membership, Reply, View } from '../types'
import { ago, bar, COLORS, countdown, HAZARD_NAMES, levelColor, movesFor, parseJoin } from './format'

const SERVER = 'https://mqhxhdhdmexkbhlmkjvu.supabase.co/functions/v1/deriva'
const PANE = 'deriva'
const TITLE = 'Deriva'
const PANE_ROWS = 28
const POLL_MS = 2000
/** With the pane closed but Claude working, one sync every this many polls (about 14 s). */
const CLOSED_POLL_EVERY = 7
const CLOSE_DELAY_MS = 800
const LOG_LINES = 6

/** Tools that stop the turn until the person answers. */
const ASKING_TOOLS = new Set(['AskUserQuestion', 'ExitPlanMode'])
const ASKING_NOTIFICATIONS = new Set(['permission_prompt', 'elicitation_dialog'])

const SIGNAL_BUTTONS = [
  { key: 'sig-ingegnere', hotkey: 'i', label: 'serve ingegnere', id: 'serve_ingegnere' },
  { key: 'sig-navigatore', hotkey: 'n', label: 'serve navigatore', id: 'serve_navigatore' },
  { key: 'sig-tecnico', hotkey: 't', label: 'serve tecnico', id: 'serve_tecnico' },
  { key: 'sig-bravi', hotkey: 'b', label: 'bravi!', id: 'bravi' },
]

const HELP = [
  'Deriva: tenete in rotta la nave del team mentre i vostri Claude lavorano.',
  '/deriva nuova <nome>  crea una nave e ti dà il codice da condividere',
  '/deriva entra <CODICE> <nome> [ruolo]  sali sulla nave del team (ingegnere, navigatore, tecnico)',
  '/deriva  apre il pannello',
  '/deriva ruolo <ruolo>  cambia ruolo (costa 3 di energia)',
  '/deriva auto on|off  apertura automatica a ogni prompt',
  '/deriva esci  lascia la nave su questo computer',
].join('\n')

const phase = atom({ plugin: 'deriva', key: 'phase' } as const, 'idle')
const isAutoOpen = atom({ plugin: 'deriva', key: 'isAutoOpen' } as const, true)

// Turns running now, the main loop's and its subagents': the room is open while any runs.
const running = new Set<string>()
let pendingClose: Timer | undefined
let poller: Timer | undefined
let pollCount = 0
let isSyncing = false
/** Undefined until read from the store. */
let membership: Membership | null | undefined
let view: View | null = null
let receivedAt = 0
let lastError: string | null = null
let alertedJump = 0

async function memberOf($: EngineInterface): Promise<Membership | null> {
  if (membership === undefined) {
    membership = ((await $.store.get('membership')) as Membership | undefined) ?? null
  }

  return membership
}

async function call($: EngineInterface, body: Record<string, unknown>): Promise<Reply> {
  try {
    const response = await $.http.fetch(SERVER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const reply = JSON.parse(response.text) as Reply

    return response.ok || reply.error ? reply : { error: `La nave non risponde (${response.status}).` }
  } catch {
    return { error: 'La nave non risponde: controlla la connessione.' }
  }
}

async function apply($: EngineInterface, reply: Reply): Promise<void> {
  if (reply.view) {
    view = reply.view
    receivedAt = await $.clock.now()
    const jump = reply.view.jump
    if (jump && !jump.isYours && jump.expiresAt !== alertedJump && (await read($, phase)) === 'working') {
      alertedJump = jump.expiresAt
      $.ui.toast(`🚀 ${jump.by} ha avviato un salto: premi 9 su Deriva per confermare entro 20 secondi!`)
    }
  }
  lastError = reply.error ?? null
  $.ui.invalidate('ui.render')
}

async function sync($: EngineInterface): Promise<void> {
  const member = await memberOf($)
  if (!member || isSyncing) return

  isSyncing = true
  try {
    const isWaiting = (await read($, phase)) === 'working'
    const { code, playerId, token } = member
    await apply($, await call($, { op: 'sync', code, playerId, token, isWaiting }))
  } finally {
    isSyncing = false
  }
}

async function poll($: EngineInterface): Promise<void> {
  if (!(await memberOf($))) return

  pollCount += 1
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
  const isWorking = (await read($, phase)) === 'working'
  if (isOpen || (isWorking && pollCount % CLOSED_POLL_EVERY === 0)) await sync($)
}

function startPolling($: EngineInterface): void {
  poller ??= $.clock.every(POLL_MS, () => void poll($))
}

async function perform($: EngineInterface, action: string, target?: number): Promise<void> {
  const member = await memberOf($)
  if (!member) return

  const current = await read($, phase)
  if (current !== 'working') {
    $.ui.toast(current === 'needs-you' ? 'Prima rispondi a Claude: ti sta aspettando.' : 'Si agisce solo mentre Claude lavora.')
    return
  }

  const { code, playerId, token } = member
  const reply = await call($, { op: 'act', code, playerId, token, action, target, isWaiting: true })
  await apply($, reply)
  if (reply.error) $.ui.toast(reply.error)
}

async function sendSignal($: EngineInterface, id: string): Promise<void> {
  const member = await memberOf($)
  if (!member) return

  const { code, playerId, token } = member
  const reply = await call($, { op: 'signal', code, playerId, token, signal: id })
  await apply($, reply)
  $.ui.toast(reply.error ?? "Segnale inviato all'equipaggio.")
}

/** Keeps the membership a create or join handed out and opens the bridge. */
async function board($: EngineInterface, reply: Reply): Promise<string | null> {
  if (!reply.code || !reply.playerId || !reply.token || !reply.view) return null

  membership = {
    code: reply.code,
    playerId: reply.playerId,
    token: reply.token,
    nickname: reply.view.you.nickname,
  }
  await $.store.set('membership', membership)
  await apply($, reply)
  startPolling($)
  await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: PANE_ROWS })

  return reply.view.you.role
}

async function needsYou($: EngineInterface): Promise<void> {
  if (running.size > 0) await update($, phase, () => 'needs-you')
}

async function backToWork($: EngineInterface): Promise<void> {
  if (running.size > 0) await update($, phase, current => (current === 'needs-you' ? 'working' : current))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'deriva',
      description: 'Deriva: la nave del team, si gioca mentre Claude lavora (/deriva nuova | entra | ruolo | auto | esci)',
    })
    const isAuto = (await $.store.get('isAutoOpen')) !== false
    await update($, isAutoOpen, () => isAuto)
    if (await memberOf($)) startPolling($)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    pendingClose?.cancel()
    pendingClose = undefined
    if ((await memberOf($)) && (await read($, isAutoOpen))) {
      void $.ui.open({ id: PANE, title: TITLE, rows: PANE_ROWS })
    }

    return result
  })

  on('turn.start', async ($, e, next) => {
    running.add(e.turnId)
    await update($, phase, () => 'working')
    if (await memberOf($)) {
      startPolling($)
      void sync($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    running.delete(e.turnId)
    if (running.size > 0 || e.agentId !== undefined) return result

    await update($, phase, () => 'idle')
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen && view) {
      const threats = view.hazards.length
      $.ui.toast(
        `Deriva: nave a ${Math.floor(view.ship.distance)}/${view.destination} anni luce, ${threats} ${threats === 1 ? 'minaccia' : 'minacce'} in arrivo`,
      )
    }
    if (isOpen && (await read($, isAutoOpen))) {
      pendingClose = $.clock.after(CLOSE_DELAY_MS, () => {
        pendingClose = undefined
        void $.ui.close({ id: PANE })
      })
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

  on('command.run', { command: 'deriva' }, async ($, e) => {
    const [sub = '', ...words] = e.args.trim().split(/\s+/).filter(Boolean)

    if (sub === 'nuova') {
      const reply = await call($, { op: 'create', nickname: words.join(' ') })
      if (!(await board($, reply))) return { text: reply.error ?? 'Non sono riuscito a creare la nave.' }

      return {
        text: `Nave creata: codice ${reply.code}. I compagni salgono con /deriva entra ${reply.code} <nome>. Tu sei l'ingegnere.`,
      }
    }

    if (sub === 'entra') {
      const parsed = parseJoin(words)
      if (!parsed) return { text: 'Uso: /deriva entra <CODICE> <nome> [ingegnere|navigatore|tecnico]' }
      const reply = await call($, { op: 'join', ...parsed })
      const role = await board($, reply)
      if (!role) return { text: reply.error ?? 'Non sono riuscito a salire a bordo.' }

      return { text: `Sei a bordo della nave ${reply.code} come ${role}. Si gioca mentre Claude lavora.` }
    }

    const member = await memberOf($)

    if (sub === 'ruolo') {
      if (!member) return { text: 'Prima sali su una nave: /deriva entra <CODICE> <nome>' }
      const { code, playerId, token } = member
      const reply = await call($, { op: 'role', code, playerId, token, role: words[0] ?? '' })
      await apply($, reply)

      return { text: reply.error ?? `Ora sei ${reply.view?.you.role ?? words[0]}.` }
    }

    if (sub === 'esci') {
      membership = null
      view = null
      await $.store.delete('membership')
      await $.ui.close({ id: PANE })

      return { text: 'Hai lasciato la nave su questo computer. Per tornare: /deriva entra <CODICE> <nome>' }
    }

    if (sub === 'auto' && (words[0] === 'on' || words[0] === 'off')) {
      const isAuto = words[0] === 'on'
      await update($, isAutoOpen, () => isAuto)
      await $.store.set('isAutoOpen', isAuto)

      return { text: isAuto ? 'Deriva si aprirà a ogni prompt.' : 'Deriva non si aprirà più da solo: usa /deriva.' }
    }

    if (sub !== '' || !member) return { text: HELP }

    await $.ui.open({ id: PANE, title: TITLE, focus: true, rows: PANE_ROWS })
    void sync($)

    return { text: `Plancia della nave ${member.code} aperta.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const current = await read($, phase)
    const member = await memberOf($)

    if (!member) {
      return (
        <Box flexDirection="column">
          <Text bold>🚀 Deriva</Text>
          <Text>Non sei ancora su una nave.</Text>
          <Text dimColor wrap="wrap">
            {'/deriva nuova <nome> per crearne una, /deriva entra <CODICE> <nome> per salire su quella del team.'}
          </Text>
        </Box>
      )
    }
    const shown = view
    if (!shown) {
      return <Text dimColor>Collegamento alla nave {member.code}…</Text>
    }

    const now = shown.now + ((await $.clock.now()) - receivedAt)
    const ship = shown.ship
    const isActive = current === 'working'
    const gauges = [
      ['Reattore', ship.reactor],
      ['Scafo', ship.hull],
      ['Ossigeno', ship.oxygen],
      ['Scudi', ship.shields],
    ] as const
    const jump = shown.jump && shown.jump.expiresAt > now ? shown.jump : null
    const status =
      current === 'working'
        ? "Claude sta lavorando: sei in sala d'attesa, +1 energia ogni 30 secondi."
        : current === 'needs-you'
          ? '⚠ Claude ha bisogno di te: rispondi, poi torni in plancia.'
          : '🔒 Claude è fermo: puoi guardare la nave, ma si agisce solo mentre lavora.'

    return (
      <Box flexDirection="column">
        <Box gap={2}>
          <Text bold>🚀 DERIVA</Text>
          <Text>{shown.code}</Text>
          <Text dimColor>missione {shown.mission}</Text>
        </Box>
        <Box gap={1}>
          <Text>{'Rotta'.padEnd(9)}</Text>
          <Text color={COLORS.accent}>{bar(ship.distance, shown.destination, 20)}</Text>
          <Text>
            {Math.floor(ship.distance)}/{shown.destination} AL
          </Text>
          {ship.courseUntil > now && <Text color={COLORS.accent}>⚡ {countdown(ship.courseUntil - now)}</Text>}
        </Box>
        {gauges.map(([label, value]) => (
          <Box key={`gauge-${label}`} gap={1}>
            <Text>{label.padEnd(9)}</Text>
            <Text color={levelColor(value)}>{bar(value, 100, 20)}</Text>
            <Text>{String(Math.round(value)).padStart(3)}</Text>
          </Box>
        ))}

        <Text bold>Minacce</Text>
        {shown.hazards.length === 0 && <Text dimColor>  nessun contatto sui sensori</Text>}
        {shown.hazards.map(hazard => (
          <Text color={hazard.kind === null ? COLORS.warn : hazard.kind === 'relitto' ? COLORS.accent : COLORS.bad}>
            {'  '}
            {hazard.kind === null ? '? Contatto sconosciuto' : `${hazard.kind === 'relitto' ? '🛰' : '⚠'} ${HAZARD_NAMES[hazard.kind]}`} tra{' '}
            {countdown(hazard.hitsAt - now)}
          </Text>
        ))}

        <Text bold>Equipaggio</Text>
        <Box gap={2} flexWrap="wrap">
          {shown.crew.map(c => (
            <Text color={c.isWaiting ? COLORS.good : COLORS.dim}>
              {c.isWaiting ? '●' : '○'} {c.nickname} {c.role}
              {c.isYou ? ' (tu)' : ''}
            </Text>
          ))}
        </Box>

        <Box gap={1}>
          <Text>{'Energia'.padEnd(9)}</Text>
          <Text color={COLORS.accent}>{bar(shown.you.energy, shown.you.maxEnergy, shown.you.maxEnergy)}</Text>
          <Text>
            {shown.you.energy}/{shown.you.maxEnergy}
          </Text>
        </Box>
        <Box gap={2} flexWrap="wrap">
          {movesFor(shown).map(move => (
            <Button
              key={move.key}
              label={`${move.label} (${move.cost})`}
              hotkey={move.hotkey}
              plain
              dimColor={!isActive || shown.you.energy < move.cost}
              onPress={() => void perform($, move.action, move.target)}
            />
          ))}
          {!jump && (
            <Button
              key="jump"
              label="salto (2)"
              hotkey="8"
              plain
              dimColor={!isActive || ship.reactor < 60}
              onPress={() => void perform($, 'salto')}
            />
          )}
          {jump && !jump.isYours && (
            <Button
              key="confirm-jump"
              label={`conferma il salto di ${jump.by} (1)`}
              hotkey="9"
              plain
              variant="primary"
              onPress={() => void perform($, 'conferma_salto')}
            />
          )}
        </Box>
        {jump?.isYours && (
          <Text color={COLORS.warn}>Salto avviato: serve la conferma di un compagno entro {countdown(jump.expiresAt - now)}.</Text>
        )}
        <Box gap={2} flexWrap="wrap">
          <Text dimColor>Segnali</Text>
          {SIGNAL_BUTTONS.map(signal => (
            <Button
              key={signal.key}
              label={signal.label}
              hotkey={signal.hotkey}
              plain
              dimColor
              onPress={() => void sendSignal($, signal.id)}
            />
          ))}
        </Box>

        <Text bold>Diario di bordo</Text>
        {shown.log.slice(-LOG_LINES).map((entry, index) => (
          <Box key={`log-${index}`} gap={1}>
            <Text dimColor>{ago(now - entry.at).padEnd(6)}</Text>
            <Text wrap="wrap">{entry.text}</Text>
          </Box>
        ))}

        <Text color={current === 'needs-you' ? COLORS.warn : undefined} dimColor={current === 'idle'} wrap="wrap">
          {status}
        </Text>
        {lastError && <Text color={COLORS.bad}>{lastError}</Text>}
      </Box>
    )
  })
}

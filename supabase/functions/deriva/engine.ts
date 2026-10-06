// Deriva: the ship's rules. Pure functions over plain JSON state, no I/O, so the
// edge function and the tests share them. Times are milliseconds since the epoch.

export const ROLES = ['ingegnere', 'navigatore', 'tecnico'] as const
export type Role = (typeof ROLES)[number]

export type HazardKind = 'asteroidi' | 'tempesta' | 'relitto'

export type Hazard = {
  id: number
  kind: HazardKind
  hitsAt: number
  isScanned: boolean
}

export type Player = {
  id: string
  tokenHash: string
  nickname: string
  role: Role
  energy: number
  lastBeatAt: number
  lastEnergyAt: number
  lastSignalAt: number
}

export type LogEntry = { at: number; text: string }

export type Jump = { by: string; expiresAt: number }

export type Ship = {
  reactor: number
  hull: number
  oxygen: number
  shields: number
  distance: number
  courseUntil: number
}

export type State = {
  code: string
  seed: number
  mission: number
  tickAt: number
  ship: Ship
  hazards: Hazard[]
  players: Player[]
  log: LogEntry[]
  jump: Jump | null
  nextHazardId: number
}

export const MINUTE = 60_000
export const DESTINATION = 100
export const MAX_ENERGY = 10
export const MAX_PLAYERS = 8
/** A player counts as waiting (in the room) this long after their last beat. */
export const PRESENCE_MS = 45_000
/** One energy per this much waiting. */
export const ENERGY_MS = 30_000
export const JUMP_WINDOW_MS = 20_000
export const SIGNAL_COOLDOWN_MS = 60_000
/** Longer absences are skipped, as if the ship slept: catching up stays cheap. */
const MAX_CATCH_UP_MS = 3 * 24 * 60 * MINUTE
const LOG_SIZE = 40
const MAX_HAZARDS = 3

const DECAY_PER_MINUTE = { reactor: 0.1, oxygen: 0.08, shields: 0.2 }
const SPEED_PER_MINUTE = 2 / 60
const COURSE_BOOST = 1.5
const MIN_REACTOR_TO_MOVE = 25
const HAZARD_CHANCE_PER_MINUTE = 1 / 50
const HAZARD_DAMAGE = 30
const WRECK_PENALTY = 20
const JUMP_DISTANCE = 15
const JUMP_REACTOR_COST = 40
const JUMP_MIN_REACTOR = 60

export type Action =
  | 'ripara_reattore'
  | 'ripara_scafo'
  | 'carica_scudi'
  | 'traccia_rotta'
  | 'evita'
  | 'aggancia'
  | 'scansiona'
  | 'ricicla_ossigeno'
  | 'salto'
  | 'conferma_salto'

type ActionRule = { role: Role | null; cost: number; label: string }

export const ACTIONS: Record<Action, ActionRule> = {
  ripara_reattore: { role: 'ingegnere', cost: 1, label: 'ha riparato il reattore' },
  ripara_scafo: { role: 'ingegnere', cost: 1, label: 'ha riparato lo scafo' },
  carica_scudi: { role: 'ingegnere', cost: 1, label: 'ha caricato gli scudi' },
  traccia_rotta: { role: 'navigatore', cost: 2, label: 'ha tracciato una rotta veloce' },
  evita: { role: 'navigatore', cost: 2, label: 'ha virato' },
  aggancia: { role: 'navigatore', cost: 2, label: 'ha agganciato il relitto' },
  scansiona: { role: 'tecnico', cost: 1, label: 'ha scansionato lo spazio' },
  ricicla_ossigeno: { role: 'tecnico', cost: 1, label: "ha riciclato l'ossigeno" },
  salto: { role: null, cost: 2, label: 'ha avviato un salto' },
  conferma_salto: { role: null, cost: 1, label: 'ha confermato il salto' },
}

export const SIGNALS = {
  serve_ingegnere: 'Serve un ingegnere!',
  serve_navigatore: 'Serve un navigatore!',
  serve_tecnico: 'Serve un tecnico!',
  pronto_salto: 'Pronto al salto, chi conferma?',
  bravi: 'Ottimo lavoro, equipaggio!',
} as const
export type Signal = keyof typeof SIGNALS

const HAZARD_NAMES: Record<HazardKind, string> = {
  asteroidi: 'Campo di asteroidi',
  tempesta: 'Tempesta ionica',
  relitto: 'Relitto alla deriva',
}

export type Result = { state: State; error?: undefined } | { state?: undefined; error: string }

// --- randomness: a hash of (seed, minute, salt), so replaying a stretch of time always agrees

export function rand(seed: number, minute: number, salt: number): number {
  let x = (seed ^ Math.imul(minute, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0
  x = (x ^ (x >>> 16)) >>> 0

  return x / 4294967296
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, value))
}

function note(state: State, at: number, text: string): void {
  state.log.push({ at, text })
  if (state.log.length > LOG_SIZE) state.log.splice(0, state.log.length - LOG_SIZE)
}

/** Damage soaked by the shields first, the rest returned. */
function soak(ship: Ship, damage: number): number {
  const absorbed = Math.min(ship.shields, damage)
  ship.shields = clamp(ship.shields - absorbed)

  return damage - absorbed
}

// --- creation and membership

export function createState(code: string, seed: number, now: number): State {
  return {
    code,
    seed,
    mission: 1,
    tickAt: Math.floor(now / MINUTE) * MINUTE,
    ship: { reactor: 80, hull: 100, oxygen: 90, shields: 30, distance: 0, courseUntil: 0 },
    hazards: [],
    players: [],
    log: [{ at: now, text: 'La nave è salpata. Destinazione: stazione Approdo, 100 anni luce.' }],
    jump: null,
    nextHazardId: 1,
  }
}

export function cleanNickname(raw: string): string | null {
  const nickname = raw.normalize('NFC').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16)

  return nickname.length >= 2 ? nickname : null
}

/** The role fewest players hold, ties broken in the ROLES order. */
export function openRole(state: State): Role {
  const counts = ROLES.map(role => state.players.filter(p => p.role === role).length)

  return ROLES[counts.indexOf(Math.min(...counts))] ?? 'ingegnere'
}

export function addPlayer(
  state: State,
  player: { id: string; tokenHash: string; nickname: string; role?: Role },
  now: number,
): Result {
  if (state.players.length >= MAX_PLAYERS) return { error: 'La nave è al completo (8 membri).' }
  if (state.players.some(p => p.nickname.toLowerCase() === player.nickname.toLowerCase())) {
    return { error: `Il nome "${player.nickname}" è già nell'equipaggio.` }
  }

  const role = player.role ?? openRole(state)
  state.players.push({
    id: player.id,
    tokenHash: player.tokenHash,
    nickname: player.nickname,
    role,
    energy: 3,
    lastBeatAt: 0,
    lastEnergyAt: 0,
    lastSignalAt: 0,
  })
  note(state, now, `${player.nickname} si è unito all'equipaggio come ${role}.`)

  return { state }
}

// --- time

function stepMinute(state: State, minute: number): void {
  const t = minute * MINUTE
  const ship = state.ship

  ship.reactor = clamp(ship.reactor - DECAY_PER_MINUTE.reactor)
  ship.shields = clamp(ship.shields - DECAY_PER_MINUTE.shields)
  const hadOxygen = ship.oxygen > 0
  ship.oxygen = clamp(ship.oxygen - DECAY_PER_MINUTE.oxygen)
  if (hadOxygen && ship.oxygen === 0) note(state, t, "Ossigeno esaurito: la nave si ferma finché il tecnico non lo ricicla.")

  if (ship.reactor >= MIN_REACTOR_TO_MOVE && ship.oxygen > 0) {
    ship.distance += SPEED_PER_MINUTE * (ship.courseUntil > t ? COURSE_BOOST : 1)
  }

  if (state.hazards.length < MAX_HAZARDS && rand(state.seed, minute, 1) < HAZARD_CHANCE_PER_MINUTE) {
    const roll = rand(state.seed, minute, 2)
    const kind: HazardKind = roll < 0.45 ? 'asteroidi' : roll < 0.8 ? 'tempesta' : 'relitto'
    const eta = 20 + Math.floor(rand(state.seed, minute, 3) * 40)
    state.hazards.push({ id: state.nextHazardId++, kind, hitsAt: t + eta * MINUTE, isScanned: false })
  }

  for (const hazard of state.hazards.filter(h => h.hitsAt <= t)) {
    strike(state, hazard, t)
  }
  state.hazards = state.hazards.filter(h => h.hitsAt > t)

  if (ship.hull === 0) {
    ship.distance = Math.max(0, ship.distance - WRECK_PENALTY)
    ship.hull = 40
    note(state, t, `Scafo distrutto: riparazioni d'emergenza, la nave perde ${WRECK_PENALTY} anni luce.`)
  }

  if (ship.distance >= DESTINATION) arrive(state, t)
}

function strike(state: State, hazard: Hazard, at: number): void {
  const ship = state.ship
  const damage = HAZARD_DAMAGE * (1 + 0.15 * (state.mission - 1))

  if (hazard.kind === 'relitto') {
    note(state, at, 'Il relitto è sfilato via: nessuno lo ha agganciato.')
    return
  }

  const shieldsBefore = ship.shields
  const rest = soak(ship, damage)
  const soaked = Math.round(shieldsBefore - ship.shields)
  if (hazard.kind === 'asteroidi') {
    ship.hull = clamp(ship.hull - rest)
    note(state, at, `Asteroidi! Scafo -${Math.round(rest)} (gli scudi ne hanno assorbiti ${soaked}).`)
  } else {
    ship.reactor = clamp(ship.reactor - rest)
    note(state, at, `Tempesta ionica! Reattore -${Math.round(rest)} (gli scudi ne hanno assorbiti ${soaked}).`)
  }
}

function arrive(state: State, at: number): void {
  note(state, at, `Missione ${state.mission} compiuta: la nave ha raggiunto la stazione! Si riparte, più al largo.`)
  state.mission += 1
  state.ship.distance = 0
  state.ship.courseUntil = 0
  state.hazards = []
  state.jump = null
}

/** Runs the ship forward to `now`, one minute at a time. */
export function advance(state: State, now: number): State {
  if (now - state.tickAt > MAX_CATCH_UP_MS) {
    state.tickAt = Math.floor((now - MAX_CATCH_UP_MS) / MINUTE) * MINUTE
  }
  while (state.tickAt + MINUTE <= now) {
    state.tickAt += MINUTE
    stepMinute(state, state.tickAt / MINUTE)
  }
  if (state.jump && state.jump.expiresAt <= now) {
    note(state, state.jump.expiresAt, 'Salto annullato: nessun altro ha confermato in tempo.')
    state.jump = null
  }

  return state
}

// --- players

export function isWaiting(player: Player, now: number): boolean {
  return now - player.lastBeatAt <= PRESENCE_MS
}

/** The player's Claude is working: they are in the waiting room and earn energy. */
export function beat(state: State, playerId: string, now: number): State {
  const player = state.players.find(p => p.id === playerId)
  if (!player) return state

  player.lastBeatAt = now
  if (now - player.lastEnergyAt >= ENERGY_MS) {
    player.energy = Math.min(MAX_ENERGY, player.energy + 1)
    player.lastEnergyAt = now
  }

  return state
}

/** True when a beat at `now` would change what is stored (presence or energy). */
export function beatChanges(state: State, playerId: string, now: number): boolean {
  const player = state.players.find(p => p.id === playerId)
  if (!player) return false

  return now - player.lastBeatAt > 10_000 || (now - player.lastEnergyAt >= ENERGY_MS && player.energy < MAX_ENERGY)
}

export function act(state: State, playerId: string, action: Action, now: number, target?: number): Result {
  advance(state, now)
  const player = state.players.find(p => p.id === playerId)
  const rule = ACTIONS[action]
  if (!player) return { error: "Non fai parte dell'equipaggio." }
  if (!rule) return { error: 'Azione sconosciuta.' }
  if (!isWaiting(player, now)) return { error: 'Si agisce solo mentre il tuo Claude lavora.' }
  if (rule.role && rule.role !== player.role) return { error: `Solo il ${rule.role} può farlo.` }
  if (player.energy < rule.cost) return { error: `Serve ${rule.cost} di energia, ne hai ${player.energy}.` }

  const ship = state.ship
  const hazard = target === undefined ? undefined : state.hazards.find(h => h.id === target)
  let detail = ''

  switch (action) {
    case 'ripara_reattore':
      ship.reactor = clamp(ship.reactor + 20)
      break
    case 'ripara_scafo':
      ship.hull = clamp(ship.hull + 15)
      break
    case 'carica_scudi':
      ship.shields = clamp(ship.shields + 25)
      break
    case 'traccia_rotta':
      ship.courseUntil = Math.min(Math.max(now, ship.courseUntil) + 60 * MINUTE, now + 180 * MINUTE)
      break
    case 'ricicla_ossigeno':
      ship.oxygen = clamp(ship.oxygen + 20)
      break
    case 'scansiona': {
      const hidden = state.hazards.filter(h => !h.isScanned)
      if (hidden.length === 0) return { error: 'Nessun contatto sconosciuto sui sensori.' }
      hidden.forEach(h => (h.isScanned = true))
      detail = `: ${hidden.map(h => HAZARD_NAMES[h.kind].toLowerCase()).join(', ')}`
      break
    }
    case 'evita':
      if (!hazard || hazard.kind === 'relitto') return { error: 'Scegli una minaccia da evitare.' }
      if (!hazard.isScanned) return { error: 'Prima va scansionata: non sai cosa stai evitando.' }
      state.hazards = state.hazards.filter(h => h !== hazard)
      detail = ` attorno a: ${HAZARD_NAMES[hazard.kind].toLowerCase()}`
      break
    case 'aggancia':
      if (!hazard || hazard.kind !== 'relitto' || !hazard.isScanned) return { error: 'Non c\'è un relitto scansionato da agganciare.' }
      state.hazards = state.hazards.filter(h => h !== hazard)
      ship.oxygen = clamp(ship.oxygen + 30)
      ship.hull = clamp(ship.hull + 20)
      detail = ': ossigeno +30, scafo +20'
      break
    case 'salto':
      if (state.jump) return { error: 'Un salto è già in attesa di conferma.' }
      if (ship.reactor < JUMP_MIN_REACTOR) return { error: `Il salto richiede il reattore almeno a ${JUMP_MIN_REACTOR}.` }
      state.jump = { by: player.id, expiresAt: now + JUMP_WINDOW_MS }
      detail = ': serve la conferma di un altro membro entro 20 secondi'
      break
    case 'conferma_salto':
      if (!state.jump) return { error: 'Nessun salto da confermare.' }
      if (state.jump.by === player.id) return { error: 'Il salto lo deve confermare un altro membro.' }
      ship.reactor = clamp(ship.reactor - JUMP_REACTOR_COST)
      ship.distance += JUMP_DISTANCE
      state.hazards = []
      state.jump = null
      detail = `: la nave balza avanti di ${JUMP_DISTANCE} anni luce, lasciandosi dietro ogni minaccia`
      break
  }

  player.energy -= rule.cost
  note(state, now, `${player.nickname} ${rule.label}${detail}.`)
  if (ship.distance >= DESTINATION) arrive(state, now)

  return { state }
}

export function signal(state: State, playerId: string, id: Signal, now: number): Result {
  advance(state, now)
  const player = state.players.find(p => p.id === playerId)
  if (!player) return { error: "Non fai parte dell'equipaggio." }
  if (!(id in SIGNALS)) return { error: 'Segnale sconosciuto.' }
  if (now - player.lastSignalAt < SIGNAL_COOLDOWN_MS) return { error: 'Hai appena mandato un segnale: aspetta un minuto.' }

  player.lastSignalAt = now
  note(state, now, `${player.nickname}: «${SIGNALS[id]}»`)

  return { state }
}

export function changeRole(state: State, playerId: string, role: Role, now: number): Result {
  advance(state, now)
  const player = state.players.find(p => p.id === playerId)
  if (!player) return { error: "Non fai parte dell'equipaggio." }
  if (!ROLES.includes(role)) return { error: `Ruoli: ${ROLES.join(', ')}.` }
  if (player.role === role) return { error: `Sei già ${role}.` }
  if (player.energy < 3) return { error: 'Cambiare ruolo costa 3 di energia.' }

  player.energy -= 3
  player.role = role
  note(state, now, `${player.nickname} ora è ${role}.`)

  return { state }
}

// --- what a player sees

export type HazardView = { id: number; kind: HazardKind | null; hitsAt: number }

export type View = {
  code: string
  now: number
  mission: number
  destination: number
  ship: Ship
  hazards: HazardView[]
  crew: { nickname: string; role: Role; isWaiting: boolean; isYou: boolean }[]
  you: { nickname: string; role: Role; energy: number; maxEnergy: number }
  jump: { by: string; isYours: boolean; expiresAt: number } | null
  log: LogEntry[]
}

/** The state as one player sees it: no seed, no tokens, unscanned hazards unnamed. */
export function toView(state: State, playerId: string, now: number): View | null {
  const you = state.players.find(p => p.id === playerId)
  if (!you) return null
  const round = (value: number) => Math.round(value * 10) / 10
  const jumper = state.jump && state.players.find(p => p.id === state.jump?.by)

  return {
    code: state.code,
    now,
    mission: state.mission,
    destination: DESTINATION,
    ship: {
      reactor: round(state.ship.reactor),
      hull: round(state.ship.hull),
      oxygen: round(state.ship.oxygen),
      shields: round(state.ship.shields),
      distance: round(state.ship.distance),
      courseUntil: state.ship.courseUntil,
    },
    hazards: state.hazards
      .map(h => ({ id: h.id, kind: h.isScanned ? h.kind : null, hitsAt: h.hitsAt }))
      .sort((a, b) => a.hitsAt - b.hitsAt),
    crew: state.players.map(p => ({
      nickname: p.nickname,
      role: p.role,
      isWaiting: isWaiting(p, now),
      isYou: p.id === playerId,
    })),
    you: { nickname: you.nickname, role: you.role, energy: you.energy, maxEnergy: MAX_ENERGY },
    jump:
      state.jump && jumper
        ? { by: jumper.nickname, isYours: jumper.id === playerId, expiresAt: state.jump.expiresAt }
        : null,
    log: state.log.slice(-12),
  }
}

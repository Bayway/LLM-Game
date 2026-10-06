import type { HazardKind, Role, View } from '../types'

export const HAZARD_NAMES: Record<HazardKind, string> = {
  asteroidi: 'Campo di asteroidi',
  tempesta: 'Tempesta ionica',
  relitto: 'Relitto alla deriva',
}

export const COLORS = {
  good: '#22c55e',
  warn: '#eab308',
  bad: '#ef4444',
  dim: '#6b7280',
  accent: '#38bdf8',
}

export type Move = {
  key: string
  hotkey: string
  label: string
  action: string
  target?: number
  cost: number
}

export function bar(value: number, max: number, width: number): string {
  const filled = Math.round((Math.max(0, Math.min(max, value)) / max) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function levelColor(value: number): string {
  return value < 25 ? COLORS.bad : value < 50 ? COLORS.warn : COLORS.good
}

export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function ago(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'ora'
  if (minutes < 60) return `${minutes}m fa`
  const hours = Math.floor(minutes / 60)

  return hours < 24 ? `${hours}h fa` : `${Math.floor(hours / 24)}g fa`
}

/** What the player's role can do on this view, in hotkey order. */
export function movesFor(view: View): Move[] {
  const role: Role = view.you.role
  if (role === 'ingegnere') {
    return [
      { key: 'act-reattore', hotkey: '1', label: 'ripara reattore +20', action: 'ripara_reattore', cost: 1 },
      { key: 'act-scafo', hotkey: '2', label: 'ripara scafo +15', action: 'ripara_scafo', cost: 1 },
      { key: 'act-scudi', hotkey: '3', label: 'carica scudi +25', action: 'carica_scudi', cost: 1 },
    ]
  }
  if (role === 'tecnico') {
    return [
      { key: 'act-scansiona', hotkey: '1', label: 'scansiona', action: 'scansiona', cost: 1 },
      { key: 'act-ossigeno', hotkey: '2', label: 'ricicla ossigeno +20', action: 'ricicla_ossigeno', cost: 1 },
    ]
  }

  const moves: Move[] = [{ key: 'act-rotta', hotkey: '1', label: 'rotta veloce 60m', action: 'traccia_rotta', cost: 2 }]
  const threat = view.hazards.find(hazard => hazard.kind === 'asteroidi' || hazard.kind === 'tempesta')
  if (threat?.kind) {
    moves.push({
      key: 'act-evita',
      hotkey: '2',
      label: `evita: ${HAZARD_NAMES[threat.kind].toLowerCase()}`,
      action: 'evita',
      target: threat.id,
      cost: 2,
    })
  }
  const wreck = view.hazards.find(hazard => hazard.kind === 'relitto')
  if (wreck) {
    moves.push({ key: 'act-aggancia', hotkey: '3', label: 'aggancia relitto', action: 'aggancia', target: wreck.id, cost: 2 })
  }

  return moves
}

/** Splits `/deriva entra DRV-AB12 Anna Rossi tecnico` into code, nickname and role. */
export function parseJoin(words: string[]): { code: string; nickname: string; role?: Role } | null {
  const [code, ...rest] = words
  if (!code || rest.length === 0) return null
  const last = rest[rest.length - 1]
  const role = last === 'ingegnere' || last === 'navigatore' || last === 'tecnico' ? last : undefined
  const nickname = (role ? rest.slice(0, -1) : rest).join(' ')

  return nickname ? { code: code.toUpperCase(), nickname, role } : null
}

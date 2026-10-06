// The deriva edge function's answers, as engine.ts `toView` builds them.

export type Phase = 'idle' | 'working' | 'needs-you'

export type Role = 'ingegnere' | 'navigatore' | 'tecnico'

export type HazardKind = 'asteroidi' | 'tempesta' | 'relitto'

export type Ship = {
  reactor: number
  hull: number
  oxygen: number
  shields: number
  distance: number
  courseUntil: number
}

export type View = {
  code: string
  now: number
  mission: number
  destination: number
  ship: Ship
  hazards: { id: number; kind: HazardKind | null; hitsAt: number }[]
  crew: { nickname: string; role: Role; isWaiting: boolean; isYou: boolean }[]
  you: { nickname: string; role: Role; energy: number; maxEnergy: number }
  jump: { by: string; isYours: boolean; expiresAt: number } | null
  log: { at: number; text: string }[]
}

export type Reply = {
  view?: View
  error?: string
  code?: string
  playerId?: string
  token?: string
}

export type Membership = { code: string; playerId: string; token: string; nickname: string }

declare module 'claude-code' {
  interface PluginState {
    deriva: { phase: Phase; isAutoOpen: boolean }
  }
}

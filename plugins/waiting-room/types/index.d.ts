export type Phase = 'idle' | 'working' | 'needs-you'

export type Dir = 'up' | 'down' | 'left' | 'right'

export type Cell = [number, number]

export type Game = {
  cols: number
  rows: number
  snake: Cell[]
  dir: Dir
  queued: Dir[]
  food: Cell | null
  score: number
  isOver: boolean
  seed: number
}

export type BoardProps = {
  phase: Phase
  best: number
  saved: Game | null
  cols: number
  rows: number
}

export type BoardMessage =
  | { type: 'save'; game: Game }
  | { type: 'over'; score: number }

declare module 'claude-code' {
  interface PluginState {
    'waiting-room': { phase: Phase; best: number; isAutoOpen: boolean }
  }
}

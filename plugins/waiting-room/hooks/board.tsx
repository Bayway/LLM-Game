import type { ClientKeyEvent, ClientModule, ClientSurface } from 'claude-code'

import type { BoardMessage, BoardProps, Dir, Game } from '../types'
import { interval, newGame, step, turn } from './snake'

type Local = {
  game: Game | null
  isPaused: boolean
  isSaved: boolean
  isRecord: boolean
}

type Surface = ClientSurface<Local>

const TICK_MS = 30
const SAVE_EVERY_MS = 2000

const KEYS: Record<string, Dir> = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
  k: 'up',
  h: 'left',
  j: 'down',
  l: 'right',
}

const COLORS = {
  head: '#86efac',
  body: '#22c55e',
  food: '#ef4444',
  locked: '#6b7280',
}

// One board per plugin: the tick and key handlers read the latest props from here.
let live: BoardProps = { phase: 'idle', best: 0, saved: null, cols: 20, rows: 12 }
let sinceMove = 0
let sinceSave = 0

function newSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0
}

function post(surface: Surface, message: BoardMessage): void {
  surface.post(message)
}

function tick(surface: Surface): void {
  const local = surface.state
  if (!local?.game || local.game.isOver) return

  if (live.phase !== 'working' || local.isPaused) {
    if (!local.isSaved) {
      post(surface, { type: 'save', game: local.game })
      surface.setState({ ...local, isSaved: true })
    }
    return
  }

  sinceMove += TICK_MS
  sinceSave += TICK_MS
  if (sinceMove < interval(local.game.score)) return
  sinceMove = 0

  const game = step(local.game)
  if (game.isOver) {
    post(surface, { type: 'over', score: game.score })
    surface.setState({ ...local, game, isSaved: true, isRecord: game.score > live.best })
    return
  }

  if (sinceSave >= SAVE_EVERY_MS) {
    sinceSave = 0
    post(surface, { type: 'save', game })
    surface.setState({ ...local, game, isSaved: true })
    return
  }

  surface.setState({ ...local, game, isSaved: false })
}

function steer(surface: Surface, dir: Dir): void {
  const local = surface.state
  if (!local || live.phase !== 'working') return

  if (!local.game || local.game.isOver) {
    sinceMove = 0
    sinceSave = 0
    const game = newGame(live.cols, live.rows, newSeed(), dir)
    surface.setState({ game, isPaused: false, isSaved: false, isRecord: false })
    return
  }

  surface.setState({ ...local, game: turn(local.game, dir), isPaused: false })
}

function togglePause(surface: Surface): void {
  const local = surface.state
  if (!local?.game || local.game.isOver || live.phase !== 'working') return

  surface.setState({ ...local, isPaused: !local.isPaused })
}

function onKey(surface: Surface, event: ClientKeyEvent): void {
  if (event.ctrl || event.meta) return
  if (event.key === ' ' || event.key === 'space' || event.key === 'p') {
    togglePause(surface)
    return
  }

  const dir = KEYS[event.key] ?? KEYS[event.key.toLowerCase()]
  if (dir) steer(surface, dir)
}

type Kind = 'empty' | 'body' | 'head' | 'food'

function kindAt(game: Game | null, x: number, y: number): Kind {
  if (!game) return 'empty'
  const head = game.snake[0]
  if (head && head[0] === x && head[1] === y) return 'head'
  if (game.snake.some(([sx, sy]) => sx === x && sy === y)) return 'body'
  if (game.food && game.food[0] === x && game.food[1] === y) return 'food'

  return 'empty'
}

/** One row of the board as runs of same-kind cells, two columns per cell. */
function runsOf(game: Game | null, cols: number, y: number): { kind: Kind; width: number }[] {
  const runs: { kind: Kind; width: number }[] = []
  for (let x = 0; x < cols; x++) {
    const kind = kindAt(game, x, y)
    const last = runs[runs.length - 1]
    if (last && last.kind === kind) last.width += 2
    else runs.push({ kind, width: 2 })
  }

  return runs
}

function messageOf(props: BoardProps, local: Local): string {
  if (props.phase === 'idle') {
    return '🔒 Claude ha finito: si gioca solo mentre lavora. La partita ti aspetta al prossimo prompt.'
  }
  if (props.phase === 'needs-you') {
    return '⚠ Claude ha bisogno di te: rispondi alla sua richiesta, poi si riprende.'
  }

  const game = local.game
  if (!game) return 'Premi una freccia (o w a s d) per iniziare. Se i tasti non arrivano, clicca sul campo.'
  if (game.isOver) {
    const record = local.isRecord ? ' Nuovo record!' : ''
    return `💥 Game over: ${game.score} punti.${record} Una freccia per rigiocare.`
  }
  if (local.isPaused) return '⏸ In pausa. Una freccia per riprendere.'

  return 'Claude sta lavorando: gioca! Spazio per la pausa.'
}

const Board: ClientModule<BoardProps, Local> = (props, surface) => {
  live = props
  const { Box, Text, Button } = surface.elements

  if (surface.state === undefined) {
    surface.every(TICK_MS, () => tick(surface))
    surface.onKey(event => onKey(surface, event))
    surface.setState({ game: props.saved, isPaused: false, isSaved: true, isRecord: false })
  }

  const local: Local = surface.state ?? { game: props.saved, isPaused: false, isSaved: true, isRecord: false }
  const game = local.game
  const cols = game?.cols ?? props.cols
  const rows = game?.rows ?? props.rows
  const isLocked = props.phase !== 'working'
  const score = game?.score ?? 0
  const best = Math.max(props.best, score)

  const lines = []
  for (let y = 0; y < rows; y++) {
    lines.push(
      <Box key={`row-${y}`}>
        {runsOf(game, cols, y).map(run => (
          <Text
            color={isLocked ? COLORS.locked : run.kind === 'empty' ? undefined : COLORS[run.kind]}
            dimColor={isLocked}
          >
            {(run.kind === 'empty' ? ' ' : '█').repeat(run.width)}
          </Text>
        ))}
      </Box>,
    )
  }

  return (
    <Box flexDirection="column">
      <Box gap={2}>
        <Text bold>🐍 Snake</Text>
        <Text>punti {score}</Text>
        <Text dimColor>record {best}</Text>
      </Box>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={isLocked ? COLORS.locked : COLORS.body}
        width={cols * 2 + 2}
      >
        {lines}
      </Box>
      <Text dimColor={isLocked} wrap="wrap">
        {messageOf(props, local)}
      </Text>
      <Box gap={1}>
        <Button key="up" label="↑" hotkey="w" plain onPress={() => steer(surface, 'up')} />
        <Button key="left" label="←" hotkey="a" plain onPress={() => steer(surface, 'left')} />
        <Button key="down" label="↓" hotkey="s" plain onPress={() => steer(surface, 'down')} />
        <Button key="right" label="→" hotkey="d" plain onPress={() => steer(surface, 'right')} />
        <Button key="pause" label="pausa" hotkey="p" plain onPress={() => togglePause(surface)} />
      </Box>
    </Box>
  )
}

export default Board

import type { Cell, Dir, Game } from '../types'

const DELTA: Record<Dir, Cell> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
}

const OPPOSITE: Record<Dir, Dir> = {
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
}

const START_LENGTH = 3
const MAX_QUEUED = 2

function nextSeed(seed: number): number {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0
}

function isOn(cells: readonly Cell[], [x, y]: Cell): boolean {
  return cells.some(([cx, cy]) => cx === x && cy === y)
}

function placeFood(
  snake: readonly Cell[],
  cols: number,
  rows: number,
  seed: number,
): { food: Cell | null; seed: number } {
  const free = cols * rows - snake.length
  if (free <= 0) {
    return { food: null, seed }
  }

  const next = nextSeed(seed)
  let pick = next % free
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (isOn(snake, [x, y])) continue
      if (pick === 0) return { food: [x, y], seed: next }
      pick--
    }
  }

  return { food: null, seed: next }
}

export function newGame(cols: number, rows: number, seed: number, dir: Dir = 'right'): Game {
  const head: Cell = [Math.floor(cols / 2), Math.floor(rows / 2)]
  const [bx, by] = DELTA[OPPOSITE[dir]]
  const snake: Cell[] = []
  for (let i = 0; i < START_LENGTH; i++) {
    snake.push([head[0] + bx * i, head[1] + by * i])
  }
  const placed = placeFood(snake, cols, rows, seed)

  return {
    cols,
    rows,
    snake,
    dir,
    queued: [],
    food: placed.food,
    score: 0,
    isOver: false,
    seed: placed.seed,
  }
}

export function turn(game: Game, dir: Dir): Game {
  const last = game.queued[game.queued.length - 1] ?? game.dir
  if (game.isOver || dir === last || dir === OPPOSITE[last] || game.queued.length >= MAX_QUEUED) {
    return game
  }

  return { ...game, queued: [...game.queued, dir] }
}

export function step(game: Game): Game {
  const current = game.snake[0]
  if (game.isOver || !current) {
    return game
  }

  const [dir = game.dir, ...queued] = game.queued
  const [hx, hy] = current
  const [dx, dy] = DELTA[dir]
  const head: Cell = [hx + dx, hy + dy]
  const isOutside = head[0] < 0 || head[1] < 0 || head[0] >= game.cols || head[1] >= game.rows
  const eats = game.food !== null && head[0] === game.food[0] && head[1] === game.food[1]
  const body = eats ? game.snake : game.snake.slice(0, -1)

  if (isOutside || isOn(body, head)) {
    return { ...game, dir, queued: [], isOver: true }
  }

  const snake = [head, ...body]
  if (!eats) {
    return { ...game, snake, dir, queued }
  }

  const placed = placeFood(snake, game.cols, game.rows, game.seed)

  return {
    ...game,
    snake,
    dir,
    queued,
    food: placed.food,
    score: game.score + 1,
    isOver: placed.food === null,
    seed: placed.seed,
  }
}

/** Milliseconds between moves: the snake speeds up as it eats. */
export function interval(score: number): number {
  return Math.max(70, 150 - score * 4)
}

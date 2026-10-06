import { describe, expect, test } from 'claude-code/testing'

import type { Cell, Game } from '../types'
import { interval, newGame, step, turn } from '../hooks/snake'

function at(game: Game, food: Cell): Game {
  return { ...game, food }
}

describe('snake', () => {
  test('starts in the middle, facing the chosen way', () => {
    const game = newGame(10, 8, 1, 'right')

    expect(game.snake).toEqual([[5, 4], [4, 4], [3, 4]])
    expect(game.score).toBe(0)
    expect(game.food).toBeDefined()
  })

  test('never puts food on the snake', () => {
    for (let seed = 1; seed < 200; seed++) {
      const game = newGame(4, 3, seed)
      const food = game.food
      expect(food).toBeTruthy()
      expect(game.snake.some(([x, y]) => food !== null && x === food[0] && y === food[1])).toBe(false)
    }
  })

  test('ignores a reversal and keeps at most two queued turns', () => {
    const game = newGame(10, 8, 1, 'right')

    expect(turn(game, 'left')).toBe(game)
    expect(turn(turn(turn(game, 'up'), 'left'), 'down').queued).toEqual(['up', 'left'])
  })

  test('moves one cell per step and applies queued turns in order', () => {
    let game = at(turn(turn(newGame(10, 8, 1, 'right'), 'up'), 'left'), [0, 0])
    game = step(game)
    expect(game.snake[0]).toEqual([5, 3])
    game = step(game)
    expect(game.snake[0]).toEqual([4, 3])
    expect(game.snake).toHaveLength(3)
  })

  test('eats, grows and scores', () => {
    const game = step(at(newGame(10, 8, 1, 'right'), [6, 4]))

    expect(game.score).toBe(1)
    expect(game.snake).toHaveLength(4)
    expect(game.food).not.toEqual([6, 4])
  })

  test('hitting a wall ends the game', () => {
    let game = at(newGame(6, 4, 1, 'right'), [0, 0])
    for (let i = 0; i < 5; i++) game = step(game)

    expect(game.isOver).toBe(true)
    expect(step(game)).toBe(game)
  })

  test('running into itself ends the game', () => {
    let game = at(newGame(10, 8, 1, 'right'), [0, 0])
    game = { ...game, snake: [[5, 4], [4, 4], [4, 5], [5, 5], [6, 5], [7, 5]] }
    game = step(turn(game, 'down'))

    expect(game.isOver).toBe(true)
  })

  test('speeds up as the score grows, down to a floor', () => {
    expect(interval(0)).toBe(150)
    expect(interval(5)).toBeLessThan(interval(0))
    expect(interval(100)).toBe(70)
  })
})

import { randomUUID } from 'node:crypto'

const ONE_HOUR_IN_MS = 60 * 60 * 1000
const STARTING_HAND_SIZE = 7

export type GameCard = {
  name: string
  cardText: string
}

type GameRecord = {
  id: string
  createdAt: number
  commanders: GameCard[]
  initialLibrary: GameCard[]
  library: GameCard[]
  hasDrawnStartingHand: boolean
  mulliganCount: number
}

export type DrawResult =
  | {
      ok: true
      cards: GameCard[]
      cardsRemaining: number
    }
  | {
      ok: false
      reason: 'game_not_found' | 'empty_library'
    }

export type DrawStartingHandResult =
  | DrawResult
  | {
      ok: false
      reason: 'starting_hand_already_drawn'
    }

export type MulliganResult =
  | {
      ok: true
      cards: GameCard[]
      cardsRemaining: number
      mulliganCount: number
      cardsToBottomIfKept: number
    }
  | {
      ok: false
      reason: 'game_not_found' | 'starting_hand_not_drawn'
    }

export class GameStore {
  private readonly games = new Map<string, GameRecord>()

  constructor() {
    const cleanupTimer = setInterval(() => {
      this.deleteExpiredGames()
    }, ONE_HOUR_IN_MS)

    cleanupTimer.unref()
  }

  createGame(commanders: readonly GameCard[], deck: readonly GameCard[]) {
    this.deleteExpiredGames()

    const id = randomUUID()
    const shuffledLibrary = shuffle(deck)
    const game: GameRecord = {
      id,
      createdAt: Date.now(),
      commanders: [...commanders],
      initialLibrary: [...shuffledLibrary],
      library: [...shuffledLibrary],
      hasDrawnStartingHand: false,
      mulliganCount: 0,
    }

    this.games.set(id, game)

    return {
      gameId: game.id,
      createdAt: new Date(game.createdAt).toISOString(),
      commanderCount: game.commanders.length,
      cardsRemaining: game.library.length,
      totalGames: this.games.size,
    }
  }

  drawCardsFromTop(gameId: string, count: number): DrawResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    if (game.library.length === 0) {
      return { ok: false, reason: 'empty_library' }
    }

    const cards = game.library.splice(0, count)

    return {
      ok: true,
      cards,
      cardsRemaining: game.library.length,
    }
  }

  drawCardsFromBottom(gameId: string, count: number): DrawResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    if (game.library.length === 0) {
      return { ok: false, reason: 'empty_library' }
    }

    const cards = game.library.splice(-count).reverse()

    return {
      ok: true,
      cards,
      cardsRemaining: game.library.length,
    }
  }

  drawStartingHand(gameId: string): DrawStartingHandResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    if (game.hasDrawnStartingHand) {
      return { ok: false, reason: 'starting_hand_already_drawn' }
    }

    if (game.library.length === 0) {
      return { ok: false, reason: 'empty_library' }
    }

    game.hasDrawnStartingHand = true

    const cards = game.library.splice(0, STARTING_HAND_SIZE)

    return {
      ok: true,
      cards,
      cardsRemaining: game.library.length,
    }
  }

  mulligan(gameId: string): MulliganResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    if (!game.hasDrawnStartingHand) {
      return { ok: false, reason: 'starting_hand_not_drawn' }
    }

    game.library = shuffle(game.initialLibrary)
    game.mulliganCount += 1

    const cards = game.library.splice(0, STARTING_HAND_SIZE)

    return {
      ok: true,
      cards,
      cardsRemaining: game.library.length,
      mulliganCount: game.mulliganCount,
      cardsToBottomIfKept: Math.max(0, game.mulliganCount - 1),
    }
  }

  private deleteExpiredGames() {
    const expirationCutoff = Date.now() - ONE_HOUR_IN_MS

    for (const [gameId, game] of this.games.entries()) {
      if (game.createdAt < expirationCutoff) {
        this.games.delete(gameId)
      }
    }
  }
}

function shuffle(cards: readonly GameCard[]) {
  const shuffledCards = [...cards]

  for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1))
    const currentCard = shuffledCards[index]

    shuffledCards[index] = shuffledCards[swapIndex]
    shuffledCards[swapIndex] = currentCard
  }

  return shuffledCards
}

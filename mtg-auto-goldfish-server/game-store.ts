import { randomInt, randomUUID } from 'node:crypto'

const ONE_HOUR_IN_MS = 60 * 60 * 1000
const STARTING_HAND_SIZE = 7
const EXPECTED_GAME_CARDS = 100

export type GameCard = {
  name: string
  cardText: string
}

export type OpeningHandSnapshotValidation = {
  isValid: boolean
  message: string
  totalGameCards: number
  expectedGameCards: number
  startingHandSize: number
  expectedStartingHandSize: number
  librarySize: number
  commanderCount: number
  mulliganCount: number
}

export type OpeningHandSnapshot = {
  startingHand: string[]
  library: string[]
  validation: OpeningHandSnapshotValidation
}

type GameRecord = {
  id: string
  createdAt: number
  seed: number
  commanders: GameCard[]
  initialLibrary: GameCard[]
  library: string[]
  openingHandSnapshot?: OpeningHandSnapshot
  hasDrawnStartingHand: boolean
  mulliganCount: number
  random: () => number
}

export type DrawResult =
  | {
    ok: true
    cards: string[]
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
    cards: string[]
    cardsRemaining: number
    mulliganCount: number
    cardsToBottomIfKept: number
  }
  | {
    ok: false
    reason: 'game_not_found' | 'starting_hand_not_drawn'
  }

export type ReturnCardToLibraryResult =
  | {
    ok: true
    cardsRemaining: number
    insertedFromTop: number
    insertedFromBottom: number
  }
  | {
    ok: false
    reason: 'game_not_found'
  }

export type ReturnCardsToLibraryResult =
  | {
    ok: true
    cards: string[]
    cardsRemaining: number
  }
  | {
    ok: false
    reason: 'game_not_found'
  }

export type ShuffleLibraryResult =
  | {
    ok: true
    cardsRemaining: number
  }
  | {
    ok: false
    reason: 'game_not_found'
  }

export type GetGamePromptContextResult =
  | {
    ok: true
    gameId: string
    commanders: GameCard[]
    initialLibrary: GameCard[]
    currentLibrary: string[]
    openingHandSnapshot?: OpeningHandSnapshot
  }
  | {
    ok: false
    reason: 'game_not_found'
  }

export type SaveOpeningHandSnapshotResult =
  | ({
      ok: true
    } & OpeningHandSnapshot)
  | {
      ok: false
      reason: 'game_not_found'
    }

export type GetOpeningHandSnapshotStatusResult =
  | {
      ok: true
      hasSnapshot: boolean
      snapshot?: OpeningHandSnapshot
    }
  | {
      ok: false
      reason: 'game_not_found'
    }

export type GameStoreOptions = {
  onDeleteGame?: (gameId: string) => void
}

type CreateGameResult = {
  gameId: string
  seed: number
  createdAt: string
  commanderCount: number
  cardsRemaining: number
  totalGames: number
}

export class GameStore {
  private readonly games = new Map<string, GameRecord>()
  private readonly onDeleteGame?: (gameId: string) => void

  constructor(options: GameStoreOptions = {}) {
    this.onDeleteGame = options.onDeleteGame
    const cleanupTimer = setInterval(() => {
      this.deleteExpiredGames()
    }, ONE_HOUR_IN_MS)

    cleanupTimer.unref()
  }

  createGame(
    commanders: readonly GameCard[],
    deck: readonly GameCard[],
    seed?: number
  ): CreateGameResult {
    this.deleteExpiredGames()

    const id = randomUUID()
    const resolvedSeed = normalizeSeed(seed)
    const random = createSeededRandom(resolvedSeed)
    const sortedInitialLibrary = sortCardsAlphabetically(deck)
    const shuffledLibrary = shuffle(deck.map((card) => card.name), random)
    const game: GameRecord = {
      id,
      createdAt: Date.now(),
      seed: resolvedSeed,
      commanders: [...commanders],
      initialLibrary: sortedInitialLibrary,
      library: [...shuffledLibrary],
      openingHandSnapshot: undefined,
      hasDrawnStartingHand: false,
      mulliganCount: 0,
      random,
    }

    this.games.set(id, game)

    return {
      gameId: game.id,
      seed: game.seed,
      createdAt: new Date(game.createdAt).toISOString(),
      commanderCount: game.commanders.length,
      cardsRemaining: game.library.length,
      totalGames: this.games.size,
    }
  }

  hasGame(gameId: string) {
    this.deleteExpiredGames()

    return this.games.has(gameId)
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

    game.library = shuffle(
      game.initialLibrary.map((card) => card.name),
      game.random
    )
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

  returnCardToLibrary(
    gameId: string,
    card: string,
    side: 'top' | 'bottom',
    position: number
  ): ReturnCardToLibraryResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    const normalizedPosition = Math.max(0, Math.min(position, game.library.length))
    const insertIndex =
      side === 'top'
        ? normalizedPosition
        : Math.max(0, game.library.length - normalizedPosition)

    game.library.splice(insertIndex, 0, card)

    return {
      ok: true,
      cardsRemaining: game.library.length,
      insertedFromTop: insertIndex,
      insertedFromBottom: game.library.length - 1 - insertIndex,
    }
  }

  returnCardsToLibrary(
    gameId: string,
    cards: readonly string[],
    side: 'top' | 'bottom',
    randomizeOrder: boolean
  ): ReturnCardsToLibraryResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    const cardsToInsert = randomizeOrder ? shuffle(cards, game.random) : [...cards]

    for (const card of cardsToInsert) {
      if (side === 'top') {
        game.library.unshift(card)
      } else {
        game.library.push(card)
      }
    }

    return {
      ok: true,
      cards: cardsToInsert,
      cardsRemaining: game.library.length,
    }
  }

  shuffleLibrary(gameId: string): ShuffleLibraryResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    game.library = shuffle(game.library, game.random)

    return {
      ok: true,
      cardsRemaining: game.library.length,
    }
  }

  saveOpeningHandSnapshot(
    gameId: string,
    startingHand: readonly string[]
  ): SaveOpeningHandSnapshotResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    game.openingHandSnapshot = createOpeningHandSnapshot(
      startingHand,
      game.library,
      game.commanders.length,
      game.mulliganCount
    )

    return {
      ok: true,
      startingHand: [...game.openingHandSnapshot.startingHand],
      library: [...game.openingHandSnapshot.library],
      validation: { ...game.openingHandSnapshot.validation },
    }
  }

  getOpeningHandSnapshotStatus(gameId: string): GetOpeningHandSnapshotStatusResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    return {
      ok: true,
      hasSnapshot: Boolean(game.openingHandSnapshot),
      snapshot: game.openingHandSnapshot
        ? {
            startingHand: [...game.openingHandSnapshot.startingHand],
            library: [...game.openingHandSnapshot.library],
            validation: { ...game.openingHandSnapshot.validation },
          }
        : undefined,
    }
  }

  getGamePromptContext(gameId: string): GetGamePromptContextResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    return {
      ok: true,
      gameId: game.id,
      commanders: game.commanders.map((card) => ({ ...card })),
      initialLibrary: game.initialLibrary.map((card) => ({ ...card })),
      currentLibrary: [...game.library].sort((leftCard, rightCard) => leftCard.localeCompare(rightCard)),
      openingHandSnapshot: game.openingHandSnapshot
        ? {
            startingHand: [...game.openingHandSnapshot.startingHand],
            library: [...game.openingHandSnapshot.library],
            validation: { ...game.openingHandSnapshot.validation },
          }
        : undefined,
    }
  }

  private deleteExpiredGames() {
    const expirationCutoff = Date.now() - ONE_HOUR_IN_MS

    for (const [gameId, game] of this.games.entries()) {
      if (game.createdAt < expirationCutoff) {
        this.games.delete(gameId)
        this.onDeleteGame?.(gameId)
      }
    }
  }
}

function shuffle<T>(cards: readonly T[], random: () => number) {
  const shuffledCards = [...cards]

  for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1))
    const currentCard = shuffledCards[index]

    shuffledCards[index] = shuffledCards[swapIndex]
    shuffledCards[swapIndex] = currentCard
  }

  return shuffledCards
}

function normalizeSeed(seed: number | undefined) {
  if (typeof seed === 'number' && Number.isInteger(seed)) {
    return seed >>> 0
  }

  return randomInt(0, 2 ** 32)
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let next = Math.imul(state ^ (state >>> 15), state | 1)
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61)

    return ((next ^ (next >>> 14)) >>> 0) / 4294967296
  }
}

function sortCardsAlphabetically(cards: readonly GameCard[]) {
  return [...cards].sort((leftCard, rightCard) =>
    leftCard.name.localeCompare(rightCard.name)
  )
}

function createOpeningHandSnapshot(
  startingHand: readonly string[],
  library: readonly string[],
  commanderCount: number,
  mulliganCount: number
): OpeningHandSnapshot {
  return {
    startingHand: [...startingHand],
    library: [...library],
    validation: createOpeningHandSnapshotValidation(
      startingHand.length,
      library.length,
      commanderCount,
      mulliganCount
    ),
  }
}

function createOpeningHandSnapshotValidation(
  startingHandSize: number,
  librarySize: number,
  commanderCount: number,
  mulliganCount: number
): OpeningHandSnapshotValidation {
  const expectedStartingHandSize = getExpectedStartingHandSize(mulliganCount)
  const totalGameCards = startingHandSize + librarySize + commanderCount
  const hasValidStartingHandSize = startingHandSize === expectedStartingHandSize
  const hasValidTotalGameCards = totalGameCards === EXPECTED_GAME_CARDS
  const isValid = hasValidStartingHandSize && hasValidTotalGameCards
  const message = isValid
    ? `Opening-hand snapshot is valid: mulligans ${mulliganCount}, kept ${startingHandSize}/${expectedStartingHandSize} card(s), library ${librarySize}, commanders ${commanderCount}, total ${totalGameCards}.`
    : `Opening-hand snapshot is invalid: mulligans ${mulliganCount}, kept ${startingHandSize}/${expectedStartingHandSize} card(s), library ${librarySize}, commanders ${commanderCount}, total ${totalGameCards}/${EXPECTED_GAME_CARDS}.`

  return {
    isValid,
    message,
    totalGameCards,
    expectedGameCards: EXPECTED_GAME_CARDS,
    startingHandSize,
    expectedStartingHandSize,
    librarySize,
    commanderCount,
    mulliganCount,
  }
}

function getExpectedStartingHandSize(mulliganCount: number) {
  return STARTING_HAND_SIZE - Math.max(0, mulliganCount - 1)
}


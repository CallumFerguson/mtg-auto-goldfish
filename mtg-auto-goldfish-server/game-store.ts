import { randomInt, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'

const ONE_HOUR_IN_MS = 60 * 60 * 1000
const STARTING_HAND_SIZE = 7
const EXPECTED_GAME_CARDS = 100
const GAME_STORE_FILE_VERSION = 1

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
  randomState: number
}

type PersistedGameStore = {
  version: 1
  games: GameRecord[]
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

export type TakeCardsFromLibraryMatch = {
  requestedCard: string
  foundCard: string | null
}

export type TakeCardsFromLibraryResult =
  | {
      ok: true
      matches: TakeCardsFromLibraryMatch[]
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

export type ResetGameToInitialStateResult =
  | {
      ok: true
      cardsRemaining: number
    }
  | {
      ok: false
      reason: 'game_not_found'
    }

export type RestoreOpeningHandSnapshotResult =
  | {
      ok: true
      cardsRemaining: number
      startingHand: string[]
      mulliganCount: number
    }
  | {
      ok: false
      reason: 'game_not_found' | 'opening_hand_snapshot_not_found'
    }

export type GameStoreOptions = {
  onDeleteGame?: (gameId: string) => void
  persistencePath?: string
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
  private readonly persistencePath?: string

  constructor(options: GameStoreOptions = {}) {
    this.onDeleteGame = options.onDeleteGame
    this.persistencePath = options.persistencePath
    this.loadPersistedGames()

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
    const sortedInitialLibrary = sortCardsAlphabetically(deck)
    const game: GameRecord = {
      id,
      createdAt: Date.now(),
      seed: resolvedSeed,
      commanders: [...commanders],
      initialLibrary: sortedInitialLibrary,
      library: [],
      openingHandSnapshot: undefined,
      hasDrawnStartingHand: false,
      mulliganCount: 0,
      randomState: resolvedSeed >>> 0,
    }

    game.library = shuffle(deck.map((card) => card.name), () => nextRandom(game))

    this.games.set(id, game)
    this.persistGames()

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
    this.persistGames()

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
    this.persistGames()

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
    this.persistGames()

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

    game.library = shuffle(game.initialLibrary.map((card) => card.name), () =>
      nextRandom(game)
    )
    game.mulliganCount += 1

    const cards = game.library.splice(0, STARTING_HAND_SIZE)
    this.persistGames()

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
    this.persistGames()

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

    const cardsToInsert = randomizeOrder
      ? shuffle(cards, () => nextRandom(game))
      : [...cards]

    for (const card of cardsToInsert) {
      if (side === 'top') {
        game.library.unshift(card)
      } else {
        game.library.push(card)
      }
    }

    this.persistGames()

    return {
      ok: true,
      cards: cardsToInsert,
      cardsRemaining: game.library.length,
    }
  }

  takeCardsFromLibrary(
    gameId: string,
    requestedCards: readonly string[]
  ): TakeCardsFromLibraryResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    const matches = requestedCards.map((requestedCard) => {
      const matchedIndex = findBestLibraryMatchIndex(game.library, requestedCard)

      if (matchedIndex === -1) {
        return {
          requestedCard,
          foundCard: null,
        }
      }

      const [foundCard] = game.library.splice(matchedIndex, 1)

      return {
        requestedCard,
        foundCard,
      }
    })

    this.persistGames()

    return {
      ok: true,
      matches,
      cardsRemaining: game.library.length,
    }
  }

  shuffleLibrary(gameId: string): ShuffleLibraryResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    game.library = shuffle(game.library, () => nextRandom(game))
    this.persistGames()

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
    this.persistGames()

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

  resetGameToInitialState(gameId: string): ResetGameToInitialStateResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    game.randomState = game.seed >>> 0
    game.library = shuffle(game.initialLibrary.map((card) => card.name), () =>
      nextRandom(game)
    )
    game.openingHandSnapshot = undefined
    game.hasDrawnStartingHand = false
    game.mulliganCount = 0
    this.persistGames()

    return {
      ok: true,
      cardsRemaining: game.library.length,
    }
  }

  restoreOpeningHandSnapshot(gameId: string): RestoreOpeningHandSnapshotResult {
    this.deleteExpiredGames()

    const game = this.games.get(gameId)

    if (!game) {
      return { ok: false, reason: 'game_not_found' }
    }

    if (!game.openingHandSnapshot) {
      return { ok: false, reason: 'opening_hand_snapshot_not_found' }
    }

    game.library = [...game.openingHandSnapshot.library]
    game.hasDrawnStartingHand = true
    game.mulliganCount = game.openingHandSnapshot.validation.mulliganCount
    this.persistGames()

    return {
      ok: true,
      cardsRemaining: game.library.length,
      startingHand: [...game.openingHandSnapshot.startingHand],
      mulliganCount: game.mulliganCount,
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
      currentLibrary: [...game.library].sort((leftCard, rightCard) =>
        leftCard.localeCompare(rightCard)
      ),
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
    let deletedAnyGames = false

    for (const [gameId, game] of this.games.entries()) {
      if (game.createdAt < expirationCutoff) {
        this.games.delete(gameId)
        this.onDeleteGame?.(gameId)
        deletedAnyGames = true
      }
    }

    if (deletedAnyGames) {
      this.persistGames()
    }
  }

  private loadPersistedGames() {
    if (!this.persistencePath || !existsSync(this.persistencePath)) {
      return
    }

    try {
      const rawValue = readFileSync(this.persistencePath, 'utf8')

      if (!rawValue.trim()) {
        return
      }

      const parsedValue = JSON.parse(rawValue) as Partial<PersistedGameStore>

      if (
        parsedValue.version !== GAME_STORE_FILE_VERSION ||
        !Array.isArray(parsedValue.games)
      ) {
        return
      }

      for (const game of parsedValue.games) {
        if (!isValidPersistedGameRecord(game)) {
          continue
        }

        this.games.set(game.id, {
          ...game,
          commanders: game.commanders.map((card) => ({ ...card })),
          initialLibrary: game.initialLibrary.map((card) => ({ ...card })),
          library: [...game.library],
          openingHandSnapshot: game.openingHandSnapshot
            ? {
                startingHand: [...game.openingHandSnapshot.startingHand],
                library: [...game.openingHandSnapshot.library],
                validation: { ...game.openingHandSnapshot.validation },
              }
            : undefined,
        })
      }

      this.deleteExpiredGames()
    } catch (error) {
      console.warn(
        '[game_store_persist]',
        error instanceof Error
          ? `Failed to load persisted game store: ${error.message}`
          : 'Failed to load persisted game store.'
      )
    }
  }

  private persistGames() {
    if (!this.persistencePath) {
      return
    }

    const persistedValue: PersistedGameStore = {
      version: GAME_STORE_FILE_VERSION,
      games: Array.from(this.games.values()).map((game) => ({
        ...game,
        commanders: game.commanders.map((card) => ({ ...card })),
        initialLibrary: game.initialLibrary.map((card) => ({ ...card })),
        library: [...game.library],
        openingHandSnapshot: game.openingHandSnapshot
          ? {
              startingHand: [...game.openingHandSnapshot.startingHand],
              library: [...game.openingHandSnapshot.library],
              validation: { ...game.openingHandSnapshot.validation },
            }
          : undefined,
      })),
    }

    mkdirSync(dirname(this.persistencePath), { recursive: true })

    const temporaryPath = `${this.persistencePath}.tmp`
    writeFileSync(temporaryPath, JSON.stringify(persistedValue, null, 2))
    renameSync(temporaryPath, this.persistencePath)
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

function nextRandom(game: Pick<GameRecord, 'randomState'>) {
  game.randomState = (game.randomState + 0x6d2b79f5) >>> 0
  let next = Math.imul(
    game.randomState ^ (game.randomState >>> 15),
    game.randomState | 1
  )
  next ^= next + Math.imul(next ^ (next >>> 7), next | 61)

  return ((next ^ (next >>> 14)) >>> 0) / 4294967296
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

function isValidPersistedGameRecord(value: unknown): value is GameRecord {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const record = value as Partial<GameRecord>

  return (
    typeof record.id === 'string' &&
    typeof record.createdAt === 'number' &&
    typeof record.seed === 'number' &&
    Array.isArray(record.commanders) &&
    record.commanders.every(isGameCard) &&
    Array.isArray(record.initialLibrary) &&
    record.initialLibrary.every(isGameCard) &&
    Array.isArray(record.library) &&
    record.library.every((card) => typeof card === 'string') &&
    typeof record.hasDrawnStartingHand === 'boolean' &&
    typeof record.mulliganCount === 'number' &&
    typeof record.randomState === 'number' &&
    (record.openingHandSnapshot === undefined ||
      isOpeningHandSnapshot(record.openingHandSnapshot))
  )
}

function isGameCard(value: unknown): value is GameCard {
  return (
    value !== null &&
    typeof value === 'object' &&
    'name' in value &&
    typeof value.name === 'string' &&
    'cardText' in value &&
    typeof value.cardText === 'string'
  )
}

function isOpeningHandSnapshot(value: unknown): value is OpeningHandSnapshot {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const snapshot = value as Partial<OpeningHandSnapshot>

  return (
    Array.isArray(snapshot.startingHand) &&
    snapshot.startingHand.every((card) => typeof card === 'string') &&
    Array.isArray(snapshot.library) &&
    snapshot.library.every((card) => typeof card === 'string') &&
    snapshot.validation !== undefined &&
    isOpeningHandSnapshotValidation(snapshot.validation)
  )
}

function isOpeningHandSnapshotValidation(
  value: unknown
): value is OpeningHandSnapshotValidation {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const validation = value as Partial<OpeningHandSnapshotValidation>

  return (
    typeof validation.isValid === 'boolean' &&
    typeof validation.message === 'string' &&
    typeof validation.totalGameCards === 'number' &&
    typeof validation.expectedGameCards === 'number' &&
    typeof validation.startingHandSize === 'number' &&
    typeof validation.expectedStartingHandSize === 'number' &&
    typeof validation.librarySize === 'number' &&
    typeof validation.commanderCount === 'number' &&
    typeof validation.mulliganCount === 'number'
  )
}

function findBestLibraryMatchIndex(
  library: readonly string[],
  requestedCard: string
) {
  const normalizedRequestedCard = normalizeCardNameForFuzzyMatch(requestedCard)

  if (!normalizedRequestedCard) {
    return -1
  }

  let bestMatchIndex = -1
  let bestMatchScore = Number.NEGATIVE_INFINITY
  let bestMatchDistance = Number.POSITIVE_INFINITY

  for (const [index, card] of library.entries()) {
    const normalizedCard = normalizeCardNameForFuzzyMatch(card)

    if (!normalizedCard) {
      continue
    }

    const distance = levenshteinDistance(normalizedRequestedCard, normalizedCard)
    const maxLength = Math.max(normalizedRequestedCard.length, normalizedCard.length)
    const score = maxLength === 0 ? 1 : 1 - distance / maxLength

    if (
      score > bestMatchScore ||
      (score === bestMatchScore && distance < bestMatchDistance) ||
      (
        score === bestMatchScore &&
        distance === bestMatchDistance &&
        card.localeCompare(library[bestMatchIndex] ?? '') < 0
      )
    ) {
      bestMatchIndex = index
      bestMatchScore = score
      bestMatchDistance = distance
    }
  }

  if (bestMatchIndex === -1) {
    return -1
  }

  const matchedCard = library[bestMatchIndex]
  const normalizedMatchedCard = normalizeCardNameForFuzzyMatch(matchedCard)

  if (
    !isReasonablyCloseFuzzyMatch(
      normalizedRequestedCard,
      normalizedMatchedCard,
      bestMatchDistance,
      bestMatchScore
    )
  ) {
    return -1
  }

  return bestMatchIndex
}

function normalizeCardNameForFuzzyMatch(cardName: string) {
  return cardName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function isReasonablyCloseFuzzyMatch(
  requestedCard: string,
  candidateCard: string,
  distance: number,
  score: number
) {
  if (requestedCard === candidateCard) {
    return true
  }

  const maxLength = Math.max(requestedCard.length, candidateCard.length)
  const lengthDifference = Math.abs(requestedCard.length - candidateCard.length)
  const allowedDistance = Math.max(1, Math.floor(maxLength * 0.25))

  if (lengthDifference > Math.max(2, Math.floor(maxLength * 0.3))) {
    return false
  }

  return distance <= allowedDistance && score >= 0.72
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) {
    return 0
  }

  if (left.length === 0) {
    return right.length
  }

  if (right.length === 0) {
    return left.length
  }

  const previousRow = Array.from(
    { length: right.length + 1 },
    (_value, index) => index
  )

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let previousDiagonal = previousRow[0]
    previousRow[0] = leftIndex + 1

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const currentValue = previousRow[rightIndex + 1]
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1

      previousRow[rightIndex + 1] = Math.min(
        previousRow[rightIndex + 1] + 1,
        previousRow[rightIndex] + 1,
        previousDiagonal + substitutionCost
      )

      previousDiagonal = currentValue
    }
  }

  return previousRow[right.length]
}

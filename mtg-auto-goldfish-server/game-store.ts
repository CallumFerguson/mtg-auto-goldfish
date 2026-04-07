import { randomInt, randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"

const STARTING_HAND_SIZE = 7
const EXPECTED_GAME_CARDS = 100

type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">

type GameRow = {
  id: string
  created_at: Date | string
  seed: string
  commanders: unknown
  initial_library: unknown
  library: unknown
  current_turn: number
  current_game_state: string | null
  opening_hand_snapshot: unknown | null
  turn_snapshots: unknown
  active_turn_simulation: unknown | null
  has_drawn_starting_hand: boolean
  mulligan_count: number
  random_state: string
}

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

export type TurnSnapshot = {
  turnNumber: number
  openingHand: string[]
  library: string[]
  gameState?: string
}

export type SimulationRunKind = "opening_hand" | "turn"
export type SimulationRunStatus = "running" | "succeeded" | "failed" | "aborted"

export type CreateSimulationRunInput = {
  gameId: string
  kind: SimulationRunKind
  promptText: string
  turnNumber?: number
  provider?: string
}

export type AppendSimulationEventInput = {
  eventType: string
  eventTime?: Date
  reasoningTextDelta?: string
  messageTextDelta?: string
  toolName?: string
  toolProvider?: string
  toolStatusEvent?: string
  argumentsText?: string
  outputText?: string
  structuredContent?: Record<string, unknown>
  uiMetadata?: Record<string, unknown>
  errorText?: string
  metadata?: Record<string, unknown>
}

export type CompleteSimulationRunInput = {
  simulationRunId: string
  status: Exclude<SimulationRunStatus, "running">
  modelKey?: string
  modelDisplayName?: string
  modelSizeBytes?: number
  finalResultText?: string
  errorMessage?: string
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

type ActiveTurnSimulation = {
  turnNumber: number
  hasUpdatedGameState: boolean
}

type GameRecord = {
  id: string
  createdAt: number
  seed: number
  commanders: GameCard[]
  initialLibrary: GameCard[]
  library: string[]
  currentTurn: number
  currentGameState?: string
  openingHandSnapshot?: OpeningHandSnapshot
  turnSnapshots: TurnSnapshot[]
  activeTurnSimulation?: ActiveTurnSimulation
  hasDrawnStartingHand: boolean
  mulliganCount: number
  randomState: number
}

export type DrawResult =
  | {
      ok: true
      cards: string[]
      cardsRemaining: number
    }
  | {
      ok: false
      reason: "game_not_found" | "empty_library"
    }

export type DrawStartingHandResult =
  | DrawResult
  | {
      ok: false
      reason: "starting_hand_already_drawn"
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
      reason: "game_not_found" | "starting_hand_not_drawn"
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
      reason: "game_not_found"
    }

export type ReturnCardsToLibraryResult =
  | {
      ok: true
      cards: string[]
      cardsRemaining: number
    }
  | {
      ok: false
      reason: "game_not_found"
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
      reason: "game_not_found"
    }

export type ShuffleLibraryResult =
  | {
      ok: true
      cardsRemaining: number
    }
  | {
      ok: false
      reason: "game_not_found"
    }

export type GetGamePromptContextResult =
  | {
      ok: true
      gameId: string
      commanders: GameCard[]
      initialLibrary: GameCard[]
      currentLibrary: string[]
      currentTurn: number
      currentGameState?: string
      openingHandSnapshot?: OpeningHandSnapshot
      turnSnapshots: TurnSnapshot[]
    }
  | {
      ok: false
      reason: "game_not_found"
    }

export type SaveOpeningHandSnapshotResult =
  | ({
      ok: true
    } & OpeningHandSnapshot)
  | {
      ok: false
      reason: "game_not_found"
    }

export type GetOpeningHandSnapshotStatusResult =
  | {
      ok: true
      hasSnapshot: boolean
      snapshot?: OpeningHandSnapshot
    }
  | {
      ok: false
      reason: "game_not_found"
    }

export type ResetGameToInitialStateResult =
  | {
      ok: true
      cardsRemaining: number
    }
  | {
      ok: false
      reason: "game_not_found"
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
      reason: "game_not_found" | "opening_hand_snapshot_not_found"
    }

export type RestoreTurnSnapshotResult =
  | {
      ok: true
      cardsRemaining: number
      turnNumber: number
      gameState?: string
    }
  | {
      ok: false
      reason: "game_not_found" | "turn_snapshot_not_found"
    }

export type StartTurnSimulationResult =
  | {
      ok: true
      turnNumber: number
    }
  | {
      ok: false
      reason: "game_not_found" | "turn_simulation_already_active"
    }

export type GetActiveTurnSimulationResult =
  | {
      ok: true
      turnNumber: number
      hasUpdatedGameState: boolean
    }
  | {
      ok: false
      reason: "game_not_found" | "no_active_turn_simulation"
    }

export type EndTurnSimulationResult =
  | {
      ok: true
      turnNumber?: number
      turnWasUpdated: boolean
    }
  | {
      ok: false
      reason: "game_not_found"
    }

export type UpdateGameStateResult =
  | {
      ok: true
      turnNumber: number
      nextTurnNumber: number
      gameState: string
    }
  | {
      ok: false
      reason:
        | "game_not_found"
        | "no_active_turn_simulation"
        | "turn_already_updated"
    }

type CreateGameResult = {
  gameId: string
  seed: number
  createdAt: string
  commanderCount: number
  cardsRemaining: number
  totalGames: number
}

type LockedGameMutationResult<TResult> = {
  persist?: boolean
  result: TResult
}

export class GameStore {
  private readonly pool: Pool

  constructor(pool: Pool) {
    this.pool = pool
  }

  async createGame(
    commanders: readonly GameCard[],
    deck: readonly GameCard[],
    seed?: number
  ): Promise<CreateGameResult> {
    const id = randomUUID()
    const resolvedSeed = normalizeSeed(seed)
    const sortedInitialLibrary = sortCardsAlphabetically(deck)
    const game: GameRecord = {
      id,
      createdAt: Date.now(),
      seed: resolvedSeed,
      commanders: cloneGameCards(commanders),
      initialLibrary: sortedInitialLibrary,
      library: [],
      currentTurn: 1,
      currentGameState: undefined,
      openingHandSnapshot: undefined,
      turnSnapshots: [],
      activeTurnSimulation: undefined,
      hasDrawnStartingHand: false,
      mulliganCount: 0,
      randomState: resolvedSeed >>> 0,
    }

    game.library = shuffle(
      deck.map((card) => card.name),
      () => nextRandom(game)
    )

    return this.withTransaction(async (client) => {
      await this.insertGame(client, game)
      const totalGames = await this.getTotalGames(client)

      return {
        gameId: game.id,
        seed: game.seed,
        createdAt: new Date(game.createdAt).toISOString(),
        commanderCount: game.commanders.length,
        cardsRemaining: game.library.length,
        totalGames,
      }
    })
  }

  async hasGame(gameId: string) {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM games WHERE id = $1) AS "exists"`,
      [gameId]
    )

    return result.rows[0]?.exists ?? false
  }

  async drawCardsFromTop(gameId: string, count: number): Promise<DrawResult> {
    return this.withLockedGame<DrawResult>(gameId, (game) => {
      if (game.library.length === 0) {
        return {
          result: { ok: false, reason: "empty_library" } as const,
        }
      }

      const cards = game.library.splice(0, count)

      return {
        persist: true,
        result: {
          ok: true,
          cards,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async drawCardsFromBottom(
    gameId: string,
    count: number
  ): Promise<DrawResult> {
    return this.withLockedGame<DrawResult>(gameId, (game) => {
      if (game.library.length === 0) {
        return {
          result: { ok: false, reason: "empty_library" } as const,
        }
      }

      const cards = game.library.splice(-count).reverse()

      return {
        persist: true,
        result: {
          ok: true,
          cards,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async drawStartingHand(gameId: string): Promise<DrawStartingHandResult> {
    return this.withLockedGame<DrawStartingHandResult>(gameId, (game) => {
      if (game.hasDrawnStartingHand) {
        return {
          result: {
            ok: false,
            reason: "starting_hand_already_drawn",
          } as const,
        }
      }

      if (game.library.length === 0) {
        return {
          result: { ok: false, reason: "empty_library" } as const,
        }
      }

      game.hasDrawnStartingHand = true
      const cards = game.library.splice(0, STARTING_HAND_SIZE)

      return {
        persist: true,
        result: {
          ok: true,
          cards,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async mulligan(gameId: string): Promise<MulliganResult> {
    return this.withLockedGame<MulliganResult>(gameId, (game) => {
      if (!game.hasDrawnStartingHand) {
        return {
          result: {
            ok: false,
            reason: "starting_hand_not_drawn",
          } as const,
        }
      }

      game.library = shuffle(
        game.initialLibrary.map((card) => card.name),
        () => nextRandom(game)
      )
      game.mulliganCount += 1

      const cards = game.library.splice(0, STARTING_HAND_SIZE)

      return {
        persist: true,
        result: {
          ok: true,
          cards,
          cardsRemaining: game.library.length,
          mulliganCount: game.mulliganCount,
          cardsToBottomIfKept: Math.max(0, game.mulliganCount - 1),
        } as const,
      }
    })
  }

  async returnCardToLibrary(
    gameId: string,
    card: string,
    side: "top" | "bottom",
    position: number
  ): Promise<ReturnCardToLibraryResult> {
    return this.withLockedGame<ReturnCardToLibraryResult>(gameId, (game) => {
      const normalizedPosition = Math.max(
        0,
        Math.min(position, game.library.length)
      )
      const insertIndex =
        side === "top"
          ? normalizedPosition
          : Math.max(0, game.library.length - normalizedPosition)

      game.library.splice(insertIndex, 0, card)

      return {
        persist: true,
        result: {
          ok: true,
          cardsRemaining: game.library.length,
          insertedFromTop: insertIndex,
          insertedFromBottom: game.library.length - 1 - insertIndex,
        } as const,
      }
    })
  }

  async returnCardsToLibrary(
    gameId: string,
    cards: readonly string[],
    side: "top" | "bottom",
    randomizeOrder: boolean
  ): Promise<ReturnCardsToLibraryResult> {
    return this.withLockedGame<ReturnCardsToLibraryResult>(gameId, (game) => {
      const cardsToInsert = randomizeOrder
        ? shuffle(cards, () => nextRandom(game))
        : [...cards]

      for (const card of cardsToInsert) {
        if (side === "top") {
          game.library.unshift(card)
        } else {
          game.library.push(card)
        }
      }

      return {
        persist: true,
        result: {
          ok: true,
          cards: cardsToInsert,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async takeCardsFromLibrary(
    gameId: string,
    requestedCards: readonly string[]
  ): Promise<TakeCardsFromLibraryResult> {
    return this.withLockedGame<TakeCardsFromLibraryResult>(gameId, (game) => {
      const matches = requestedCards.map((requestedCard) => {
        const matchedIndex = findBestLibraryMatchIndex(
          game.library,
          requestedCard
        )

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

      return {
        persist: true,
        result: {
          ok: true,
          matches,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async shuffleLibrary(gameId: string): Promise<ShuffleLibraryResult> {
    return this.withLockedGame<ShuffleLibraryResult>(gameId, (game) => {
      game.library = shuffle(game.library, () => nextRandom(game))

      return {
        persist: true,
        result: {
          ok: true,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async saveOpeningHandSnapshot(
    gameId: string,
    startingHand: readonly string[]
  ): Promise<SaveOpeningHandSnapshotResult> {
    return this.withLockedGame<SaveOpeningHandSnapshotResult>(gameId, (game) => {
      game.openingHandSnapshot = createOpeningHandSnapshot(
        startingHand,
        game.library,
        game.commanders.length,
        game.mulliganCount
      )
      game.currentTurn = 1
      game.currentGameState = undefined
      game.turnSnapshots = [
        createTurnSnapshot(
          1,
          game.openingHandSnapshot.startingHand,
          game.openingHandSnapshot.library
        ),
      ]
      game.activeTurnSimulation = undefined

      return {
        persist: true,
        result: {
          ok: true,
          startingHand: [...game.openingHandSnapshot.startingHand],
          library: [...game.openingHandSnapshot.library],
          validation: { ...game.openingHandSnapshot.validation },
        } as const,
      }
    })
  }

  async getOpeningHandSnapshotStatus(
    gameId: string
  ): Promise<GetOpeningHandSnapshotStatusResult> {
    const game = await this.readGame(this.pool, gameId)

    if (!game) {
      return { ok: false, reason: "game_not_found" }
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

  async resetGameToInitialState(
    gameId: string
  ): Promise<ResetGameToInitialStateResult> {
    return this.withLockedGame<ResetGameToInitialStateResult>(gameId, (game) => {
      game.randomState = game.seed >>> 0
      game.library = shuffle(
        game.initialLibrary.map((card) => card.name),
        () => nextRandom(game)
      )
      game.currentTurn = 1
      game.currentGameState = undefined
      game.openingHandSnapshot = undefined
      game.turnSnapshots = []
      game.activeTurnSimulation = undefined
      game.hasDrawnStartingHand = false
      game.mulliganCount = 0

      return {
        persist: true,
        result: {
          ok: true,
          cardsRemaining: game.library.length,
        } as const,
      }
    })
  }

  async restoreOpeningHandSnapshot(
    gameId: string
  ): Promise<RestoreOpeningHandSnapshotResult> {
    return this.withLockedGame<RestoreOpeningHandSnapshotResult>(gameId, (game) => {
      if (!game.openingHandSnapshot) {
        return {
          result: {
            ok: false,
            reason: "opening_hand_snapshot_not_found",
          } as const,
        }
      }

      const turnOneSnapshot = game.turnSnapshots.find(
        (snapshot) => snapshot.turnNumber === 1
      )

      game.library = [...game.openingHandSnapshot.library]
      game.currentTurn = 1
      game.currentGameState = undefined
      game.turnSnapshots = turnOneSnapshot
        ? [cloneTurnSnapshot(turnOneSnapshot)]
        : []
      game.activeTurnSimulation = undefined
      game.hasDrawnStartingHand = true
      game.mulliganCount = game.openingHandSnapshot.validation.mulliganCount

      return {
        persist: true,
        result: {
          ok: true,
          cardsRemaining: game.library.length,
          startingHand: [...game.openingHandSnapshot.startingHand],
          mulliganCount: game.mulliganCount,
        } as const,
      }
    })
  }

  async restoreTurnSnapshot(
    gameId: string,
    turnNumber: number
  ): Promise<RestoreTurnSnapshotResult> {
    return this.withLockedGame<RestoreTurnSnapshotResult>(gameId, (game) => {
      const snapshot = game.turnSnapshots.find(
        (currentSnapshot) => currentSnapshot.turnNumber === turnNumber
      )

      if (!snapshot) {
        return {
          result: {
            ok: false,
            reason: "turn_snapshot_not_found",
          } as const,
        }
      }

      game.library = [...snapshot.library]
      game.currentTurn = snapshot.turnNumber
      game.currentGameState = snapshot.gameState
      game.turnSnapshots = game.turnSnapshots
        .filter((currentSnapshot) => currentSnapshot.turnNumber <= turnNumber)
        .map(cloneTurnSnapshot)
      game.activeTurnSimulation = undefined
      game.hasDrawnStartingHand = true
      game.mulliganCount = game.openingHandSnapshot?.validation.mulliganCount ?? 0

      return {
        persist: true,
        result: {
          ok: true,
          cardsRemaining: game.library.length,
          turnNumber: snapshot.turnNumber,
          gameState: snapshot.gameState,
        } as const,
      }
    })
  }

  async startTurnSimulation(
    gameId: string
  ): Promise<StartTurnSimulationResult> {
    return this.withLockedGame<StartTurnSimulationResult>(gameId, (game) => {
      if (game.activeTurnSimulation) {
        return {
          result: {
            ok: false,
            reason: "turn_simulation_already_active",
          } as const,
        }
      }

      game.activeTurnSimulation = {
        turnNumber: game.currentTurn,
        hasUpdatedGameState: false,
      }

      return {
        persist: true,
        result: {
          ok: true,
          turnNumber: game.currentTurn,
        } as const,
      }
    })
  }

  async getActiveTurnSimulation(
    gameId: string
  ): Promise<GetActiveTurnSimulationResult> {
    const game = await this.readGame(this.pool, gameId)

    if (!game) {
      return { ok: false, reason: "game_not_found" }
    }

    if (!game.activeTurnSimulation) {
      return { ok: false, reason: "no_active_turn_simulation" }
    }

    return {
      ok: true,
      turnNumber: game.activeTurnSimulation.turnNumber,
      hasUpdatedGameState: game.activeTurnSimulation.hasUpdatedGameState,
    }
  }

  async endTurnSimulation(gameId: string): Promise<EndTurnSimulationResult> {
    return this.withLockedGame<EndTurnSimulationResult>(gameId, (game) => {
      const activeTurnSimulation = game.activeTurnSimulation
      game.activeTurnSimulation = undefined

      return {
        persist: activeTurnSimulation !== undefined,
        result: {
          ok: true,
          turnNumber: activeTurnSimulation?.turnNumber,
          turnWasUpdated: activeTurnSimulation?.hasUpdatedGameState ?? false,
        } as const,
      }
    })
  }

  async updateGameState(
    gameId: string,
    gameState: string
  ): Promise<UpdateGameStateResult> {
    return this.withLockedGame<UpdateGameStateResult>(gameId, (game) => {
      if (!game.activeTurnSimulation) {
        return {
          result: {
            ok: false,
            reason: "no_active_turn_simulation",
          } as const,
        }
      }

      if (game.activeTurnSimulation.hasUpdatedGameState) {
        return {
          result: {
            ok: false,
            reason: "turn_already_updated",
          } as const,
        }
      }

      const completedTurnNumber = game.activeTurnSimulation.turnNumber

      game.currentGameState = gameState
      game.currentTurn = completedTurnNumber + 1
      game.turnSnapshots = [
        ...game.turnSnapshots.filter(
          (snapshot) => snapshot.turnNumber <= completedTurnNumber
        ),
        createTurnSnapshot(
          game.currentTurn,
          game.openingHandSnapshot?.startingHand ?? [],
          game.library,
          gameState
        ),
      ]
      game.activeTurnSimulation = {
        ...game.activeTurnSimulation,
        hasUpdatedGameState: true,
      }

      return {
        persist: true,
        result: {
          ok: true,
          turnNumber: completedTurnNumber,
          nextTurnNumber: game.currentTurn,
          gameState,
        } as const,
      }
    })
  }

  async getGamePromptContext(
    gameId: string
  ): Promise<GetGamePromptContextResult> {
    const game = await this.readGame(this.pool, gameId)

    if (!game) {
      return { ok: false, reason: "game_not_found" }
    }

    return {
      ok: true,
      gameId: game.id,
      commanders: cloneGameCards(game.commanders),
      initialLibrary: cloneGameCards(game.initialLibrary),
      currentLibrary: [...game.library].sort((leftCard, rightCard) =>
        leftCard.localeCompare(rightCard)
      ),
      currentTurn: game.currentTurn,
      currentGameState: game.currentGameState,
      openingHandSnapshot: game.openingHandSnapshot
        ? {
            startingHand: [...game.openingHandSnapshot.startingHand],
            library: [...game.openingHandSnapshot.library],
            validation: { ...game.openingHandSnapshot.validation },
          }
        : undefined,
      turnSnapshots: game.turnSnapshots.map(cloneTurnSnapshot),
    }
  }

  async createSimulationRun(input: CreateSimulationRunInput) {
    const simulationRunId = randomUUID()

    await this.pool.query(
      `
        INSERT INTO simulation_runs (
          id,
          game_id,
          kind,
          turn_number,
          status,
          provider,
          prompt_text,
          prompt_length_chars
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8
        )
      `,
      [
        simulationRunId,
        input.gameId,
        input.kind,
        input.turnNumber ?? null,
        "running",
        input.provider ?? null,
        input.promptText,
        input.promptText.length,
      ]
    )

    return {
      simulationRunId,
    }
  }

  async appendSimulationEvents(
    simulationRunId: string,
    gameId: string,
    kind: SimulationRunKind,
    turnNumber: number | undefined,
    startSequenceIndex: number,
    events: readonly AppendSimulationEventInput[]
  ) {
    if (events.length === 0) {
      return
    }

    const values: unknown[] = []
    const tuples = events.map((event, index) => {
      const baseIndex = values.length

      values.push(
        randomUUID(),
        simulationRunId,
        gameId,
        kind,
        turnNumber ?? null,
        startSequenceIndex + index,
        event.eventType,
        event.eventTime ?? new Date(),
        event.reasoningTextDelta ?? null,
        event.messageTextDelta ?? null,
        event.toolName ?? null,
        event.toolProvider ?? null,
        event.toolStatusEvent ?? null,
        event.argumentsText ?? null,
        event.outputText ?? null,
        event.structuredContent === undefined
          ? null
          : serializeJson(event.structuredContent),
        event.uiMetadata === undefined ? null : serializeJson(event.uiMetadata),
        event.errorText ?? null,
        event.metadata === undefined ? null : serializeJson(event.metadata)
      )

      return `(
        $${baseIndex + 1},
        $${baseIndex + 2},
        $${baseIndex + 3},
        $${baseIndex + 4},
        $${baseIndex + 5},
        $${baseIndex + 6},
        $${baseIndex + 7},
        $${baseIndex + 8},
        $${baseIndex + 9},
        $${baseIndex + 10},
        $${baseIndex + 11},
        $${baseIndex + 12},
        $${baseIndex + 13},
        $${baseIndex + 14},
        $${baseIndex + 15},
        $${baseIndex + 16}::jsonb,
        $${baseIndex + 17}::jsonb,
        $${baseIndex + 18},
        $${baseIndex + 19}::jsonb
      )`
    })

    await this.pool.query(
      `
        INSERT INTO simulation_events (
          id,
          simulation_run_id,
          game_id,
          kind,
          turn_number,
          sequence_index,
          event_type,
          event_time,
          reasoning_text_delta,
          message_text_delta,
          tool_name,
          tool_provider,
          tool_status_event,
          arguments_text,
          output_text,
          structured_content,
          ui_metadata,
          error_text,
          metadata
        ) VALUES ${tuples.join(",")}
      `,
      values
    )
  }

  async updateSimulationRunModel(
    simulationRunId: string,
    model: {
      key: string
      displayName: string
      sizeBytes: number
    }
  ) {
    await this.pool.query(
      `
        UPDATE simulation_runs
        SET
          model_key = $2,
          model_display_name = $3,
          model_size_bytes = $4,
          updated_at = NOW()
        WHERE id = $1
      `,
      [simulationRunId, model.key, model.displayName, String(model.sizeBytes)]
    )
  }

  async completeSimulationRun(input: CompleteSimulationRunInput) {
    await this.pool.query(
      `
        UPDATE simulation_runs
        SET
          status = $2,
          model_key = COALESCE($3, model_key),
          model_display_name = COALESCE($4, model_display_name),
          model_size_bytes = COALESCE($5, model_size_bytes),
          final_result_text = COALESCE($6, final_result_text),
          error_message = COALESCE($7, error_message),
          input_tokens = COALESCE($8, input_tokens),
          output_tokens = COALESCE($9, output_tokens),
          reasoning_tokens = COALESCE($10, reasoning_tokens),
          total_tokens = COALESCE($11, total_tokens),
          completed_at = NOW(),
          updated_at = NOW()
        WHERE id = $1
      `,
      [
        input.simulationRunId,
        input.status,
        input.modelKey ?? null,
        input.modelDisplayName ?? null,
        input.modelSizeBytes === undefined ? null : String(input.modelSizeBytes),
        input.finalResultText ?? null,
        input.errorMessage ?? null,
        input.inputTokens ?? null,
        input.outputTokens ?? null,
        input.reasoningTokens ?? null,
        input.totalTokens ?? null,
      ]
    )
  }

  private async withTransaction<TResult>(
    execute: (client: PoolClient) => Promise<TResult>
  ) {
    const client = await this.pool.connect()

    try {
      await client.query("BEGIN")
      const result = await execute(client)
      await client.query("COMMIT")
      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  }

  private async withLockedGame<TResult>(
    gameId: string,
    mutate: (game: GameRecord) => LockedGameMutationResult<TResult>
  ): Promise<TResult | { ok: false; reason: "game_not_found" }> {
    return this.withTransaction(async (client) => {
      const game = await this.readGame(client, gameId, true)

      if (!game) {
        return { ok: false, reason: "game_not_found" } as const
      }

      const { persist = false, result } = mutate(game)

      if (persist) {
        await this.saveGame(client, game)
      }

      return result
    })
  }

  private async insertGame(client: PoolClient, game: GameRecord) {
    await client.query(
      `
        INSERT INTO games (
          id,
          created_at,
          seed,
          random_state,
          current_turn,
          current_game_state,
          has_drawn_starting_hand,
          mulligan_count,
          commanders,
          initial_library,
          library,
          opening_hand_snapshot,
          turn_snapshots,
          active_turn_simulation
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12,
          $13,
          $14
        )
      `,
      [
        game.id,
        new Date(game.createdAt),
        String(game.seed),
        String(game.randomState),
        game.currentTurn,
        game.currentGameState ?? null,
        game.hasDrawnStartingHand,
        game.mulliganCount,
        serializeJson(game.commanders),
        serializeJson(game.initialLibrary),
        serializeJson(game.library),
        serializeNullableJson(game.openingHandSnapshot),
        serializeJson(game.turnSnapshots),
        serializeNullableJson(game.activeTurnSimulation),
      ]
    )
  }

  private async saveGame(client: PoolClient, game: GameRecord) {
    await client.query(
      `
        UPDATE games
        SET
          seed = $2,
          random_state = $3,
          current_turn = $4,
          current_game_state = $5,
          has_drawn_starting_hand = $6,
          mulligan_count = $7,
          commanders = $8,
          initial_library = $9,
          library = $10,
          opening_hand_snapshot = $11,
          turn_snapshots = $12,
          active_turn_simulation = $13
        WHERE id = $1
      `,
      [
        game.id,
        String(game.seed),
        String(game.randomState),
        game.currentTurn,
        game.currentGameState ?? null,
        game.hasDrawnStartingHand,
        game.mulliganCount,
        serializeJson(game.commanders),
        serializeJson(game.initialLibrary),
        serializeJson(game.library),
        serializeNullableJson(game.openingHandSnapshot),
        serializeJson(game.turnSnapshots),
        serializeNullableJson(game.activeTurnSimulation),
      ]
    )
  }

  private async readGame(
    queryable: Queryable,
    gameId: string,
    forUpdate = false
  ): Promise<GameRecord | undefined> {
    const result = await queryable.query<GameRow>(
      `
        SELECT
          id,
          created_at,
          seed::text AS seed,
          commanders,
          initial_library,
          library,
          current_turn,
          current_game_state,
          opening_hand_snapshot,
          turn_snapshots,
          active_turn_simulation,
          has_drawn_starting_hand,
          mulligan_count,
          random_state::text AS random_state
        FROM games
        WHERE id = $1
        ${forUpdate ? "FOR UPDATE" : ""}
      `,
      [gameId]
    )

    if (result.rowCount === 0) {
      return undefined
    }

    return hydrateGameRecord(result.rows[0])
  }

  private async getTotalGames(queryable: Queryable) {
    const result = await queryable.query<{ total_games: string }>(
      `SELECT COUNT(*)::text AS total_games FROM games`
    )

    return Number(result.rows[0]?.total_games ?? "0")
  }
}

function hydrateGameRecord(row: GameRow): GameRecord {
  return {
    id: row.id,
    createdAt: resolveTimestamp(row.created_at),
    seed: parseStoredInteger(row.seed, "seed"),
    commanders: parseGameCardArray(row.commanders, "commanders"),
    initialLibrary: parseGameCardArray(row.initial_library, "initial_library"),
    library: parseStringArray(row.library, "library"),
    currentTurn: row.current_turn,
    currentGameState: row.current_game_state ?? undefined,
    openingHandSnapshot:
      row.opening_hand_snapshot === null
        ? undefined
        : parseOpeningHandSnapshot(
            row.opening_hand_snapshot,
            "opening_hand_snapshot"
          ),
    turnSnapshots: parseTurnSnapshots(row.turn_snapshots, "turn_snapshots"),
    activeTurnSimulation:
      row.active_turn_simulation === null
        ? undefined
        : parseActiveTurnSimulation(
            row.active_turn_simulation,
            "active_turn_simulation"
          ),
    hasDrawnStartingHand: row.has_drawn_starting_hand,
    mulliganCount: row.mulligan_count,
    randomState: parseStoredInteger(row.random_state, "random_state"),
  }
}

function resolveTimestamp(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value)
  const timestamp = date.getTime()

  if (Number.isNaN(timestamp)) {
    throw new Error("Failed to parse stored game timestamp.")
  }

  return timestamp
}

function parseStoredInteger(value: string, fieldName: string) {
  const parsedValue = Number(value)

  if (!Number.isSafeInteger(parsedValue)) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return parsedValue
}

function parseGameCardArray(value: unknown, fieldName: string) {
  if (!Array.isArray(value) || !value.every(isGameCard)) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return cloneGameCards(value)
}

function parseStringArray(value: unknown, fieldName: string) {
  if (!Array.isArray(value) || !value.every((card) => typeof card === "string")) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return [...value]
}

function parseOpeningHandSnapshot(value: unknown, fieldName: string) {
  if (!isOpeningHandSnapshot(value)) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return {
    startingHand: [...value.startingHand],
    library: [...value.library],
    validation: { ...value.validation },
  }
}

function parseTurnSnapshots(value: unknown, fieldName: string) {
  if (!Array.isArray(value) || !value.every(isTurnSnapshot)) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return value.map(cloneTurnSnapshot)
}

function parseActiveTurnSimulation(value: unknown, fieldName: string) {
  if (!isActiveTurnSimulation(value)) {
    throw new Error(`Stored game field ${fieldName} is invalid.`)
  }

  return { ...value }
}

function serializeJson(value: unknown) {
  return JSON.stringify(value)
}

function serializeNullableJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value)
}

function cloneGameCards(cards: readonly GameCard[]) {
  return cards.map((card) => ({ ...card }))
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
  if (typeof seed === "number" && Number.isInteger(seed)) {
    return seed >>> 0
  }

  return randomInt(0, 2 ** 32)
}

function nextRandom(game: Pick<GameRecord, "randomState">) {
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

function createTurnSnapshot(
  turnNumber: number,
  openingHand: readonly string[],
  library: readonly string[],
  gameState?: string
): TurnSnapshot {
  return {
    turnNumber,
    openingHand: [...openingHand],
    library: [...library],
    gameState,
  }
}

function cloneTurnSnapshot(snapshot: TurnSnapshot): TurnSnapshot {
  return {
    turnNumber: snapshot.turnNumber,
    openingHand: [...snapshot.openingHand],
    library: [...snapshot.library],
    gameState: snapshot.gameState,
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

function isActiveTurnSimulation(value: unknown): value is ActiveTurnSimulation {
  if (value === null || typeof value !== "object") {
    return false
  }

  const activeTurnSimulation = value as Partial<ActiveTurnSimulation>

  return (
    typeof activeTurnSimulation.turnNumber === "number" &&
    typeof activeTurnSimulation.hasUpdatedGameState === "boolean"
  )
}

function isTurnSnapshot(value: unknown): value is TurnSnapshot {
  if (value === null || typeof value !== "object") {
    return false
  }

  const snapshot = value as Partial<TurnSnapshot>

  return (
    typeof snapshot.turnNumber === "number" &&
    Array.isArray(snapshot.openingHand) &&
    snapshot.openingHand.every((card) => typeof card === "string") &&
    Array.isArray(snapshot.library) &&
    snapshot.library.every((card) => typeof card === "string") &&
    (snapshot.gameState === undefined || typeof snapshot.gameState === "string")
  )
}

function isGameCard(value: unknown): value is GameCard {
  return (
    value !== null &&
    typeof value === "object" &&
    "name" in value &&
    typeof value.name === "string" &&
    "cardText" in value &&
    typeof value.cardText === "string"
  )
}

function isOpeningHandSnapshot(value: unknown): value is OpeningHandSnapshot {
  if (value === null || typeof value !== "object") {
    return false
  }

  const snapshot = value as Partial<OpeningHandSnapshot>

  return (
    Array.isArray(snapshot.startingHand) &&
    snapshot.startingHand.every((card) => typeof card === "string") &&
    Array.isArray(snapshot.library) &&
    snapshot.library.every((card) => typeof card === "string") &&
    snapshot.validation !== undefined &&
    isOpeningHandSnapshotValidation(snapshot.validation)
  )
}

function isOpeningHandSnapshotValidation(
  value: unknown
): value is OpeningHandSnapshotValidation {
  if (value === null || typeof value !== "object") {
    return false
  }

  const validation = value as Partial<OpeningHandSnapshotValidation>

  return (
    typeof validation.isValid === "boolean" &&
    typeof validation.message === "string" &&
    typeof validation.totalGameCards === "number" &&
    typeof validation.expectedGameCards === "number" &&
    typeof validation.startingHandSize === "number" &&
    typeof validation.expectedStartingHandSize === "number" &&
    typeof validation.librarySize === "number" &&
    typeof validation.commanderCount === "number" &&
    typeof validation.mulliganCount === "number"
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

    const distance = levenshteinDistance(
      normalizedRequestedCard,
      normalizedCard
    )
    const maxLength = Math.max(
      normalizedRequestedCard.length,
      normalizedCard.length
    )
    const score = maxLength === 0 ? 1 : 1 - distance / maxLength

    if (
      score > bestMatchScore ||
      (score === bestMatchScore && distance < bestMatchDistance) ||
      (score === bestMatchScore &&
        distance === bestMatchDistance &&
        card.localeCompare(library[bestMatchIndex] ?? "") < 0)
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
  return cardName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")
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


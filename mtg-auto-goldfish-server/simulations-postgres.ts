import { queryDatabase, withDatabaseTransaction } from "./db.js"

type DatabaseTransactionClient = Parameters<
  Parameters<typeof withDatabaseTransaction>[0]
>[0]

export type SimulationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type LlmRunStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"

export type LlmRunPhase = "opening_hand" | "turn" | "other"

export type LlmChunkKind =
  | "raw_event"
  | "message_delta"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "error"
  | "metadata"

export type CreateOpeningHandLlmRunInput = {
  simulationId: string
  provider: string
  model: string
  runtimeStreamKey: string
  fullPrompt: string
  requestPayload: unknown
}

export type OpeningHandLlmRun = {
  simulationId: string
  llmRunId: string
  attemptNumber: number
  runtimeStreamKey: string
  status: LlmRunStatus
}

export type LlmRunChunkInput = {
  sequence: number
  kind: LlmChunkKind
  providerEventType: string | null
  reasoningDelta: string | null
  outputDelta: string | null
  content: string | null
  payload: unknown
}

export type ActiveOpeningHandLlmRun = {
  simulationId: string
  llmRunId: string
  runtimeStreamKey: string
  status: LlmRunStatus
}

export type SimulationDebugLlmRunChunk = {
  id: number
  sequence: number
  kind: LlmChunkKind
  providerEventType: string | null
  reasoningDelta: string | null
  outputDelta: string | null
  content: string | null
  payload: unknown
  receivedAt: string
}

export type SimulationDebugLlmRun = {
  llmRunId: string
  phase: LlmRunPhase
  provider: string
  model: string
  status: LlmRunStatus
  runtimeStreamKey: string | null
  attemptNumber: number
  turnNumber?: number
  chunks: SimulationDebugLlmRunChunk[]
}

export type SimulationDebugInfo = {
  simulationId: string
  openingHandLlmRunCount: number
  turnLlmRunCount: number
  openingHandLlmRuns: SimulationDebugLlmRun[]
  turnLlmRuns: SimulationDebugLlmRun[]
}

export type SimulationSummary = {
  id: string
  deckId: string
  startingHandId: string | null
  seed: string
  library: string[]
  turnsToSimulate: number
  status: SimulationStatus
  createdAt: string
  updatedAt: string
}

export type LibraryShuffleResult = {
  simulationId: string
  cardsRemaining: number
}

export type LibraryDrawResult = {
  simulationId: string
  cards: string[]
  cardsRemaining: number
}

export type MulliganResult = LibraryDrawResult & {
  reason: string
  mulliganCount: number
  cardsToBottomIfKept: number
  reminder: string
  replacesPreviousOpeningHand: boolean
  alreadyDrewReplacementHand: boolean
}

export type LibraryReturnCardResult = {
  simulationId: string
  card: string
  side: "top" | "bottom"
  position: number
  insertedFromTop: number
  insertedFromBottom: number
  cardsRemaining: number
}

export type LibraryReturnCardsResult = {
  simulationId: string
  cards: string[]
  side: "top" | "bottom"
  randomizeOrder: boolean
  cardsRemaining: number
}

export type LibraryTakeCardsResult = {
  simulationId: string
  matches: {
    requestedCard: string
    foundCard: string | null
  }[]
  foundCards: string[]
  cardsRemaining: number
}

export type StartingHandCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

export type StartingHand = {
  id: string
  deckId: string
  name: string
  cards: StartingHandCard[]
  createdAt: string
  updatedAt: string
}

export type CreateStartingHandInput = {
  name: string
  cards: {
    deckCardId: number
    quantity: number
  }[]
}

export type CreateSimulationInput = {
  seed: string
  turnsToSimulate: number
  startingHandId: string | null
}

export type SimulationPromptCardFace = {
  name: string
  manaCost: string | null
  typeLine: string | null
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
}

export type SimulationPromptCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  zone: "commander" | "library"
  manaCost: string | null
  convertedManaCost: string | null
  typeLine: string | null
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  cardFaces: SimulationPromptCardFace[]
}

export type StartingHandSimulationPromptData = {
  simulationId: string
  deckId: string
  commanders: SimulationPromptCard[]
  library: SimulationPromptCard[]
}

export class SimulationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SimulationValidationError"
  }
}

export class StartingHandValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartingHandValidationError"
  }
}

export async function ensureSimulationsSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pgcrypto")
  await createEnumType("simulation_status", [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ])
  await createEnumType("llm_run_status", [
    "pending",
    "streaming",
    "completed",
    "failed",
    "cancel_requested",
    "cancelled",
  ])
  await createEnumType("llm_run_phase", ["opening_hand", "turn", "other"])
  await createEnumType("llm_chunk_kind", [
    "raw_event",
    "message_delta",
    "reasoning_delta",
    "tool_call",
    "tool_result",
    "usage",
    "error",
    "metadata",
  ])

  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS starting_hands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      name text NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (deck_id, name)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS starting_hand_cards (
      starting_hand_id uuid NOT NULL REFERENCES starting_hands(id) ON DELETE CASCADE,
      deck_card_id bigint NOT NULL REFERENCES deck_cards(id) ON DELETE CASCADE,
      quantity integer NOT NULL CHECK (quantity > 0),

      PRIMARY KEY (starting_hand_id, deck_card_id)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,

      seed text NOT NULL,
      random_state bigint NOT NULL,
      turns_to_simulate integer NOT NULL CHECK (turns_to_simulate >= 0),
      starting_hand_id uuid REFERENCES starting_hands(id) ON DELETE SET NULL,
      library jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(library) = 'array'),
      mulligan_count integer NOT NULL DEFAULT 0 CHECK (mulligan_count >= 0),
      has_drawn_starting_hand boolean NOT NULL DEFAULT false,

      status simulation_status NOT NULL DEFAULT 'pending',
      started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      cancel_requested_at timestamptz,
      failure_message text,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      phase llm_run_phase NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      provider_run_id text,
      provider_request_id text,

      status llm_run_status NOT NULL DEFAULT 'pending',
      runtime_stream_key text UNIQUE,

      full_prompt text NOT NULL DEFAULT '',
      request_payload jsonb NOT NULL DEFAULT '{}',
      response_metadata jsonb NOT NULL DEFAULT '{}',
      usage jsonb NOT NULL DEFAULT '{}',

      started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      cancel_requested_at timestamptz,
      cancelled_at timestamptz,
      failure_message text,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_chunks (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      kind llm_chunk_kind NOT NULL,
      provider_event_type text,
      reasoning_delta text,
      output_delta text,
      content text,
      payload jsonb NOT NULL DEFAULT '{}',
      received_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (llm_run_id, sequence)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_opening_hand_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      opening_hand jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(opening_hand) = 'array'),
      library_snapshot jsonb CHECK (library_snapshot IS NULL OR jsonb_typeof(library_snapshot) = 'array'),
      random_state_snapshot bigint,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_turn_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      turn_number integer NOT NULL CHECK (turn_number > 0),
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      library_snapshot jsonb CHECK (library_snapshot IS NULL OR jsonb_typeof(library_snapshot) = 'array'),
      random_state_snapshot bigint,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, turn_number, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS starting_hands_deck_id_idx
      ON starting_hands (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS starting_hand_cards_deck_card_id_idx
      ON starting_hand_cards (deck_card_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_deck_id_idx
      ON simulations (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_status_idx
      ON simulations (status)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_status_idx
      ON llm_runs (status)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_provider_model_idx
      ON llm_runs (provider, model)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_chunks_llm_run_id_sequence_idx
      ON llm_run_chunks (llm_run_id, sequence)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_opening_hand_llm_runs_simulation_id_idx
      ON simulation_opening_hand_llm_runs (simulation_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_llm_runs_simulation_id_turn_number_idx
      ON simulation_turn_llm_runs (simulation_id, turn_number)
  `)
}

export async function listSimulationsForDeck(
  deckId: string
): Promise<SimulationSummary[]> {
  const result = await queryDatabase<{
    id: string
    deck_id: string
    starting_hand_id: string | null
    seed: string
    library: unknown
    turns_to_simulate: number
    status: SimulationStatus
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id,
        deck_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        status,
        created_at,
        updated_at
      FROM simulations
      WHERE deck_id = $1
      ORDER BY created_at DESC
    `,
    [deckId]
  )

  return result.rows.map((simulation) => ({
    id: simulation.id,
    deckId: simulation.deck_id,
    startingHandId: simulation.starting_hand_id,
    seed: simulation.seed,
    library: parseStringArray(simulation.library),
    turnsToSimulate: simulation.turns_to_simulate,
    status: simulation.status,
    createdAt: simulation.created_at.toISOString(),
    updatedAt: simulation.updated_at.toISOString(),
  }))
}

export async function createSimulation(
  deckId: string,
  input: CreateSimulationInput
): Promise<SimulationSummary> {
  const seed = input.seed.trim()

  if (!seed) {
    throw new SimulationValidationError("Simulation seed is required.")
  }

  if (!Number.isInteger(input.turnsToSimulate) || input.turnsToSimulate < 0) {
    throw new SimulationValidationError(
      "Turns to simulate must be a non-negative integer."
    )
  }

  const deckResult = await queryDatabase("SELECT id FROM decks WHERE id = $1", [
    deckId,
  ])

  if (deckResult.rowCount === 0) {
    throw new SimulationValidationError("Deck not found.")
  }

  if (input.startingHandId !== null) {
    const startingHandResult = await queryDatabase(
      `
        SELECT id
        FROM starting_hands
        WHERE id = $1
          AND deck_id = $2
      `,
      [input.startingHandId, deckId]
    )

    if (startingHandResult.rowCount === 0) {
      throw new SimulationValidationError(
        "Starting hand does not exist for this deck."
      )
    }
  }

  const shuffledLibrary = await createShuffledSimulationLibrary(
    deckId,
    seed,
    input.startingHandId
  )

  const result = await queryDatabase<{
    id: string
    deck_id: string
    starting_hand_id: string | null
    seed: string
    library: unknown
    turns_to_simulate: number
    status: SimulationStatus
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO simulations (
        deck_id,
        seed,
        random_state,
        turns_to_simulate,
        starting_hand_id,
        library,
        has_drawn_starting_hand
      )
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
      RETURNING
        id,
        deck_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        status,
        created_at,
        updated_at
    `,
    [
      deckId,
      seed,
      shuffledLibrary.randomState,
      input.turnsToSimulate,
      input.startingHandId,
      JSON.stringify(shuffledLibrary.library),
      input.startingHandId !== null,
    ]
  )
  const simulation = result.rows[0]

  return {
    id: simulation.id,
    deckId: simulation.deck_id,
    startingHandId: simulation.starting_hand_id,
    seed: simulation.seed,
    library: parseStringArray(simulation.library),
    turnsToSimulate: simulation.turns_to_simulate,
    status: simulation.status,
    createdAt: simulation.created_at.toISOString(),
    updatedAt: simulation.updated_at.toISOString(),
  }
}

export async function shuffleSimulationLibrary(
  simulationId: string
): Promise<LibraryShuffleResult> {
  return withDatabaseTransaction(async (client) => {
    const result = await client.query<{
      library: unknown
      random_state: string
    }>(
      `
        SELECT
          library,
          random_state
        FROM simulations
        WHERE id = $1
        FOR UPDATE
      `,
      [simulationId]
    )

    if (result.rowCount === 0) {
      throw new SimulationValidationError("Simulation not found.")
    }

    const simulation = result.rows[0]
    const library = parseStringArray(simulation.library)
    const shuffleResult = shuffleWithRandomState(
      library,
      Number(simulation.random_state)
    )

    await client.query(
      `
        UPDATE simulations
        SET library = $2::jsonb,
            random_state = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [
        simulationId,
        JSON.stringify(shuffleResult.items),
        shuffleResult.randomState,
      ]
    )

    return {
      simulationId,
      cardsRemaining: shuffleResult.items.length,
    }
  })
}

export async function drawCardsFromTop(
  simulationId: string,
  count: number
): Promise<LibraryDrawResult> {
  assertPositiveInteger(count, "Draw count")

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)
    const library = parseStringArray(simulation.library)
    const cards = library.slice(0, count)
    const remainingLibrary = library.slice(cards.length)

    await updateSimulationLibrary(client, simulationId, remainingLibrary)

    return {
      simulationId,
      cards,
      cardsRemaining: remainingLibrary.length,
    }
  })
}

export async function drawCardsFromBottom(
  simulationId: string,
  count: number
): Promise<LibraryDrawResult> {
  assertPositiveInteger(count, "Draw count")

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)
    const library = parseStringArray(simulation.library)
    const cardsToDraw = Math.min(count, library.length)
    const remainingLibrary = library.slice(0, library.length - cardsToDraw)
    const cards = library.slice(remainingLibrary.length).reverse()

    await updateSimulationLibrary(client, simulationId, remainingLibrary)

    return {
      simulationId,
      cards,
      cardsRemaining: remainingLibrary.length,
    }
  })
}

export async function drawStartingHand(
  simulationId: string
): Promise<LibraryDrawResult> {
  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)

    assertSimulationDoesNotHavePresetStartingHand(simulation)

    if (simulation.has_drawn_starting_hand) {
      throw new SimulationValidationError(
        "Starting hand has already been drawn for this simulation."
      )
    }

    const shuffledLibrary = await rebuildAndShuffleSimulationLibrary(
      client,
      simulation.deck_id,
      simulation.seed,
      1
    )
    const cards = shuffledLibrary.library.slice(0, 7)
    const remainingLibrary = shuffledLibrary.library.slice(cards.length)

    await client.query(
      `
        UPDATE simulations
        SET library = $2::jsonb,
            random_state = $3,
            mulligan_count = 0,
            has_drawn_starting_hand = true,
            updated_at = now()
        WHERE id = $1
      `,
      [
        simulationId,
        JSON.stringify(remainingLibrary),
        shuffledLibrary.randomState,
      ]
    )

    return {
      simulationId,
      cards,
      cardsRemaining: remainingLibrary.length,
    }
  })
}

export async function mulliganSimulation(
  simulationId: string,
  reason: string
): Promise<MulliganResult> {
  const trimmedReason = reason.trim()

  if (!trimmedReason) {
    throw new SimulationValidationError("Mulligan reason is required.")
  }

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)

    assertSimulationDoesNotHavePresetStartingHand(simulation)

    if (!simulation.has_drawn_starting_hand) {
      throw new SimulationValidationError(
        "Draw a starting hand before taking a mulligan."
      )
    }

    const mulliganCount = simulation.mulligan_count + 1
    const shuffledLibrary = await rebuildAndShuffleSimulationLibrary(
      client,
      simulation.deck_id,
      simulation.seed,
      mulliganCount + 1
    )
    const cards = shuffledLibrary.library.slice(0, 7)
    const remainingLibrary = shuffledLibrary.library.slice(cards.length)

    await client.query(
      `
        UPDATE simulations
        SET library = $2::jsonb,
            random_state = $3,
            mulligan_count = $4,
            updated_at = now()
        WHERE id = $1
      `,
      [
        simulationId,
        JSON.stringify(remainingLibrary),
        shuffledLibrary.randomState,
        mulliganCount,
      ]
    )

    const cardsToBottomIfKept = Math.max(0, mulliganCount - 1)

    return {
      simulationId,
      reason: trimmedReason,
      cards,
      cardsRemaining: remainingLibrary.length,
      mulliganCount,
      cardsToBottomIfKept,
      reminder:
        cardsToBottomIfKept > 0
          ? `If you keep this hand, put ${cardsToBottomIfKept} card(s) on the bottom before producing the final JSON response.`
          : "This mulligan is free; no cards need to be bottomed if you keep this hand.",
      replacesPreviousOpeningHand: true,
      alreadyDrewReplacementHand: true,
    }
  })
}

export async function returnCardToSimulationLibrary({
  card,
  position,
  side,
  simulationId,
}: {
  simulationId: string
  card: string
  side: "top" | "bottom"
  position: number
}): Promise<LibraryReturnCardResult> {
  const trimmedCard = card.trim()

  if (!trimmedCard) {
    throw new SimulationValidationError("Returned card name is required.")
  }

  if (!Number.isInteger(position) || position < 0) {
    throw new SimulationValidationError(
      "Return position must be a non-negative integer."
    )
  }

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)
    const library = parseStringArray(simulation.library)
    const resolvedPosition = Math.min(position, library.length)
    const insertIndex =
      side === "top" ? resolvedPosition : library.length - resolvedPosition
    const updatedLibrary = [
      ...library.slice(0, insertIndex),
      trimmedCard,
      ...library.slice(insertIndex),
    ]

    await updateSimulationLibrary(client, simulationId, updatedLibrary)

    return {
      simulationId,
      card: trimmedCard,
      side,
      position,
      insertedFromTop: insertIndex,
      insertedFromBottom: library.length - insertIndex,
      cardsRemaining: updatedLibrary.length,
    }
  })
}

export async function returnCardsToSimulationLibrary({
  cards,
  randomizeOrder,
  side,
  simulationId,
}: {
  simulationId: string
  cards: readonly string[]
  side: "top" | "bottom"
  randomizeOrder: boolean
}): Promise<LibraryReturnCardsResult> {
  const trimmedCards = cards.map((card) => card.trim())

  if (trimmedCards.length === 0 || trimmedCards.some((card) => !card)) {
    throw new SimulationValidationError(
      "Returned cards must include at least one card name."
    )
  }

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)
    const library = parseStringArray(simulation.library)
    let cardsToReturn = trimmedCards
    let randomState = Number(simulation.random_state)

    if (randomizeOrder) {
      const shuffleResult = shuffleWithRandomState(cardsToReturn, randomState)
      cardsToReturn = shuffleResult.items
      randomState = shuffleResult.randomState
    }

    const updatedLibrary =
      side === "top"
        ? [...cardsToReturn].reverse().concat(library)
        : library.concat(cardsToReturn)

    await client.query(
      `
        UPDATE simulations
        SET library = $2::jsonb,
            random_state = $3,
            updated_at = now()
        WHERE id = $1
      `,
      [simulationId, JSON.stringify(updatedLibrary), randomState]
    )

    return {
      simulationId,
      cards: cardsToReturn,
      side,
      randomizeOrder,
      cardsRemaining: updatedLibrary.length,
    }
  })
}

export async function takeCardsFromSimulationLibrary(
  simulationId: string,
  cards: readonly string[]
): Promise<LibraryTakeCardsResult> {
  const requestedCards = cards.map((card) => card.trim())

  if (requestedCards.length === 0 || requestedCards.some((card) => !card)) {
    throw new SimulationValidationError(
      "Requested cards must include at least one card name."
    )
  }

  return withDatabaseTransaction(async (client) => {
    const simulation = await getLockedLibrarySimulation(client, simulationId)
    const library = parseStringArray(simulation.library)
    const matches: LibraryTakeCardsResult["matches"] = []
    const foundCards: string[] = []

    for (const requestedCard of requestedCards) {
      const matchIndex = findBestLibraryCardMatchIndex(library, requestedCard)

      if (matchIndex === -1) {
        matches.push({
          requestedCard,
          foundCard: null,
        })
        continue
      }

      const foundCard = library[matchIndex]
      library.splice(matchIndex, 1)
      matches.push({
        requestedCard,
        foundCard,
      })
      foundCards.push(foundCard)
    }

    await updateSimulationLibrary(client, simulationId, library)

    return {
      simulationId,
      matches,
      foundCards,
      cardsRemaining: library.length,
    }
  })
}

export async function createOpeningHandLlmRun(
  deckId: string,
  input: CreateOpeningHandLlmRunInput
): Promise<OpeningHandLlmRun> {
  return withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query<{
      id: string
      starting_hand_id: string | null
    }>(
      `
        SELECT id, starting_hand_id
        FROM simulations
        WHERE id = $1
          AND deck_id = $2
        FOR UPDATE
      `,
      [input.simulationId, deckId]
    )

    if (simulationResult.rowCount === 0) {
      throw new SimulationValidationError("Simulation not found.")
    }

    if (simulationResult.rows[0].starting_hand_id !== null) {
      throw new SimulationValidationError(
        "This simulation uses a preset starting hand, so opening-hand LLM runs are not allowed."
      )
    }

    const activeRunResult = await client.query(
      `
        SELECT 1
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN llm_runs llm_run
          ON llm_run.id = opening_run.llm_run_id
        WHERE opening_run.simulation_id = $1
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
        LIMIT 1
      `,
      [input.simulationId]
    )

    if ((activeRunResult.rowCount ?? 0) > 0) {
      throw new SimulationValidationError(
        "An opening-hand LLM run is already active for this simulation."
      )
    }

    const attemptResult = await client.query<{ attempt_number: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM simulation_opening_hand_llm_runs
        WHERE simulation_id = $1
      `,
      [input.simulationId]
    )
    const attemptNumber = Number(attemptResult.rows[0].attempt_number)
    const llmRunResult = await client.query<{
      id: string
      status: LlmRunStatus
      runtime_stream_key: string
    }>(
      `
        INSERT INTO llm_runs (
          phase,
          provider,
          model,
          runtime_stream_key,
          full_prompt,
          request_payload
        )
        VALUES (
          'opening_hand',
          $1,
          $2,
          $3,
          $4,
          $5::jsonb
        )
        RETURNING id, status, runtime_stream_key
      `,
      [
        input.provider,
        input.model,
        input.runtimeStreamKey,
        input.fullPrompt,
        JSON.stringify(input.requestPayload),
      ]
    )
    const llmRun = llmRunResult.rows[0]

    await client.query(
      `
        INSERT INTO simulation_opening_hand_llm_runs (
          simulation_id,
          llm_run_id,
          attempt_number
        )
        VALUES ($1, $2, $3)
      `,
      [input.simulationId, llmRun.id, attemptNumber]
    )

    return {
      simulationId: input.simulationId,
      llmRunId: llmRun.id,
      attemptNumber,
      runtimeStreamKey: llmRun.runtime_stream_key,
      status: llmRun.status,
    }
  })
}

export async function verifySimulationCanStartOpeningHandLlmRun(
  deckId: string,
  simulationId: string
) {
  const simulationResult = await queryDatabase<{
    starting_hand_id: string | null
  }>(
    `
      SELECT starting_hand_id
      FROM simulations
      WHERE id = $1
        AND deck_id = $2
    `,
    [simulationId, deckId]
  )

  if (simulationResult.rowCount === 0) {
    throw new SimulationValidationError("Simulation not found.")
  }

  if (simulationResult.rows[0].starting_hand_id !== null) {
    throw new SimulationValidationError(
      "This simulation uses a preset starting hand, so opening-hand LLM runs are not allowed."
    )
  }
}

export async function appendLlmRunChunks(
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  if (chunks.length === 0) {
    return
  }

  const values: unknown[] = []
  const valuePlaceholders = chunks.map((chunk, index) => {
    const offset = index * 8

    values.push(
      llmRunId,
      chunk.sequence,
      chunk.kind,
      chunk.providerEventType,
      chunk.reasoningDelta,
      chunk.outputDelta,
      chunk.content,
      JSON.stringify(chunk.payload)
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}::jsonb)`
  })

  await queryDatabase(
    `
      INSERT INTO llm_run_chunks (
        llm_run_id,
        sequence,
        kind,
        provider_event_type,
        reasoning_delta,
        output_delta,
        content,
        payload
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON CONFLICT (llm_run_id, sequence) DO NOTHING
    `,
    values
  )
}

export async function markLlmRunStreaming(llmRunId: string) {
  await queryDatabase(
    `
      UPDATE llm_runs
      SET status = 'streaming',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = $1
        AND status = 'pending'
    `,
    [llmRunId]
  )
}

export async function completeOpeningHandLlmRun({
  llmRunId,
  openingHand,
  responseMetadata,
  usage,
}: {
  llmRunId: string
  openingHand: readonly string[]
  responseMetadata: unknown
  usage: unknown
}) {
  await withDatabaseTransaction(async (client) => {
    const snapshotResult = await client.query<{
      library: unknown
      random_state: string
    }>(
      `
        SELECT simulation.library, simulation.random_state
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN simulations simulation
          ON simulation.id = opening_run.simulation_id
        WHERE opening_run.llm_run_id = $1
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Opening-hand LLM run not found.")
    }

    const snapshot = snapshotResult.rows[0]

    await client.query(
      `
        UPDATE simulation_opening_hand_llm_runs
        SET opening_hand = $2::jsonb,
            library_snapshot = $3::jsonb,
            random_state_snapshot = $4
        WHERE llm_run_id = $1
      `,
      [
        llmRunId,
        JSON.stringify(openingHand),
        JSON.stringify(parseStringArray(snapshot.library)),
        snapshot.random_state,
      ]
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'completed',
            response_metadata = $2::jsonb,
            usage = $3::jsonb,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
      `,
      [llmRunId, JSON.stringify(responseMetadata), JSON.stringify(usage)]
    )
  })
}

export async function failLlmRun(llmRunId: string, failureMessage: string) {
  await queryDatabase(
    `
      UPDATE llm_runs
      SET status = 'failed',
          failed_at = now(),
          failure_message = $2,
          updated_at = now()
      WHERE id = $1
        AND status <> 'completed'
    `,
    [llmRunId, failureMessage]
  )
}

export async function cancelLlmRun(llmRunId: string, failureMessage?: string) {
  await queryDatabase(
    `
      UPDATE llm_runs
      SET status = 'cancelled',
          cancelled_at = now(),
          failure_message = COALESCE($2, failure_message),
          updated_at = now()
      WHERE id = $1
        AND status <> 'completed'
    `,
    [llmRunId, failureMessage ?? null]
  )
}

export async function requestCancelOpeningHandLlmRuns(
  deckId: string,
  simulationId: string
): Promise<ActiveOpeningHandLlmRun[]> {
  return withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query(
      `
        SELECT id
        FROM simulations
        WHERE id = $1
          AND deck_id = $2
      `,
      [simulationId, deckId]
    )

    if (simulationResult.rowCount === 0) {
      throw new SimulationValidationError("Simulation not found.")
    }

    const activeRunsResult = await client.query<{
      simulation_id: string
      llm_run_id: string
      runtime_stream_key: string
      status: LlmRunStatus
    }>(
      `
        SELECT
          opening_run.simulation_id,
          llm_run.id AS llm_run_id,
          llm_run.runtime_stream_key,
          llm_run.status
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN llm_runs llm_run
          ON llm_run.id = opening_run.llm_run_id
        WHERE opening_run.simulation_id = $1
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      `,
      [simulationId]
    )

    if (activeRunsResult.rows.length > 0) {
      await client.query(
        `
          UPDATE llm_runs
          SET status = 'cancel_requested',
              cancel_requested_at = COALESCE(cancel_requested_at, now()),
              updated_at = now()
          WHERE id = ANY($1::uuid[])
            AND status IN ('pending', 'streaming', 'cancel_requested')
        `,
        [activeRunsResult.rows.map((run) => run.llm_run_id)]
      )
    }

    return activeRunsResult.rows.map((run) => ({
      simulationId: run.simulation_id,
      llmRunId: run.llm_run_id,
      runtimeStreamKey: run.runtime_stream_key,
      status: run.status,
    }))
  })
}

export async function getSimulationDebugInfo(
  deckId: string,
  simulationId: string
): Promise<SimulationDebugInfo> {
  const simulationResult = await queryDatabase(
    `
      SELECT id
      FROM simulations
      WHERE id = $1
        AND deck_id = $2
    `,
    [simulationId, deckId]
  )

  if (simulationResult.rowCount === 0) {
    throw new SimulationValidationError("Simulation not found.")
  }

  const openingHandRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_opening_hand_llm_runs",
    selectColumns: "run.attempt_number, NULL::integer AS turn_number",
    orderBy: "run.attempt_number ASC",
  })
  const turnRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_turn_llm_runs",
    selectColumns: "run.attempt_number, run.turn_number",
    orderBy: "run.turn_number ASC, run.attempt_number ASC",
  })

  return {
    simulationId,
    openingHandLlmRunCount: openingHandRuns.length,
    turnLlmRunCount: turnRuns.length,
    openingHandLlmRuns: openingHandRuns,
    turnLlmRuns: turnRuns,
  }
}

export async function deleteSimulation(
  deckId: string,
  simulationId: string
): Promise<boolean> {
  const result = await queryDatabase(
    `
      DELETE FROM simulations
      WHERE id = $1
        AND deck_id = $2
    `,
    [simulationId, deckId]
  )

  return (result.rowCount ?? 0) > 0
}

export async function getStartingHandSimulationPromptData(
  simulationId: string
): Promise<StartingHandSimulationPromptData | null> {
  const result = await queryDatabase<SimulationPromptCardRow>(
    `
      SELECT
        simulation.id AS simulation_id,
        simulation.deck_id,
        deck_card.id AS deck_card_id,
        deck_card.oracle_id,
        deck_card.quantity,
        deck_card.zone,
        card.name,
        card.mana_cost,
        card.cmc,
        card.type_line,
        card.oracle_text,
        card.power,
        card.toughness,
        card.loyalty,
        card.card_faces
      FROM simulations simulation
      JOIN deck_cards deck_card
        ON deck_card.deck_id = simulation.deck_id
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE simulation.id = $1
      ORDER BY
        CASE deck_card.zone
          WHEN 'commander' THEN 0
          ELSE 1
        END,
        card.name ASC
    `,
    [simulationId]
  )

  const firstRow = result.rows[0]

  if (!firstRow) {
    return null
  }

  const cards = result.rows.map(mapSimulationPromptCard)

  return {
    simulationId: firstRow.simulation_id,
    deckId: firstRow.deck_id,
    commanders: cards.filter((card) => card.zone === "commander"),
    library: cards.filter((card) => card.zone === "library"),
  }
}

export async function listStartingHandsForDeck(
  deckId: string
): Promise<StartingHand[]> {
  const result = await queryDatabase<StartingHandRow>(
    `
      SELECT
        hand.id,
        hand.deck_id,
        hand.name,
        hand.created_at,
        hand.updated_at,
        hand_card.deck_card_id,
        hand_card.quantity,
        deck_card.oracle_id,
        card.name AS card_name,
        card.scryfall_uri,
        card.default_image_url,
        card.type_line
      FROM starting_hands hand
      LEFT JOIN starting_hand_cards hand_card
        ON hand_card.starting_hand_id = hand.id
      LEFT JOIN deck_cards deck_card
        ON deck_card.id = hand_card.deck_card_id
      LEFT JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE hand.deck_id = $1
      ORDER BY hand.created_at DESC, hand.name ASC, card.name ASC
    `,
    [deckId]
  )

  return mapStartingHandRows(result.rows)
}

export async function createStartingHand(
  deckId: string,
  input: CreateStartingHandInput
): Promise<StartingHand> {
  return withDatabaseTransaction(async (client) => {
    const name = input.name.trim()
    const cards = mergeStartingHandCards(input.cards)
    const totalCards = cards.reduce((total, card) => total + card.quantity, 0)

    if (!name) {
      throw new StartingHandValidationError("Starting hand name is required.")
    }

    if (totalCards !== 7) {
      throw new StartingHandValidationError(
        "Starting hand must contain exactly 7 cards."
      )
    }

    const deckResult = await client.query(
      "SELECT id FROM decks WHERE id = $1",
      [deckId]
    )

    if (deckResult.rowCount === 0) {
      throw new StartingHandValidationError("Deck not found.")
    }

    const deckCardResult = await client.query<{
      id: number
      quantity: number
      zone: "commander" | "library"
    }>(
      `
        SELECT id, quantity, zone
        FROM deck_cards
        WHERE deck_id = $1
          AND id = ANY($2::bigint[])
      `,
      [deckId, cards.map((card) => card.deckCardId)]
    )
    const deckCardsById = new Map(
      deckCardResult.rows.map((card) => [Number(card.id), card])
    )

    for (const card of cards) {
      const deckCard = deckCardsById.get(card.deckCardId)

      if (!deckCard) {
        throw new StartingHandValidationError(
          "Starting hand contains a card that is not in this deck."
        )
      }

      if (deckCard.zone !== "library") {
        throw new StartingHandValidationError(
          "Starting hand can only contain library cards."
        )
      }

      if (card.quantity > deckCard.quantity) {
        throw new StartingHandValidationError(
          "Starting hand contains more copies of a card than the deck has."
        )
      }
    }

    let hand

    try {
      const handResult = await client.query<{
        id: string
        deck_id: string
        name: string
        created_at: Date
        updated_at: Date
      }>(
        `
          INSERT INTO starting_hands (deck_id, name)
          VALUES ($1, $2)
          RETURNING id, deck_id, name, created_at, updated_at
        `,
        [deckId, name]
      )

      hand = handResult.rows[0]
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StartingHandValidationError(
          "A starting hand with that name already exists for this deck."
        )
      }

      throw error
    }

    for (const card of cards) {
      await client.query(
        `
          INSERT INTO starting_hand_cards (
            starting_hand_id,
            deck_card_id,
            quantity
          )
          VALUES ($1, $2, $3)
        `,
        [hand.id, card.deckCardId, card.quantity]
      )
    }

    const createdHandResult = await client.query<StartingHandRow>(
      `
        SELECT
          hand.id,
          hand.deck_id,
          hand.name,
          hand.created_at,
          hand.updated_at,
          hand_card.deck_card_id,
          hand_card.quantity,
          deck_card.oracle_id,
          card.name AS card_name,
          card.scryfall_uri,
          card.default_image_url,
          card.type_line
        FROM starting_hands hand
        JOIN starting_hand_cards hand_card
          ON hand_card.starting_hand_id = hand.id
        JOIN deck_cards deck_card
          ON deck_card.id = hand_card.deck_card_id
        JOIN scryfall_oracle_cards card
          ON card.oracle_id = deck_card.oracle_id
        WHERE hand.id = $1
        ORDER BY card.name ASC
      `,
      [hand.id]
    )

    const createdHand = mapStartingHandRows(createdHandResult.rows)[0]

    if (!createdHand) {
      throw new Error("Created starting hand could not be loaded.")
    }

    return createdHand
  })
}

type StartingHandRow = {
  id: string
  deck_id: string
  name: string
  created_at: Date
  updated_at: Date
  deck_card_id: number | null
  quantity: number | null
  oracle_id: string | null
  card_name: string | null
  scryfall_uri: string | null
  default_image_url: string | null
  type_line: string | null
}

type SimulationDebugLlmRunRow = {
  llm_run_id: string
  phase: LlmRunPhase
  provider: string
  model: string
  status: LlmRunStatus
  runtime_stream_key: string | null
  attempt_number: number
  turn_number: number | null
  chunk_id: string | null
  sequence: number | null
  kind: LlmChunkKind | null
  provider_event_type: string | null
  reasoning_delta: string | null
  output_delta: string | null
  content: string | null
  payload: unknown
  received_at: Date | null
}

async function getSimulationDebugLlmRuns({
  orderBy,
  selectColumns,
  simulationId,
  tableName,
}: {
  simulationId: string
  tableName: "simulation_opening_hand_llm_runs" | "simulation_turn_llm_runs"
  selectColumns: string
  orderBy: string
}): Promise<SimulationDebugLlmRun[]> {
  const result = await queryDatabase<SimulationDebugLlmRunRow>(
    `
      SELECT
        llm_run.id AS llm_run_id,
        llm_run.phase,
        llm_run.provider,
        llm_run.model,
        llm_run.status,
        llm_run.runtime_stream_key,
        ${selectColumns},
        chunk.id AS chunk_id,
        chunk.sequence,
        chunk.kind,
        chunk.provider_event_type,
        chunk.reasoning_delta,
        chunk.output_delta,
        chunk.content,
        chunk.payload,
        chunk.received_at
      FROM ${tableName} run
      JOIN llm_runs llm_run
        ON llm_run.id = run.llm_run_id
      LEFT JOIN llm_run_chunks chunk
        ON chunk.llm_run_id = llm_run.id
      WHERE run.simulation_id = $1
      ORDER BY ${orderBy}, chunk.sequence ASC NULLS LAST
    `,
    [simulationId]
  )
  const runsById = new Map<string, SimulationDebugLlmRun>()

  for (const row of result.rows) {
    let run = runsById.get(row.llm_run_id)

    if (!run) {
      run = {
        llmRunId: row.llm_run_id,
        phase: row.phase,
        provider: row.provider,
        model: row.model,
        status: row.status,
        runtimeStreamKey: row.runtime_stream_key,
        attemptNumber: row.attempt_number,
        chunks: [],
      }

      if (row.turn_number !== null) {
        run.turnNumber = row.turn_number
      }

      runsById.set(row.llm_run_id, run)
    }

    if (row.chunk_id !== null && row.sequence !== null && row.kind !== null) {
      run.chunks.push({
        id: Number(row.chunk_id),
        sequence: row.sequence,
        kind: row.kind,
        providerEventType: row.provider_event_type,
        reasoningDelta: row.reasoning_delta,
        outputDelta: row.output_delta,
        content: row.content,
        payload: row.payload,
        receivedAt: row.received_at?.toISOString() ?? "",
      })
    }
  }

  return Array.from(runsById.values())
}

type SimulationPromptCardRow = {
  simulation_id: string
  deck_id: string
  deck_card_id: number
  oracle_id: string
  quantity: number
  zone: "commander" | "library"
  name: string
  mana_cost: string | null
  cmc: string | null
  type_line: string | null
  oracle_text: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  card_faces: unknown
}

type LibrarySimulationRow = {
  deck_id: string
  seed: string
  starting_hand_id: string | null
  random_state: string
  library: unknown
  mulligan_count: number
  has_drawn_starting_hand: boolean
}

function mapSimulationPromptCard(
  row: SimulationPromptCardRow
): SimulationPromptCard {
  return {
    deckCardId: Number(row.deck_card_id),
    oracleId: row.oracle_id,
    name: row.name,
    quantity: row.quantity,
    zone: row.zone,
    manaCost: row.mana_cost,
    convertedManaCost: row.cmc,
    typeLine: row.type_line,
    oracleText: row.oracle_text,
    power: row.power,
    toughness: row.toughness,
    loyalty: row.loyalty,
    cardFaces: parseSimulationPromptCardFaces(row.card_faces),
  }
}

function parseSimulationPromptCardFaces(
  cardFaces: unknown
): SimulationPromptCardFace[] {
  if (!Array.isArray(cardFaces)) {
    return []
  }

  return cardFaces.flatMap((face) => {
    if (typeof face !== "object" || face === null) {
      return []
    }

    const faceRecord = face as Record<string, unknown>
    const name = getOptionalString(faceRecord.name)

    if (!name) {
      return []
    }

    return [
      {
        name,
        manaCost: getOptionalString(faceRecord.mana_cost),
        typeLine: getOptionalString(faceRecord.type_line),
        oracleText: getOptionalString(faceRecord.oracle_text),
        power: getOptionalString(faceRecord.power),
        toughness: getOptionalString(faceRecord.toughness),
        loyalty: getOptionalString(faceRecord.loyalty),
      },
    ]
  })
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === "string")
}

async function getLockedLibrarySimulation(
  client: DatabaseTransactionClient,
  simulationId: string
) {
  const result = await client.query<LibrarySimulationRow>(
    `
      SELECT
        deck_id,
        seed,
        starting_hand_id,
        random_state,
        library,
        mulligan_count,
        has_drawn_starting_hand
      FROM simulations
      WHERE id = $1
      FOR UPDATE
    `,
    [simulationId]
  )

  if (result.rowCount === 0) {
    throw new SimulationValidationError("Simulation not found.")
  }

  return result.rows[0]
}

function assertSimulationDoesNotHavePresetStartingHand({
  starting_hand_id: startingHandId,
}: {
  starting_hand_id: string | null
}) {
  if (startingHandId !== null) {
    throw new SimulationValidationError(
      "This simulation uses a preset starting hand, so opening-hand tools are not allowed."
    )
  }
}

async function updateSimulationLibrary(
  client: DatabaseTransactionClient,
  simulationId: string,
  library: readonly string[]
) {
  await client.query(
    `
      UPDATE simulations
      SET library = $2::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [simulationId, JSON.stringify(library)]
  )
}

async function rebuildAndShuffleSimulationLibrary(
  client: DatabaseTransactionClient,
  deckId: string,
  seed: string,
  shuffleCount: number
) {
  let library = await getDeckLibraryCardNames(client, deckId)
  let randomState = createSeededRandomState(seed)

  for (let index = 0; index < shuffleCount; index += 1) {
    const shuffleResult = shuffleWithRandomState(library, randomState)
    library = shuffleResult.items
    randomState = shuffleResult.randomState
  }

  return {
    library,
    randomState,
  }
}

async function getDeckLibraryCardNames(
  client: DatabaseTransactionClient,
  deckId: string
) {
  const libraryResult = await client.query<{
    quantity: number
    name: string
  }>(
    `
      SELECT
        deck_card.quantity,
        card.name
      FROM deck_cards deck_card
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE deck_card.deck_id = $1
        AND deck_card.zone = 'library'
      ORDER BY card.name ASC, deck_card.id ASC
    `,
    [deckId]
  )

  return libraryResult.rows.flatMap((card) =>
    Array.from({ length: card.quantity }, () => card.name)
  )
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SimulationValidationError(`${label} must be a positive integer.`)
  }
}

function findBestLibraryCardMatchIndex(
  library: readonly string[],
  requestedCard: string
) {
  const normalizedRequest = normalizeLibraryCardSearchText(requestedCard)

  if (!normalizedRequest) {
    return -1
  }

  let bestIndex = -1
  let bestScore = 0

  for (let index = 0; index < library.length; index += 1) {
    const normalizedCandidate = normalizeLibraryCardSearchText(library[index])
    const score = getLibraryCardMatchScore(
      normalizedRequest,
      normalizedCandidate
    )

    if (score === 1) {
      return index
    }

    if (score > bestScore) {
      bestIndex = index
      bestScore = score
    }
  }

  return bestScore >= 0.72 ? bestIndex : -1
}

function normalizeLibraryCardSearchText(cardName: string) {
  return cardName
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function getLibraryCardMatchScore(
  requestedCard: string,
  candidateCard: string
) {
  if (!candidateCard) {
    return 0
  }

  if (requestedCard === candidateCard) {
    return 1
  }

  if (requestedCard.length >= 3 && candidateCard.includes(requestedCard)) {
    return requestedCard.length / candidateCard.length >= 0.5 ? 0.9 : 0.74
  }

  if (candidateCard.length >= 3 && requestedCard.includes(candidateCard)) {
    return candidateCard.length / requestedCard.length >= 0.5 ? 0.88 : 0.72
  }

  const editDistance = getLevenshteinDistance(requestedCard, candidateCard)
  const maxLength = Math.max(requestedCard.length, candidateCard.length)

  return maxLength === 0 ? 0 : 1 - editDistance / maxLength
}

function getLevenshteinDistance(left: string, right: string) {
  const previousRow = Array.from(
    { length: right.length + 1 },
    (_, index) => index
  )

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    const currentRow = [leftIndex + 1]

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex] === right[rightIndex] ? 0 : 1

      currentRow[rightIndex + 1] = Math.min(
        currentRow[rightIndex] + 1,
        previousRow[rightIndex + 1] + 1,
        previousRow[rightIndex] + substitutionCost
      )
    }

    previousRow.splice(0, previousRow.length, ...currentRow)
  }

  return previousRow[right.length]
}

async function createShuffledSimulationLibrary(
  deckId: string,
  seed: string,
  startingHandId: string | null
) {
  const libraryResult = await queryDatabase<{
    deck_card_id: string
    quantity: number
    name: string
  }>(
    `
      SELECT
        deck_card.id AS deck_card_id,
        deck_card.quantity,
        card.name
      FROM deck_cards deck_card
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE deck_card.deck_id = $1
        AND deck_card.zone = 'library'
      ORDER BY card.name ASC, deck_card.id ASC
    `,
    [deckId]
  )
  const startingHandQuantities = startingHandId
    ? await getStartingHandDeckCardQuantities(startingHandId)
    : new Map<number, number>()
  const library = libraryResult.rows.flatMap((card) => {
    const deckCardId = Number(card.deck_card_id)
    const startingHandQuantity = startingHandQuantities.get(deckCardId) ?? 0
    const remainingQuantity = card.quantity - startingHandQuantity

    if (remainingQuantity < 0) {
      throw new SimulationValidationError(
        "Starting hand contains more copies of a card than the deck has."
      )
    }

    return Array.from({ length: remainingQuantity }, () => card.name)
  })

  const shuffleResult = shuffleWithRandomState(
    library,
    createSeededRandomState(seed)
  )

  return {
    library: shuffleResult.items,
    randomState: shuffleResult.randomState,
  }
}

async function getStartingHandDeckCardQuantities(startingHandId: string) {
  const result = await queryDatabase<{
    deck_card_id: string
    quantity: number
  }>(
    `
      SELECT deck_card_id, quantity
      FROM starting_hand_cards
      WHERE starting_hand_id = $1
    `,
    [startingHandId]
  )

  return new Map(
    result.rows.map((card) => [Number(card.deck_card_id), card.quantity])
  )
}

function shuffleWithRandomState<T>(
  items: readonly T[],
  initialRandomState: number
) {
  const shuffledItems = [...items]
  let randomState = initialRandomState

  for (let index = shuffledItems.length - 1; index > 0; index -= 1) {
    const nextRandom = getNextRandomValue(randomState)
    randomState = nextRandom.randomState

    const swapIndex = Math.floor(nextRandom.value * (index + 1))
    const currentItem = shuffledItems[index]
    shuffledItems[index] = shuffledItems[swapIndex]
    shuffledItems[swapIndex] = currentItem
  }

  return {
    items: shuffledItems,
    randomState,
  }
}

function createSeededRandomState(seed: string) {
  let state = 0x811c9dc5

  for (let index = 0; index < seed.length; index += 1) {
    state = Math.imul(state ^ seed.charCodeAt(index), 0x01000193)
  }

  return state >>> 0
}

function getNextRandomValue(randomState: number) {
  const nextRandomState = (randomState + 0x6d2b79f5) >>> 0
  let value = nextRandomState
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)

  return {
    randomState: nextRandomState,
    value: ((value ^ (value >>> 14)) >>> 0) / 4294967296,
  }
}

function mapStartingHandRows(rows: readonly StartingHandRow[]) {
  const handsById = new Map<string, StartingHand>()

  for (const row of rows) {
    let hand = handsById.get(row.id)

    if (!hand) {
      hand = {
        id: row.id,
        deckId: row.deck_id,
        name: row.name,
        cards: [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
      handsById.set(row.id, hand)
    }

    if (
      row.deck_card_id !== null &&
      row.quantity !== null &&
      row.oracle_id !== null &&
      row.card_name !== null &&
      row.scryfall_uri !== null
    ) {
      hand.cards.push({
        deckCardId: Number(row.deck_card_id),
        oracleId: row.oracle_id,
        name: row.card_name,
        quantity: row.quantity,
        scryfallUri: row.scryfall_uri,
        defaultImageUrl: row.default_image_url,
        typeLine: row.type_line,
      })
    }
  }

  return Array.from(handsById.values())
}

function mergeStartingHandCards(
  cards: Readonly<CreateStartingHandInput["cards"]>
) {
  const cardsByDeckCardId = new Map<
    number,
    { deckCardId: number; quantity: number }
  >()

  for (const card of cards) {
    if (!Number.isInteger(card.deckCardId) || card.deckCardId <= 0) {
      throw new StartingHandValidationError(
        "Starting hand contains an invalid deck card."
      )
    }

    if (!Number.isInteger(card.quantity) || card.quantity <= 0) {
      throw new StartingHandValidationError(
        "Starting hand card quantities must be positive integers."
      )
    }

    const existingCard = cardsByDeckCardId.get(card.deckCardId)

    if (existingCard) {
      existingCard.quantity += card.quantity
      continue
    }

    cardsByDeckCardId.set(card.deckCardId, { ...card })
  }

  return Array.from(cardsByDeckCardId.values())
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

async function createEnumType(name: string, values: readonly string[]) {
  await queryDatabase(`
    DO $$
    BEGIN
      CREATE TYPE ${name} AS ENUM (${values
        .map((value) => `'${value}'`)
        .join(", ")});
    EXCEPTION
      WHEN duplicate_object THEN null;
    END
    $$;
  `)
}

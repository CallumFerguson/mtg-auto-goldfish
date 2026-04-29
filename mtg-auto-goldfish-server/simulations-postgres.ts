import { queryDatabase, withDatabaseTransaction } from "./db.js"
import { estimateOpenAiTokenPriceCents } from "./openai-pricing.js"

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

export const LLM_CHUNK_KINDS = [
  "raw_event",
  "message_delta",
  "reasoning_delta",
  "completed",
  "mcp_call_start",
  "mcp_call_complete",
  "error",
  "cancelled",
] as const

export type LlmChunkKind = (typeof LLM_CHUNK_KINDS)[number]

export const SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS: readonly LlmChunkKind[] =
  ["raw_event", "completed"]

export type CreateOpeningHandLlmRunInput = {
  simulationId: string
  provider: string
  model: string
  reasoningEffort: string
  runtimeStreamKey: string
  fullPrompt: string
  requestPayload: unknown
}

export type CreateTurnLlmRunInput = {
  simulationId: string
  turnNumber: number
  provider: string
  model: string
  reasoningEffort: string
  runtimeStreamKey: string
  requireAutoSimulateNextStep?: boolean
}

export type OpeningHandLlmRun = {
  simulationId: string
  llmRunId: string
  attemptNumber: number
  runtimeStreamKey: string
  status: LlmRunStatus
}

export type TurnLlmRun = OpeningHandLlmRun & {
  turnNumber: number
}

export type PreparedTurnLlmRun = TurnLlmRun & {
  previousGameState: string | null
}

export type UpdateLlmRunRequestDataInput = {
  llmRunId: string
  fullPrompt: string
  requestPayload: unknown
}

export type LlmRunChunkInput = {
  sequence: number
  kind: LlmChunkKind
  providerEventType: string | null
  itemType: string | null
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
}

export type ActiveSimulationLlmRun = {
  simulationId: string
  llmRunId: string
  phase: LlmRunPhase
  runtimeStreamKey: string
  status: LlmRunStatus
}

export type SimulationDebugLlmRunChunk = {
  id: number
  sequence: number
  kind: LlmChunkKind
  providerEventType: string | null
  itemType: string | null
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
  receivedAt: string
}

export type SimulationDebugLlmRun = {
  llmRunId: string
  phase: LlmRunPhase
  provider: string
  model: string
  estimatedPriceCents: string | null
  reasoningEffort: string
  status: LlmRunStatus
  runtimeStreamKey: string | null
  attemptNumber: number
  turnNumber?: number
  gameState?: string
  outdated?: boolean
  openingHandIsValid?: boolean
  chunks: SimulationDebugLlmRunChunk[]
}

export type SimulationDebugInfo = {
  simulationId: string
  openingHandLlmRunCount: number
  turnLlmRunCount: number
  openingHandLlmRuns: SimulationDebugLlmRun[]
  turnLlmRuns: SimulationDebugLlmRun[]
}

export type SimulationResultsInfo = SimulationDebugInfo

export type StaleInFlightLlmRunCleanupResult = {
  cancelledLlmRunIds: string[]
  cancelledSimulationIds: string[]
}

export const STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE =
  "LLM run was cancelled because the server restarted before the in-flight API stream completed."
export const STALE_RUNNING_SIMULATION_CANCELLATION_MESSAGE =
  "Simulation was cancelled because the server restarted before it finished."
export const INVALID_OPENING_HAND_SIMULATION_FAILURE_MESSAGE =
  "Opening-hand LLM run did not produce a valid starting hand."
export const SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE =
  "Simulation auto-advance is disabled."
export const SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE =
  "Simulation auto-advance requires a running simulation."

export type SimulationNextStep =
  | {
      type: "opening_hand"
    }
  | {
      type: "turn"
      turnNumber: number
    }

export type SimulationCreationDecision = {
  simulationStatus: SimulationStatus
  nextStep: SimulationNextStep | null
}

export type SimulationCompletionDecision = {
  simulationStatus: SimulationStatus
  nextStep: SimulationNextStep | null
  disableAutoSimulateNextStep: boolean
  failureMessage: string | null
}

export type SimulationLlmCompletionResult = SimulationCompletionDecision & {
  simulationId: string
  deckId: string
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

export type TurnActionLogEntry = {
  sequence: number
  action: string
  createdAt: string
}

export type TurnActionLogResult = {
  simulationId: string
  llmRunId: string
  turnNumber: number
  attemptNumber: number
  latestAction: TurnActionLogEntry
  actions: TurnActionLogEntry[]
}

export type CreateSimulationInput = {
  seed: string
  turnsToSimulate: number
  startingHandId: string | null
}

export function getSimulationCreationDecision({
  hasPresetStartingHand,
  turnsToSimulate,
}: {
  hasPresetStartingHand: boolean
  turnsToSimulate: number
}): SimulationCreationDecision {
  if (!hasPresetStartingHand) {
    return {
      simulationStatus: "running",
      nextStep: {
        type: "opening_hand",
      },
    }
  }

  if (turnsToSimulate === 0) {
    return {
      simulationStatus: "completed",
      nextStep: null,
    }
  }

  return {
    simulationStatus: "running",
    nextStep: {
      type: "turn",
      turnNumber: 1,
    },
  }
}

export function getOpeningHandCompletionDecision({
  autoSimulateNextStep,
  openingHandIsValid,
  turnsToSimulate,
}: {
  autoSimulateNextStep: boolean
  openingHandIsValid: boolean
  turnsToSimulate: number
}): SimulationCompletionDecision {
  if (!openingHandIsValid) {
    return {
      simulationStatus: "failed",
      nextStep: null,
      disableAutoSimulateNextStep: true,
      failureMessage: INVALID_OPENING_HAND_SIMULATION_FAILURE_MESSAGE,
    }
  }

  if (turnsToSimulate === 0) {
    return {
      simulationStatus: "completed",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  }

  if (autoSimulateNextStep) {
    return {
      simulationStatus: "running",
      nextStep: {
        type: "turn",
        turnNumber: 1,
      },
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  }

  return {
    simulationStatus: "running",
    nextStep: null,
    disableAutoSimulateNextStep: false,
    failureMessage: null,
  }
}

export function getTurnCompletionDecision({
  autoSimulateNextStep,
  turnNumber,
  turnsToSimulate,
}: {
  autoSimulateNextStep: boolean
  turnNumber: number
  turnsToSimulate: number
}): SimulationCompletionDecision {
  if (turnNumber >= turnsToSimulate) {
    return {
      simulationStatus: "completed",
      nextStep: null,
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  }

  if (autoSimulateNextStep) {
    return {
      simulationStatus: "running",
      nextStep: {
        type: "turn",
        turnNumber: turnNumber + 1,
      },
      disableAutoSimulateNextStep: false,
      failureMessage: null,
    }
  }

  return {
    simulationStatus: "running",
    nextStep: null,
    disableAutoSimulateNextStep: false,
    failureMessage: null,
  }
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

export type SimulationIdentifier = {
  simulationId?: string
  llmRunId?: string
}

export type TurnSimulationPromptData = {
  simulationId: string
  deckId: string
  commanders: SimulationPromptCard[]
  libraryCards: SimulationPromptCard[]
  library: string[]
  startingHand: string[]
}

export class SimulationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SimulationValidationError"
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
  await createEnumType("llm_chunk_kind", LLM_CHUNK_KINDS)

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
      auto_simulate_next_step boolean NOT NULL DEFAULT true,

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
    ALTER TABLE simulations
    ADD COLUMN IF NOT EXISTS auto_simulate_next_step boolean NOT NULL DEFAULT true
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      phase llm_run_phase NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      reasoning_effort text NOT NULL DEFAULT '',

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
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS reasoning_effort text NOT NULL DEFAULT ''
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    DROP COLUMN IF EXISTS provider_run_id
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    DROP COLUMN IF EXISTS provider_request_id
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_chunks (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      kind llm_chunk_kind NOT NULL,
      provider_event_type text,
      item_type text,
      mcp_function_name text,
      mcp_function_output jsonb,
      reasoning_delta text,
      output_delta text,
      payload jsonb NOT NULL DEFAULT '{}',
      received_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT llm_run_chunks_kind_active_values_check
        CHECK (
          kind IN (
            'raw_event',
            'message_delta',
            'reasoning_delta',
            'completed',
            'mcp_call_start',
            'mcp_call_complete',
            'error',
            'cancelled'
          )
        ),
      UNIQUE (llm_run_id, sequence)
    )
  `)
  await ensureLlmRunChunksKindConstraint()
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_opening_hand_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      opening_hand jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(opening_hand) = 'array'),
      library_snapshot jsonb CHECK (library_snapshot IS NULL OR jsonb_typeof(library_snapshot) = 'array'),
      opening_hand_is_valid boolean NOT NULL DEFAULT false,
      random_state_snapshot bigint,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)
  await queryDatabase(`
    ALTER TABLE simulation_opening_hand_llm_runs
    ADD COLUMN IF NOT EXISTS opening_hand_is_valid boolean NOT NULL DEFAULT false
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_turn_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      turn_number integer NOT NULL CHECK (turn_number > 0),
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      game_state text,
      outdated boolean NOT NULL DEFAULT false,
      library_snapshot jsonb CHECK (library_snapshot IS NULL OR jsonb_typeof(library_snapshot) = 'array'),
      random_state_snapshot bigint,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, turn_number, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_llm_runs
    ADD COLUMN IF NOT EXISTS game_state text
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_llm_runs
    ADD COLUMN IF NOT EXISTS outdated boolean NOT NULL DEFAULT false
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_turn_actions (
      id bigserial PRIMARY KEY,

      turn_llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      sequence integer NOT NULL CHECK (sequence > 0),
      action text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (turn_llm_run_id, sequence)
    )
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
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_actions_turn_llm_run_id_sequence_idx
      ON simulation_turn_actions (turn_llm_run_id, sequence)
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

export async function getSimulationSummary(
  deckId: string,
  simulationId: string
): Promise<SimulationSummary | null> {
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
      WHERE id = $1
        AND deck_id = $2
    `,
    [simulationId, deckId]
  )
  const simulation = result.rows[0]

  if (!simulation) {
    return null
  }

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

export async function markSimulationCompleted(simulationId: string) {
  await withDatabaseTransaction(async (client) => {
    await markSimulationCompletedWithClient(client, simulationId)
  })
}

export async function markSimulationFailed(
  simulationId: string,
  failureMessage: string
) {
  await withDatabaseTransaction(async (client) => {
    await markSimulationFailedWithClient(client, simulationId, failureMessage)
  })
}

export async function markSimulationCancelled(
  simulationId: string,
  failureMessage?: string
) {
  await withDatabaseTransaction(async (client) => {
    await markSimulationCancelledWithClient(
      client,
      simulationId,
      failureMessage
    )
  })
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

export async function logTurnAction(
  simulationId: string,
  action: string
): Promise<TurnActionLogResult> {
  const trimmedAction = action.trim()

  if (!trimmedAction) {
    throw new SimulationValidationError("Turn action is required.")
  }

  return withDatabaseTransaction(async (client) => {
    const turnRunResult = await client.query<{
      simulation_id: string
      llm_run_id: string
      turn_number: number
      attempt_number: number
    }>(
      `
        SELECT
          turn_run.simulation_id,
          turn_run.llm_run_id,
          turn_run.turn_number,
          turn_run.attempt_number
        FROM simulation_turn_llm_runs turn_run
        JOIN llm_runs llm_run
          ON llm_run.id = turn_run.llm_run_id
        WHERE turn_run.simulation_id = $1
          AND llm_run.phase = 'turn'
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
        ORDER BY turn_run.turn_number DESC, turn_run.attempt_number DESC
        LIMIT 1
        FOR UPDATE OF turn_run
      `,
      [simulationId]
    )

    if (turnRunResult.rowCount === 0) {
      throw new SimulationValidationError(
        "No active turn LLM run exists for this simulation."
      )
    }

    const turnRun = turnRunResult.rows[0]
    const sequenceResult = await client.query<{ sequence: number }>(
      `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM simulation_turn_actions
        WHERE turn_llm_run_id = $1
      `,
      [turnRun.llm_run_id]
    )
    const sequence = Number(sequenceResult.rows[0].sequence)

    await client.query(
      `
        INSERT INTO simulation_turn_actions (
          turn_llm_run_id,
          sequence,
          action
        )
        VALUES ($1, $2, $3)
      `,
      [turnRun.llm_run_id, sequence, trimmedAction]
    )

    const actionsResult = await client.query<{
      sequence: number
      action: string
      created_at: Date
    }>(
      `
        SELECT
          sequence,
          action,
          created_at
        FROM simulation_turn_actions
        WHERE turn_llm_run_id = $1
        ORDER BY sequence ASC
      `,
      [turnRun.llm_run_id]
    )
    const actions = actionsResult.rows.map(mapTurnActionLogEntry)
    const latestAction = actions.find((entry) => entry.sequence === sequence)

    if (!latestAction) {
      throw new SimulationValidationError("Logged turn action not found.")
    }

    return {
      simulationId: turnRun.simulation_id,
      llmRunId: turnRun.llm_run_id,
      turnNumber: turnRun.turn_number,
      attemptNumber: turnRun.attempt_number,
      latestAction,
      actions,
    }
  })
}

function mapTurnActionLogEntry(row: {
  sequence: number
  action: string
  created_at: Date
}): TurnActionLogEntry {
  return {
    sequence: row.sequence,
    action: row.action,
    createdAt: row.created_at.toISOString(),
  }
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
          reasoning_effort,
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
          $5,
          $6::jsonb
        )
        RETURNING id, status, runtime_stream_key
      `,
      [
        input.provider,
        input.model,
        input.reasoningEffort,
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

    await markSimulationRunningWithClient(client, input.simulationId)

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

export async function resetSimulationForOpeningHandLlmRun(
  deckId: string,
  simulationId: string
) {
  await withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query<{
      deck_id: string
      seed: string
      starting_hand_id: string | null
    }>(
      `
        SELECT
          deck_id,
          seed,
          starting_hand_id
        FROM simulations
        WHERE id = $1
          AND deck_id = $2
        FOR UPDATE
      `,
      [simulationId, deckId]
    )

    if (simulationResult.rowCount === 0) {
      throw new SimulationValidationError("Simulation not found.")
    }

    const simulation = simulationResult.rows[0]

    if (simulation.starting_hand_id !== null) {
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
      [simulationId]
    )

    if ((activeRunResult.rowCount ?? 0) > 0) {
      throw new SimulationValidationError(
        "An opening-hand LLM run is already active for this simulation."
      )
    }

    const shuffledLibrary = await rebuildAndShuffleSimulationLibrary(
      client,
      simulation.deck_id,
      simulation.seed,
      1
    )

    await client.query(
      `
        UPDATE simulations
        SET library = $2::jsonb,
            random_state = $3,
            mulligan_count = 0,
            has_drawn_starting_hand = false,
            updated_at = now()
        WHERE id = $1
      `,
      [
        simulationId,
        JSON.stringify(shuffledLibrary.library),
        shuffledLibrary.randomState,
      ]
    )

    await client.query(
      `
        UPDATE simulation_turn_llm_runs
        SET outdated = true
        WHERE simulation_id = $1
      `,
      [simulationId]
    )
  })
}

export async function createTurnLlmRun(
  deckId: string,
  input: CreateTurnLlmRunInput
): Promise<PreparedTurnLlmRun> {
  assertPositiveInteger(input.turnNumber, "Turn number")

  return withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query<{
      id: string
      deck_id: string
      seed: string
      starting_hand_id: string | null
      status: SimulationStatus
      auto_simulate_next_step: boolean
    }>(
      `
        SELECT
          id,
          deck_id,
          seed,
          starting_hand_id,
          status,
          auto_simulate_next_step
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

    const simulation = simulationResult.rows[0]

    if (
      input.requireAutoSimulateNextStep &&
      !simulation.auto_simulate_next_step
    ) {
      throw new SimulationValidationError(
        SIMULATION_AUTO_ADVANCE_DISABLED_MESSAGE
      )
    }

    if (input.requireAutoSimulateNextStep && simulation.status !== "running") {
      throw new SimulationValidationError(
        SIMULATION_AUTO_ADVANCE_NOT_RUNNING_MESSAGE
      )
    }

    await assertNoActiveSimulationLlmRuns(client, input.simulationId)

    const previousGameState = await resetSimulationForTurnLlmRun(
      client,
      simulation,
      input.turnNumber
    )

    await client.query(
      `
        UPDATE simulation_turn_llm_runs
        SET outdated = true
        WHERE simulation_id = $1
          AND turn_number >= $2
      `,
      [input.simulationId, input.turnNumber]
    )

    const attemptResult = await client.query<{ attempt_number: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM simulation_turn_llm_runs
        WHERE simulation_id = $1
          AND turn_number = $2
      `,
      [input.simulationId, input.turnNumber]
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
          reasoning_effort,
          runtime_stream_key
        )
        VALUES (
          'turn',
          $1,
          $2,
          $3,
          $4
        )
        RETURNING id, status, runtime_stream_key
      `,
      [
        input.provider,
        input.model,
        input.reasoningEffort,
        input.runtimeStreamKey,
      ]
    )
    const llmRun = llmRunResult.rows[0]

    await client.query(
      `
        INSERT INTO simulation_turn_llm_runs (
          simulation_id,
          llm_run_id,
          turn_number,
          attempt_number
        )
        VALUES ($1, $2, $3, $4)
      `,
      [input.simulationId, llmRun.id, input.turnNumber, attemptNumber]
    )

    await markSimulationRunningWithClient(client, input.simulationId)

    return {
      simulationId: input.simulationId,
      llmRunId: llmRun.id,
      turnNumber: input.turnNumber,
      attemptNumber,
      runtimeStreamKey: llmRun.runtime_stream_key,
      status: llmRun.status,
      previousGameState,
    }
  })
}

export async function updateLlmRunRequestData({
  fullPrompt,
  llmRunId,
  requestPayload,
}: UpdateLlmRunRequestDataInput) {
  const result = await queryDatabase(
    `
      UPDATE llm_runs
      SET full_prompt = $2,
          request_payload = $3::jsonb,
          updated_at = now()
      WHERE id = $1
    `,
    [llmRunId, fullPrompt, JSON.stringify(requestPayload)]
  )

  if (result.rowCount === 0) {
    throw new SimulationValidationError("LLM run not found.")
  }
}

export async function appendLlmRunChunks(
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  if (chunks.length === 0) {
    return
  }

  const query = buildAppendLlmRunChunksQuery(llmRunId, chunks)

  await queryDatabase(query.text, query.values)
}

export async function appendLlmRunChunkAtNextSequence(
  llmRunId: string,
  chunk: Omit<LlmRunChunkInput, "sequence">
) {
  await withDatabaseTransaction(async (client) => {
    const runResult = await client.query(
      `
        SELECT id
        FROM llm_runs
        WHERE id = $1
        FOR UPDATE
      `,
      [llmRunId]
    )

    if (runResult.rowCount === 0) {
      throw new SimulationValidationError("LLM run not found.")
    }

    const sequenceResult = await client.query<{ sequence: number }>(
      `
        SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
        FROM llm_run_chunks
        WHERE llm_run_id = $1
      `,
      [llmRunId]
    )
    const sequence = Number(sequenceResult.rows[0].sequence)
    const query = buildAppendLlmRunChunksQuery(llmRunId, [
      {
        ...chunk,
        sequence,
      },
    ])

    await client.query(query.text, query.values)
  })
}

function buildAppendLlmRunChunksQuery(
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  const values: unknown[] = []
  const valuePlaceholders = chunks.map((chunk, index) => {
    const offset = index * 10

    values.push(
      llmRunId,
      chunk.sequence,
      chunk.kind,
      chunk.providerEventType,
      chunk.itemType,
      chunk.mcpFunctionName,
      chunk.mcpFunctionOutput === null
        ? null
        : JSON.stringify(chunk.mcpFunctionOutput),
      chunk.reasoningDelta,
      chunk.outputDelta,
      JSON.stringify(chunk.payload)
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::jsonb, $${offset + 8}, $${offset + 9}, $${offset + 10}::jsonb)`
  })

  return {
    text: `
      INSERT INTO llm_run_chunks (
        llm_run_id,
        sequence,
        kind,
        provider_event_type,
        item_type,
        mcp_function_name,
        mcp_function_output,
        reasoning_delta,
        output_delta,
        payload
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON CONFLICT (llm_run_id, sequence) DO NOTHING
    `,
    values,
  }
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
}): Promise<SimulationLlmCompletionResult> {
  return withDatabaseTransaction(async (client) => {
    const snapshotResult = await client.query<{
      simulation_id: string
      deck_id: string
      library: unknown
      random_state: string
      mulligan_count: number
      turns_to_simulate: number
      auto_simulate_next_step: boolean
      deck_library_card_count: number
    }>(
      `
        SELECT
          simulation.id AS simulation_id,
          simulation.deck_id,
          simulation.library,
          simulation.random_state,
          simulation.mulligan_count,
          simulation.turns_to_simulate,
          simulation.auto_simulate_next_step,
          COALESCE(deck_counts.library_card_count, 0)::integer AS deck_library_card_count
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN simulations simulation
          ON simulation.id = opening_run.simulation_id
        LEFT JOIN (
          SELECT deck_id, SUM(quantity)::integer AS library_card_count
          FROM deck_cards
          WHERE zone = 'library'
          GROUP BY deck_id
        ) deck_counts
          ON deck_counts.deck_id = simulation.deck_id
        WHERE opening_run.llm_run_id = $1
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Opening-hand LLM run not found.")
    }

    const snapshot = snapshotResult.rows[0]
    const librarySnapshot = parseStringArray(snapshot.library)
    const openingHandIsValid = isValidCompletedOpeningHand({
      deckLibraryCardCount: Number(snapshot.deck_library_card_count),
      librarySnapshot,
      mulliganCount: snapshot.mulligan_count,
      openingHand,
    })

    await client.query(
      `
        UPDATE simulation_opening_hand_llm_runs
        SET opening_hand = $2::jsonb,
            library_snapshot = $3::jsonb,
            random_state_snapshot = $4,
            opening_hand_is_valid = $5
        WHERE llm_run_id = $1
      `,
      [
        llmRunId,
        JSON.stringify(openingHand),
        JSON.stringify(librarySnapshot),
        snapshot.random_state,
        openingHandIsValid,
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

    const decision = getOpeningHandCompletionDecision({
      autoSimulateNextStep: snapshot.auto_simulate_next_step,
      openingHandIsValid,
      turnsToSimulate: snapshot.turns_to_simulate,
    })

    await applySimulationCompletionDecisionWithClient(
      client,
      snapshot.simulation_id,
      decision
    )

    return {
      simulationId: snapshot.simulation_id,
      deckId: snapshot.deck_id,
      ...decision,
    }
  })
}

export async function completeTurnLlmRun({
  gameState,
  llmRunId,
  responseMetadata,
  usage,
}: {
  llmRunId: string
  gameState: string
  responseMetadata: unknown
  usage: unknown
}): Promise<SimulationLlmCompletionResult> {
  return withDatabaseTransaction(async (client) => {
    const snapshotResult = await client.query<{
      simulation_id: string
      deck_id: string
      turn_number: number
      library: unknown
      random_state: string
      turns_to_simulate: number
      auto_simulate_next_step: boolean
    }>(
      `
        SELECT
          simulation.id AS simulation_id,
          simulation.deck_id,
          turn_run.turn_number,
          simulation.library,
          simulation.random_state,
          simulation.turns_to_simulate,
          simulation.auto_simulate_next_step
        FROM simulation_turn_llm_runs turn_run
        JOIN simulations simulation
          ON simulation.id = turn_run.simulation_id
        WHERE turn_run.llm_run_id = $1
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Turn LLM run not found.")
    }

    const snapshot = snapshotResult.rows[0]
    const librarySnapshot = parseStringArray(snapshot.library)

    await client.query(
      `
        UPDATE simulation_turn_llm_runs
        SET game_state = $2,
            library_snapshot = $3::jsonb,
            random_state_snapshot = $4
        WHERE llm_run_id = $1
      `,
      [
        llmRunId,
        gameState,
        JSON.stringify(librarySnapshot),
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

    const decision = getTurnCompletionDecision({
      autoSimulateNextStep: snapshot.auto_simulate_next_step,
      turnNumber: snapshot.turn_number,
      turnsToSimulate: snapshot.turns_to_simulate,
    })

    await applySimulationCompletionDecisionWithClient(
      client,
      snapshot.simulation_id,
      decision
    )

    return {
      simulationId: snapshot.simulation_id,
      deckId: snapshot.deck_id,
      ...decision,
    }
  })
}

export async function failLlmRun(llmRunId: string, failureMessage: string) {
  await withDatabaseTransaction(async (client) => {
    await client.query(
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

    await client.query(
      `
        UPDATE simulations
        SET status = 'failed',
            auto_simulate_next_step = false,
            failed_at = now(),
            failure_message = $2,
            updated_at = now()
        WHERE id IN (
          SELECT opening_run.simulation_id
          FROM simulation_opening_hand_llm_runs opening_run
          WHERE opening_run.llm_run_id = $1
          UNION
          SELECT turn_run.simulation_id
          FROM simulation_turn_llm_runs turn_run
          WHERE turn_run.llm_run_id = $1
        )
          AND status NOT IN ('completed', 'cancelled')
      `,
      [llmRunId, failureMessage]
    )
  })
}

export async function cancelLlmRun(llmRunId: string, failureMessage?: string) {
  await withDatabaseTransaction(async (client) => {
    await client.query(
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

    await client.query(
      `
        UPDATE simulations
        SET status = 'cancelled',
            auto_simulate_next_step = false,
            cancel_requested_at = COALESCE(cancel_requested_at, now()),
            failure_message = COALESCE($2, failure_message),
            updated_at = now()
        WHERE id IN (
          SELECT opening_run.simulation_id
          FROM simulation_opening_hand_llm_runs opening_run
          WHERE opening_run.llm_run_id = $1
          UNION
          SELECT turn_run.simulation_id
          FROM simulation_turn_llm_runs turn_run
          WHERE turn_run.llm_run_id = $1
        )
          AND EXISTS (
            SELECT 1
            FROM llm_runs llm_run
            WHERE llm_run.id = $1
              AND llm_run.status = 'cancelled'
          )
      `,
      [llmRunId, failureMessage ?? null]
    )
  })
}

export async function cancelStaleInFlightLlmRuns(): Promise<StaleInFlightLlmRunCleanupResult> {
  return withDatabaseTransaction(async (client) => {
    const activeRunsResult = await client.query<{
      id: string
      simulation_id: string | null
    }>(
      `
        SELECT
          llm_run.id,
          COALESCE(
            opening_run.simulation_id,
            turn_run.simulation_id
          ) AS simulation_id
        FROM llm_runs llm_run
        LEFT JOIN simulation_opening_hand_llm_runs opening_run
          ON opening_run.llm_run_id = llm_run.id
        LEFT JOIN simulation_turn_llm_runs turn_run
          ON turn_run.llm_run_id = llm_run.id
        WHERE llm_run.status IN ('pending', 'streaming', 'cancel_requested')
        ORDER BY llm_run.created_at ASC, llm_run.id ASC
        FOR UPDATE OF llm_run
      `
    )
    const cancelledLlmRunIds: string[] = []
    const cancelledSimulationIds = new Set<string>()

    for (const run of activeRunsResult.rows) {
      const sequenceResult = await client.query<{ sequence: number }>(
        `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
          FROM llm_run_chunks
          WHERE llm_run_id = $1
        `,
        [run.id]
      )
      const sequence = Number(sequenceResult.rows[0].sequence)
      const insertChunkQuery = buildAppendLlmRunChunksQuery(run.id, [
        {
          sequence,
          kind: "cancelled",
          providerEventType: "server.cancelled",
          itemType: null,
          mcpFunctionName: null,
          mcpFunctionOutput: null,
          reasoningDelta: null,
          outputDelta: null,
          payload: {
            message: STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE,
          },
        },
      ])

      await client.query(insertChunkQuery.text, insertChunkQuery.values)

      const cancelledRunResult = await client.query(
        `
          UPDATE llm_runs
          SET status = 'cancelled',
              cancelled_at = now(),
              failure_message = $2,
              updated_at = now()
          WHERE id = $1
            AND status IN ('pending', 'streaming', 'cancel_requested')
        `,
        [run.id, STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE]
      )

      if ((cancelledRunResult.rowCount ?? 0) > 0) {
        cancelledLlmRunIds.push(run.id)
      }
    }

    const activeSimulationIds = Array.from(
      new Set(
        activeRunsResult.rows.flatMap((run) =>
          run.simulation_id === null ? [] : [run.simulation_id]
        )
      )
    )

    if (activeSimulationIds.length > 0) {
      const activeSimulationCleanupResult = await client.query<{ id: string }>(
        `
          UPDATE simulations
          SET status = 'cancelled',
              auto_simulate_next_step = false,
              cancel_requested_at = COALESCE(cancel_requested_at, now()),
              failure_message = $2,
              updated_at = now()
          WHERE id = ANY($1::uuid[])
            AND status <> 'completed'
          RETURNING id
        `,
        [activeSimulationIds, STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE]
      )

      for (const simulation of activeSimulationCleanupResult.rows) {
        cancelledSimulationIds.add(simulation.id)
      }
    }

    const staleRunningSimulationCleanupResult = await client.query<{
      id: string
    }>(
      `
        UPDATE simulations
        SET status = 'cancelled',
            auto_simulate_next_step = false,
            cancel_requested_at = COALESCE(cancel_requested_at, now()),
            failure_message = $1,
            updated_at = now()
        WHERE status = 'running'
        RETURNING id
      `,
      [STALE_RUNNING_SIMULATION_CANCELLATION_MESSAGE]
    )

    for (const simulation of staleRunningSimulationCleanupResult.rows) {
      cancelledSimulationIds.add(simulation.id)
    }

    return {
      cancelledLlmRunIds,
      cancelledSimulationIds: Array.from(cancelledSimulationIds),
    }
  })
}

export async function requestCancelSimulationLlmRuns(
  deckId: string,
  simulationId: string
): Promise<ActiveSimulationLlmRun[]> {
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

    await client.query(
      `
        UPDATE simulations
        SET auto_simulate_next_step = false,
            cancel_requested_at = COALESCE(cancel_requested_at, now()),
            updated_at = now()
        WHERE id = $1
      `,
      [simulationId]
    )

    const activeRunsResult = await client.query<{
      simulation_id: string
      llm_run_id: string
      phase: LlmRunPhase
      runtime_stream_key: string
      status: LlmRunStatus
    }>(
      `
        SELECT
          opening_run.simulation_id,
          llm_run.id AS llm_run_id,
          llm_run.phase,
          llm_run.runtime_stream_key,
          llm_run.status
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN llm_runs llm_run
          ON llm_run.id = opening_run.llm_run_id
        WHERE opening_run.simulation_id = $1
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
        UNION ALL
        SELECT
          turn_run.simulation_id,
          llm_run.id AS llm_run_id,
          llm_run.phase,
          llm_run.runtime_stream_key,
          llm_run.status
        FROM simulation_turn_llm_runs turn_run
        JOIN llm_runs llm_run
          ON llm_run.id = turn_run.llm_run_id
        WHERE turn_run.simulation_id = $1
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
      phase: run.phase,
      runtimeStreamKey: run.runtime_stream_key,
      status: run.status,
    }))
  })
}

export async function listActiveSimulationLlmRuns(
  deckId: string,
  simulationId: string
): Promise<ActiveSimulationLlmRun[]> {
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

  const activeRunsResult = await queryDatabase<{
    simulation_id: string
    llm_run_id: string
    phase: LlmRunPhase
    runtime_stream_key: string
    status: LlmRunStatus
  }>(
    `
      SELECT
        opening_run.simulation_id,
        llm_run.id AS llm_run_id,
        llm_run.phase,
        llm_run.runtime_stream_key,
        llm_run.status
      FROM simulation_opening_hand_llm_runs opening_run
      JOIN llm_runs llm_run
        ON llm_run.id = opening_run.llm_run_id
      WHERE opening_run.simulation_id = $1
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      UNION ALL
      SELECT
        turn_run.simulation_id,
        llm_run.id AS llm_run_id,
        llm_run.phase,
        llm_run.runtime_stream_key,
        llm_run.status
      FROM simulation_turn_llm_runs turn_run
      JOIN llm_runs llm_run
        ON llm_run.id = turn_run.llm_run_id
      WHERE turn_run.simulation_id = $1
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
    `,
    [simulationId]
  )

  return activeRunsResult.rows.map((run) => ({
    simulationId: run.simulation_id,
    llmRunId: run.llm_run_id,
    phase: run.phase,
    runtimeStreamKey: run.runtime_stream_key,
    status: run.status,
  }))
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
    selectColumns:
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, NULL::boolean AS outdated, run.opening_hand_is_valid",
    orderBy: "run.attempt_number ASC",
  })
  const turnRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_turn_llm_runs",
    selectColumns:
      "run.attempt_number, run.turn_number, run.game_state, run.outdated, NULL::boolean AS opening_hand_is_valid",
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

export async function getSimulationResultsInfo(
  deckId: string,
  simulationId: string
): Promise<SimulationResultsInfo> {
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
    selectColumns:
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, NULL::boolean AS outdated, run.opening_hand_is_valid",
    orderBy: "run.attempt_number ASC",
    excludeChunkKinds: SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
    additionalWhereSql: `
      run.attempt_number = (
        SELECT MAX(latest_run.attempt_number)
        FROM simulation_opening_hand_llm_runs latest_run
        WHERE latest_run.simulation_id = run.simulation_id
      )
    `,
  })
  const turnRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_turn_llm_runs",
    selectColumns:
      "run.attempt_number, run.turn_number, run.game_state, run.outdated, NULL::boolean AS opening_hand_is_valid",
    orderBy: "run.turn_number ASC, run.attempt_number ASC",
    excludeChunkKinds: SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
    additionalWhereSql: "run.outdated = false",
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
  return withDatabaseTransaction(async (client) => {
    const linkedLlmRunResult = await client.query<{ llm_run_id: string }>(
      `
        SELECT llm_run_id
        FROM simulation_opening_hand_llm_runs
        WHERE simulation_id = $1
        UNION
        SELECT llm_run_id
        FROM simulation_turn_llm_runs
        WHERE simulation_id = $1
      `,
      [simulationId]
    )

    const result = await client.query(
      `
        DELETE FROM simulations
        WHERE id = $1
          AND deck_id = $2
      `,
      [simulationId, deckId]
    )

    if ((result.rowCount ?? 0) === 0) {
      return false
    }

    const llmRunIds = linkedLlmRunResult.rows.map((row) => row.llm_run_id)

    if (llmRunIds.length > 0) {
      await client.query(
        `
          DELETE FROM llm_runs
          WHERE id = ANY($1::uuid[])
        `,
        [llmRunIds]
      )
    }

    return true
  })
}

export async function resolveSimulationIdForActiveLlmRun(llmRunId: string) {
  const result = await queryDatabase<{
    simulation_id: string
    status: LlmRunStatus
    outdated: boolean
  }>(
    `
      SELECT
        opening_run.simulation_id,
        llm_run.status,
        false AS outdated
      FROM llm_runs llm_run
      JOIN simulation_opening_hand_llm_runs opening_run
        ON opening_run.llm_run_id = llm_run.id
      WHERE llm_run.id = $1
      UNION ALL
      SELECT
        turn_run.simulation_id,
        llm_run.status,
        turn_run.outdated
      FROM llm_runs llm_run
      JOIN simulation_turn_llm_runs turn_run
        ON turn_run.llm_run_id = llm_run.id
      WHERE llm_run.id = $1
      LIMIT 1
    `,
    [llmRunId]
  )
  const run = result.rows[0]

  if (!run) {
    throw new SimulationValidationError(
      "LLM run not found or is not associated with a simulation."
    )
  }

  if (!["pending", "streaming"].includes(run.status)) {
    throw new SimulationValidationError(
      "LLM run is not an active simulation run."
    )
  }

  if (run.outdated) {
    throw new SimulationValidationError("LLM run is outdated.")
  }

  return run.simulation_id
}

export async function resolveSimulationIdentifier({
  llmRunId,
  simulationId,
}: SimulationIdentifier) {
  const trimmedSimulationId = simulationId?.trim()
  const trimmedLlmRunId = llmRunId?.trim()

  if (trimmedLlmRunId) {
    const runSimulationId =
      await resolveSimulationIdForActiveLlmRun(trimmedLlmRunId)

    if (trimmedSimulationId && trimmedSimulationId !== runSimulationId) {
      throw new SimulationValidationError(
        "Provided simulationId does not match the simulation associated with llmRunId."
      )
    }

    return runSimulationId
  }

  if (trimmedSimulationId) {
    return trimmedSimulationId
  }

  throw new SimulationValidationError(
    "Provide either simulationId or llmRunId."
  )
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

export async function getTurnSimulationPromptData(
  simulationId: string
): Promise<TurnSimulationPromptData | null> {
  const simulationResult = await queryDatabase<{
    simulation_id: string
    deck_id: string
    starting_hand_id: string | null
    library: unknown
  }>(
    `
      SELECT
        id AS simulation_id,
        deck_id,
        starting_hand_id,
        library
      FROM simulations
      WHERE id = $1
    `,
    [simulationId]
  )
  const simulation = simulationResult.rows[0]

  if (!simulation) {
    return null
  }

  const cardsResult = await queryDatabase<SimulationPromptCardRow>(
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
  const cards = cardsResult.rows.map(mapSimulationPromptCard)

  return {
    simulationId: simulation.simulation_id,
    deckId: simulation.deck_id,
    commanders: cards.filter((card) => card.zone === "commander"),
    libraryCards: cards.filter((card) => card.zone === "library"),
    library: parseStringArray(simulation.library),
    startingHand: await getTurnSimulationStartingHand({
      simulationId,
      startingHandId: simulation.starting_hand_id,
    }),
  }
}

type SimulationDebugLlmRunRow = {
  llm_run_id: string
  phase: LlmRunPhase
  provider: string
  model: string
  usage: unknown
  reasoning_effort: string
  status: LlmRunStatus
  runtime_stream_key: string | null
  attempt_number: number
  turn_number: number | null
  game_state: string | null
  outdated: boolean | null
  opening_hand_is_valid: boolean | null
  chunk_id: string | null
  sequence: number | null
  kind: LlmChunkKind | null
  provider_event_type: string | null
  item_type: string | null
  mcp_function_name: string | null
  mcp_function_output: unknown | null
  reasoning_delta: string | null
  output_delta: string | null
  payload: unknown
  received_at: Date | null
}

async function getSimulationDebugLlmRuns({
  additionalWhereSql,
  excludeChunkKinds = [],
  orderBy,
  selectColumns,
  simulationId,
  tableName,
}: {
  simulationId: string
  tableName: "simulation_opening_hand_llm_runs" | "simulation_turn_llm_runs"
  selectColumns: string
  orderBy: string
  excludeChunkKinds?: readonly LlmChunkKind[]
  additionalWhereSql?: string
}): Promise<SimulationDebugLlmRun[]> {
  const result = await queryDatabase<SimulationDebugLlmRunRow>(
    `
      SELECT
        llm_run.id AS llm_run_id,
        llm_run.phase,
        llm_run.provider,
        llm_run.model,
        llm_run.usage,
        llm_run.reasoning_effort,
        llm_run.status,
        llm_run.runtime_stream_key,
        ${selectColumns},
        chunk.id AS chunk_id,
        chunk.sequence,
        chunk.kind,
        chunk.provider_event_type,
        chunk.item_type,
        chunk.mcp_function_name,
        chunk.mcp_function_output,
        chunk.reasoning_delta,
        chunk.output_delta,
        chunk.payload,
        chunk.received_at
      FROM ${tableName} run
      JOIN llm_runs llm_run
        ON llm_run.id = run.llm_run_id
      LEFT JOIN llm_run_chunks chunk
        ON chunk.llm_run_id = llm_run.id
       AND (
         COALESCE(array_length($2::llm_chunk_kind[], 1), 0) = 0
         OR chunk.kind <> ALL($2::llm_chunk_kind[])
        )
      WHERE run.simulation_id = $1
        ${additionalWhereSql ? `AND ${additionalWhereSql}` : ""}
      ORDER BY ${orderBy}, chunk.sequence ASC NULLS LAST
    `,
    [simulationId, excludeChunkKinds]
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
        estimatedPriceCents:
          estimateOpenAiTokenPriceCents({
            model: row.model,
            usage: row.usage,
          })?.formattedCents ?? null,
        reasoningEffort: row.reasoning_effort,
        status: row.status,
        runtimeStreamKey: row.runtime_stream_key,
        attemptNumber: row.attempt_number,
        chunks: [],
      }

      if (row.turn_number !== null) {
        run.turnNumber = row.turn_number
      }

      if (row.game_state !== null) {
        run.gameState = row.game_state
      }

      if (row.outdated !== null) {
        run.outdated = row.outdated
      }

      if (row.opening_hand_is_valid !== null) {
        run.openingHandIsValid = row.opening_hand_is_valid
      }

      runsById.set(row.llm_run_id, run)
    }

    if (row.chunk_id !== null && row.sequence !== null && row.kind !== null) {
      run.chunks.push({
        id: Number(row.chunk_id),
        sequence: row.sequence,
        kind: row.kind,
        providerEventType: row.provider_event_type,
        itemType: row.item_type,
        mcpFunctionName: row.mcp_function_name,
        mcpFunctionOutput: row.mcp_function_output,
        reasoningDelta: row.reasoning_delta,
        outputDelta: row.output_delta,
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

async function markSimulationRunningWithClient(
  client: DatabaseTransactionClient,
  simulationId: string
) {
  await client.query(
    `
      UPDATE simulations
      SET status = 'running',
          started_at = COALESCE(started_at, now()),
          completed_at = NULL,
          failed_at = NULL,
          cancel_requested_at = NULL,
          failure_message = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [simulationId]
  )
}

async function markSimulationCompletedWithClient(
  client: DatabaseTransactionClient,
  simulationId: string
) {
  await client.query(
    `
      UPDATE simulations
      SET status = 'completed',
          completed_at = now(),
          failed_at = NULL,
          failure_message = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [simulationId]
  )
}

async function markSimulationFailedWithClient(
  client: DatabaseTransactionClient,
  simulationId: string,
  failureMessage: string
) {
  await client.query(
    `
      UPDATE simulations
      SET status = 'failed',
          auto_simulate_next_step = false,
          failed_at = now(),
          failure_message = $2,
          updated_at = now()
      WHERE id = $1
        AND status NOT IN ('completed', 'cancelled')
    `,
    [simulationId, failureMessage]
  )
}

async function markSimulationCancelledWithClient(
  client: DatabaseTransactionClient,
  simulationId: string,
  failureMessage?: string
) {
  await client.query(
    `
      UPDATE simulations
      SET status = 'cancelled',
          auto_simulate_next_step = false,
          cancel_requested_at = COALESCE(cancel_requested_at, now()),
          failure_message = COALESCE($2, failure_message),
          updated_at = now()
      WHERE id = $1
    `,
    [simulationId, failureMessage ?? null]
  )
}

async function applySimulationCompletionDecisionWithClient(
  client: DatabaseTransactionClient,
  simulationId: string,
  decision: SimulationCompletionDecision
) {
  if (decision.simulationStatus === "failed") {
    await markSimulationFailedWithClient(
      client,
      simulationId,
      decision.failureMessage ?? "Simulation failed."
    )
    return
  }

  if (decision.simulationStatus === "completed") {
    await markSimulationCompletedWithClient(client, simulationId)
    return
  }

  if (decision.disableAutoSimulateNextStep) {
    await client.query(
      `
        UPDATE simulations
        SET auto_simulate_next_step = false,
            updated_at = now()
        WHERE id = $1
      `,
      [simulationId]
    )
  }
}

async function assertNoActiveSimulationLlmRuns(
  client: DatabaseTransactionClient,
  simulationId: string
) {
  const activeRunResult = await client.query(
    `
      SELECT 1
      FROM (
        SELECT llm_run.id
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN llm_runs llm_run
          ON llm_run.id = opening_run.llm_run_id
        WHERE opening_run.simulation_id = $1
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
        UNION ALL
        SELECT llm_run.id
        FROM simulation_turn_llm_runs turn_run
        JOIN llm_runs llm_run
          ON llm_run.id = turn_run.llm_run_id
        WHERE turn_run.simulation_id = $1
          AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      ) active_run
      LIMIT 1
    `,
    [simulationId]
  )

  if ((activeRunResult.rowCount ?? 0) > 0) {
    throw new SimulationValidationError(
      "An LLM run is already active for this simulation."
    )
  }
}

async function resetSimulationForTurnLlmRun(
  client: DatabaseTransactionClient,
  simulation: {
    id: string
    deck_id: string
    seed: string
    starting_hand_id: string | null
  },
  turnNumber: number
) {
  if (turnNumber === 1) {
    await resetSimulationForFirstTurnLlmRun(client, simulation)
    return null
  }

  const latestPreviousTurnRuns = await getLatestPreviousTurnRuns(
    client,
    simulation.id,
    turnNumber
  )
  const latestPreviousTurnRunsByTurn = new Map(
    latestPreviousTurnRuns.map((run) => [run.turn_number, run])
  )

  for (
    let previousTurnNumber = 1;
    previousTurnNumber < turnNumber;
    previousTurnNumber += 1
  ) {
    const previousTurnRun = latestPreviousTurnRunsByTurn.get(previousTurnNumber)

    if (!previousTurnRun) {
      throw new SimulationValidationError(
        `Turn ${previousTurnNumber} has not been simulated.`
      )
    }

    if (previousTurnRun.status !== "completed") {
      throw new SimulationValidationError(
        `The most recent turn ${previousTurnNumber} LLM run is not complete.`
      )
    }

    if (previousTurnRun.outdated) {
      throw new SimulationValidationError(
        `The most recent turn ${previousTurnNumber} LLM run is outdated.`
      )
    }
  }

  const immediatePreviousTurn = latestPreviousTurnRunsByTurn.get(turnNumber - 1)

  if (!immediatePreviousTurn) {
    throw new SimulationValidationError(
      `Turn ${turnNumber - 1} has not been simulated.`
    )
  }

  const previousGameState = immediatePreviousTurn.game_state?.trim()

  if (!previousGameState) {
    throw new SimulationValidationError(
      `The most recent turn ${turnNumber - 1} LLM run does not have a game state.`
    )
  }

  const librarySnapshot = parseRequiredStringArray(
    immediatePreviousTurn.library_snapshot,
    `The most recent turn ${turnNumber - 1} LLM run does not have a library snapshot.`
  )

  if (immediatePreviousTurn.random_state_snapshot === null) {
    throw new SimulationValidationError(
      `The most recent turn ${turnNumber - 1} LLM run does not have a random state snapshot.`
    )
  }

  await updateSimulationLibraryAndRandomState(
    client,
    simulation.id,
    librarySnapshot,
    immediatePreviousTurn.random_state_snapshot
  )

  return previousGameState
}

async function resetSimulationForFirstTurnLlmRun(
  client: DatabaseTransactionClient,
  simulation: {
    id: string
    deck_id: string
    seed: string
    starting_hand_id: string | null
  }
) {
  if (simulation.starting_hand_id !== null) {
    const shuffledLibrary = await createShuffledSimulationLibraryWithClient(
      client,
      simulation.deck_id,
      simulation.seed,
      simulation.starting_hand_id
    )

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
        simulation.id,
        JSON.stringify(shuffledLibrary.library),
        shuffledLibrary.randomState,
      ]
    )
    return
  }

  const openingHandResult = await client.query<{
    status: LlmRunStatus
    opening_hand_is_valid: boolean
    library_snapshot: unknown | null
    random_state_snapshot: string | null
  }>(
    `
      SELECT
        llm_run.status,
        opening_run.opening_hand_is_valid,
        opening_run.library_snapshot,
        opening_run.random_state_snapshot
      FROM simulation_opening_hand_llm_runs opening_run
      JOIN llm_runs llm_run
        ON llm_run.id = opening_run.llm_run_id
      WHERE opening_run.simulation_id = $1
      ORDER BY opening_run.attempt_number DESC
      LIMIT 1
    `,
    [simulation.id]
  )
  const latestOpeningHand = openingHandResult.rows[0]

  if (!latestOpeningHand) {
    throw new SimulationValidationError(
      "No opening-hand LLM run exists for this simulation."
    )
  }

  if (latestOpeningHand.status !== "completed") {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run is not complete."
    )
  }

  if (!latestOpeningHand.opening_hand_is_valid) {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run does not have a valid starting hand."
    )
  }

  const librarySnapshot = parseRequiredStringArray(
    latestOpeningHand.library_snapshot,
    "The most recent opening-hand LLM run does not have a library snapshot."
  )

  if (latestOpeningHand.random_state_snapshot === null) {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run does not have a random state snapshot."
    )
  }

  await client.query(
    `
      UPDATE simulations
      SET library = $2::jsonb,
          random_state = $3,
          has_drawn_starting_hand = true,
          updated_at = now()
      WHERE id = $1
    `,
    [
      simulation.id,
      JSON.stringify(librarySnapshot),
      latestOpeningHand.random_state_snapshot,
    ]
  )
}

async function getLatestPreviousTurnRuns(
  client: DatabaseTransactionClient,
  simulationId: string,
  turnNumber: number
) {
  const result = await client.query<{
    turn_number: number
    attempt_number: number
    status: LlmRunStatus
    outdated: boolean
    game_state: string | null
    library_snapshot: unknown | null
    random_state_snapshot: string | null
  }>(
    `
      SELECT DISTINCT ON (turn_run.turn_number)
        turn_run.turn_number,
        turn_run.attempt_number,
        llm_run.status,
        turn_run.outdated,
        turn_run.game_state,
        turn_run.library_snapshot,
        turn_run.random_state_snapshot
      FROM simulation_turn_llm_runs turn_run
      JOIN llm_runs llm_run
        ON llm_run.id = turn_run.llm_run_id
      WHERE turn_run.simulation_id = $1
        AND turn_run.turn_number < $2
      ORDER BY turn_run.turn_number ASC, turn_run.attempt_number DESC
    `,
    [simulationId, turnNumber]
  )

  return result.rows
}

async function updateSimulationLibraryAndRandomState(
  client: DatabaseTransactionClient,
  simulationId: string,
  library: readonly string[],
  randomState: string | number
) {
  await client.query(
    `
      UPDATE simulations
      SET library = $2::jsonb,
          random_state = $3,
          updated_at = now()
      WHERE id = $1
    `,
    [simulationId, JSON.stringify(library), randomState]
  )
}

function parseRequiredStringArray(value: unknown, errorMessage: string) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SimulationValidationError(errorMessage)
  }

  return value
}

async function getTurnSimulationStartingHand({
  simulationId,
  startingHandId,
}: {
  simulationId: string
  startingHandId: string | null
}) {
  if (startingHandId !== null) {
    const startingHandResult = await queryDatabase<{
      quantity: number
      name: string
    }>(
      `
        SELECT
          hand_card.quantity,
          card.name
        FROM starting_hand_cards hand_card
        JOIN deck_cards deck_card
          ON deck_card.id = hand_card.deck_card_id
        JOIN scryfall_oracle_cards card
          ON card.oracle_id = deck_card.oracle_id
        WHERE hand_card.starting_hand_id = $1
        ORDER BY card.name ASC, deck_card.id ASC
      `,
      [startingHandId]
    )

    return startingHandResult.rows.flatMap((card) =>
      Array.from({ length: card.quantity }, () => card.name)
    )
  }

  const openingHandResult = await queryDatabase<{
    opening_hand: unknown
    opening_hand_is_valid: boolean
  }>(
    `
      SELECT
        opening_hand,
        opening_hand_is_valid
      FROM simulation_opening_hand_llm_runs
      WHERE simulation_id = $1
      ORDER BY attempt_number DESC
      LIMIT 1
    `,
    [simulationId]
  )
  const latestOpeningHand = openingHandResult.rows[0]

  if (!latestOpeningHand) {
    throw new SimulationValidationError(
      "No opening-hand LLM run exists for this simulation."
    )
  }

  const openingHand = parseStringArray(latestOpeningHand.opening_hand)

  if (!latestOpeningHand.opening_hand_is_valid || openingHand.length === 0) {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run does not have a valid starting hand."
    )
  }

  return openingHand
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

export function isValidCompletedOpeningHand({
  deckLibraryCardCount,
  librarySnapshot,
  mulliganCount,
  openingHand,
}: {
  deckLibraryCardCount: number
  librarySnapshot: readonly string[]
  mulliganCount: number
  openingHand: readonly string[]
}) {
  const expectedOpeningHandCount = Math.max(
    0,
    7 - Math.max(0, mulliganCount - 1)
  )

  return (
    openingHand.length === expectedOpeningHandCount &&
    openingHand.length + librarySnapshot.length === deckLibraryCardCount
  )
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

async function createShuffledSimulationLibraryWithClient(
  client: DatabaseTransactionClient,
  deckId: string,
  seed: string,
  startingHandId: string | null
) {
  const libraryResult = await client.query<{
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
    ? await getStartingHandDeckCardQuantitiesWithClient(client, startingHandId)
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

async function getStartingHandDeckCardQuantitiesWithClient(
  client: DatabaseTransactionClient,
  startingHandId: string
) {
  const result = await client.query<{
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

async function createEnumType(name: string, values: readonly string[]) {
  const sqlIdentifier = getSafeSqlIdentifier(name)

  await queryDatabase(`
    DO $$
    BEGIN
      CREATE TYPE ${sqlIdentifier} AS ENUM (${values
        .map(quoteSqlLiteral)
        .join(", ")});
    EXCEPTION
      WHEN duplicate_object THEN null;
    END
    $$;
  `)

  for (const value of values) {
    await queryDatabase(
      `ALTER TYPE ${sqlIdentifier} ADD VALUE IF NOT EXISTS ${quoteSqlLiteral(
        value
      )}`
    )
  }
}

async function ensureLlmRunChunksKindConstraint() {
  await queryDatabase(`
    ALTER TABLE llm_run_chunks
    DROP CONSTRAINT IF EXISTS llm_run_chunks_kind_active_values_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_run_chunks
    ADD CONSTRAINT llm_run_chunks_kind_active_values_check
      CHECK (
        kind IN (${LLM_CHUNK_KINDS.map(quoteSqlLiteral).join(", ")})
      )
  `)
}

function getSafeSqlIdentifier(identifier: string) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`)
  }

  return identifier
}

function quoteSqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

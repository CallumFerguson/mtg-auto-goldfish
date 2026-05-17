import { queryDatabase, withDatabaseTransaction } from "./db.js"
import {
  estimatePartialLlmRunCostUsd,
  estimatePresetTokenCostUsd,
  formatPreferredLlmRunCostAsCents,
  getOpenRouterReportedCostUsd,
} from "./llm-pricing.js"
import { normalizeScryfallCardNameForExactMatch } from "./scryfall-postgres.js"
import type { LlmProvider, ReasoningEffort } from "./llm-config.js"
import { BILLING_TIER_LIMITS } from "./subscription-tiers.js"
import {
  USAGE_LIMIT_OUT_OF_USAGE_MESSAGE,
  ensureUserUsageLimitWindowsForRunStartWithClient,
} from "./usage-limits-postgres.js"

type DatabaseTransactionClient = Parameters<
  Parameters<typeof withDatabaseTransaction>[0]
>[0]

export type SimulationStatus =
  | "pending"
  | "unmanaged"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type SimulationCreatedVia = "app" | "external_mcp"

export function getInitialSimulationStatus(
  createdVia: SimulationCreatedVia
): SimulationStatus {
  return createdVia === "external_mcp" ? "unmanaged" : "pending"
}

export type LlmRunStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"

export type LlmRunPhase = "opening_hand" | "turn" | "report" | "other"

export function canApplyLateLlmRunTerminalUpdate(status: LlmRunStatus) {
  return status === "pending" || status === "streaming"
}

export const LLM_CHUNK_KINDS = [
  "raw_event",
  "reasoning_start",
  "reasoning_delta",
  "reasoning_done",
  "output_start",
  "message_delta",
  "output_done",
  "completed",
  "final_parsed_output",
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
  llmModelPresetId: string
  provider: string
  model: string
  openrouterModelProvider: string | null
  reasoningEffort: string | null
  runtimeStreamKey: string
  fullPrompt: string
  requestPayload: unknown
}

export type CreateTurnLlmRunInput = {
  simulationId: string
  llmModelPresetId: string
  turnNumber: number
  provider: string
  model: string
  openrouterModelProvider: string | null
  reasoningEffort: string | null
  runtimeStreamKey: string
  requireAutoSimulateNextStep?: boolean
}

export type CreateReportLlmRunInput = {
  simulationId: string
  llmModelPresetId: string
  provider: string
  model: string
  openrouterModelProvider: string | null
  reasoningEffort: string | null
  runtimeStreamKey: string
  fullPrompt: string
  requestPayload: unknown
  requireAutoSimulateNextStep?: boolean
}

export type OpeningHandLlmRun = {
  simulationId: string
  llmRunId: string
  attemptNumber: number
  runtimeStreamKey: string
  status: LlmRunStatus
  createdAt: string
}

export type TurnLlmRun = OpeningHandLlmRun & {
  turnNumber: number
}

export type ReportLlmRun = OpeningHandLlmRun

export type PreparedTurnLlmRun = TurnLlmRun & {
  previousGameState: string | null
}

export type ClaimedQueuedLlmRun = {
  simulationId: string
  deckId: string
  llmRunId: string
  llmModelPresetId: string | null
  phase: Extract<LlmRunPhase, "opening_hand" | "turn" | "report">
  provider: string
  model: string
  openrouterModelProvider: string | null
  reasoningEffort: string | null
  runtimeStreamKey: string
  attemptNumber: number
  createdAt: string
  startedAt: string
  fullPrompt: string
  turnNumber?: number
}

export type UsageLimitedQueuedLlmRun = {
  usageLimitExceeded: true
  simulationId: string
  deckId: string
  llmRunId: string
  phase: Extract<LlmRunPhase, "opening_hand" | "turn" | "report">
  failureMessage: string
}

export type LlmRunQueueClaimResult =
  | ClaimedQueuedLlmRun
  | UsageLimitedQueuedLlmRun

export type UpdateLlmRunRequestDataInput = {
  llmRunId: string
  fullPrompt: string
  requestPayload: unknown
}

export type LlmRunChunkInput = {
  sequence: number
  kind: LlmChunkKind
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  mcpFunctionReason: string | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
}

export type LlmRunChunkCardMentionResolutionStatus =
  | "exact"
  | "face_exact"
  | "missing"

export type SimulationDebugLlmRunChunkCardMention = {
  requestedName: string
  resolutionStatus: LlmRunChunkCardMentionResolutionStatus
  resolvedName: string | null
  scryfallUri: string | null
  defaultImageUrl: string | null
}

export type RecordOpenRouterLlmRunGenerationInput = {
  llmRunId: string
  openrouterTurnIndex: number
  generationId: string
  responseMetadata: unknown
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
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  mcpFunctionReason: string | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
  cardMentions: SimulationDebugLlmRunChunkCardMention[]
  receivedAt: string
}

export type OpenRouterGeneration = {
  openrouterTurnIndex: number
  generationId: string
  createdAt: string
}

export type LlmRunMcpTokenPhase = Extract<LlmRunPhase, "opening_hand" | "turn">

export type LlmRunMcpTokenContext = {
  deckId: string
  llmRunId: string
  phase: LlmRunMcpTokenPhase
  simulationId: string
}

export type TurnEvaluationJson = {
  legalTurnPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  illegalActions: string[]
  reasoningMistakes: string[]
  strategicMistakes: string[]
}

export type EvaluationLlmModelPreset = {
  id: string
  provider: LlmProvider
  model: string
  reasoningEffort: ReasoningEffort
  openrouterModelProvider: string | null
  isEnabled: boolean
}

export type TurnEvaluation = {
  id: number
  simulationId: string
  turnLlmRunId: string
  llmModelPresetId: string | null
  llmModelPreset: EvaluationLlmModelPreset | null
  legalTurnPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  evaluationJson: TurnEvaluationJson
  createdAt: string
  updatedAt: string
}

export type OpeningHandEvaluationJson = {
  legalSimulationPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  illegalActions: string[]
  reasoningMistakes: string[]
  strategicMistakes: string[]
}

export type OpeningHandEvaluation = {
  id: number
  simulationId: string
  openingHandLlmRunId: string
  llmModelPresetId: string | null
  llmModelPreset: EvaluationLlmModelPreset | null
  legalSimulationPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  evaluationJson: OpeningHandEvaluationJson
  createdAt: string
  updatedAt: string
}

export const TURN_EVALUATION_UPSERT_SQL = `
  WITH upserted AS (
    INSERT INTO simulation_turn_evaluations (
      simulation_id,
      turn_llm_run_id,
      llm_model_preset_id,
      legal_turn_pass,
      reasoning_pass,
      simulation_quality_score,
      evaluation_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (turn_llm_run_id)
    DO UPDATE
    SET llm_model_preset_id = EXCLUDED.llm_model_preset_id,
        legal_turn_pass = EXCLUDED.legal_turn_pass,
        reasoning_pass = EXCLUDED.reasoning_pass,
        simulation_quality_score = EXCLUDED.simulation_quality_score,
        evaluation_json = EXCLUDED.evaluation_json,
        updated_at = now()
    RETURNING
      id,
      simulation_id,
      turn_llm_run_id,
      llm_model_preset_id,
      legal_turn_pass,
      reasoning_pass,
      simulation_quality_score::float8 AS simulation_quality_score,
      evaluation_json,
      created_at,
      updated_at
  )
  SELECT
    upserted.id,
    upserted.simulation_id,
    upserted.turn_llm_run_id,
    upserted.llm_model_preset_id,
    preset.provider AS llm_model_preset_provider,
    preset.model AS llm_model_preset_model,
    preset.reasoning_effort AS llm_model_preset_reasoning_effort,
    preset.openrouter_model_provider AS llm_model_preset_openrouter_model_provider,
    preset.is_enabled AS llm_model_preset_is_enabled,
    upserted.legal_turn_pass,
    upserted.reasoning_pass,
    upserted.simulation_quality_score,
    upserted.evaluation_json,
    upserted.created_at,
    upserted.updated_at
  FROM upserted
  LEFT JOIN llm_model_presets preset
    ON preset.id = upserted.llm_model_preset_id
`

export const OPENING_HAND_EVALUATION_UPSERT_SQL = `
  WITH upserted AS (
    INSERT INTO simulation_opening_hand_evaluations (
      simulation_id,
      opening_hand_llm_run_id,
      llm_model_preset_id,
      legal_simulation_pass,
      reasoning_pass,
      simulation_quality_score,
      evaluation_json
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (opening_hand_llm_run_id)
    DO UPDATE
    SET llm_model_preset_id = EXCLUDED.llm_model_preset_id,
        legal_simulation_pass = EXCLUDED.legal_simulation_pass,
        reasoning_pass = EXCLUDED.reasoning_pass,
        simulation_quality_score = EXCLUDED.simulation_quality_score,
        evaluation_json = EXCLUDED.evaluation_json,
        updated_at = now()
    RETURNING
      id,
      simulation_id,
      opening_hand_llm_run_id,
      llm_model_preset_id,
      legal_simulation_pass,
      reasoning_pass,
      simulation_quality_score::float8 AS simulation_quality_score,
      evaluation_json,
      created_at,
      updated_at
  )
  SELECT
    upserted.id,
    upserted.simulation_id,
    upserted.opening_hand_llm_run_id,
    upserted.llm_model_preset_id,
    preset.provider AS llm_model_preset_provider,
    preset.model AS llm_model_preset_model,
    preset.reasoning_effort AS llm_model_preset_reasoning_effort,
    preset.openrouter_model_provider AS llm_model_preset_openrouter_model_provider,
    preset.is_enabled AS llm_model_preset_is_enabled,
    upserted.legal_simulation_pass,
    upserted.reasoning_pass,
    upserted.simulation_quality_score,
    upserted.evaluation_json,
    upserted.created_at,
    upserted.updated_at
  FROM upserted
  LEFT JOIN llm_model_presets preset
    ON preset.id = upserted.llm_model_preset_id
`

export type SimulationDebugLlmRun = {
  llmRunId: string
  llmModelPresetId: string | null
  phase: LlmRunPhase
  provider: string
  model: string
  estimatedPriceCents: string | null
  reasoningEffort: string | null
  status: LlmRunStatus
  runtimeStreamKey: string | null
  attemptNumber: number
  failureMessage: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  turnNumber?: number
  gameState?: string
  report?: string
  outdated?: boolean
  openingHandIsValid?: boolean
  openingHandEvaluation?: OpeningHandEvaluation | null
  turnEvaluation?: TurnEvaluation | null
  openrouterGenerations: OpenRouterGeneration[]
  chunks: SimulationDebugLlmRunChunk[]
}

export type SimulationDebugInfo = {
  simulationId: string
  openingHandLlmRunCount: number
  turnLlmRunCount: number
  reportLlmRunCount: number
  openingHandLlmRuns: SimulationDebugLlmRun[]
  turnLlmRuns: SimulationDebugLlmRun[]
  reportLlmRuns: SimulationDebugLlmRun[]
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
  | {
      type: "report"
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
  createdVia: SimulationCreatedVia
  llmModelPresetId: string | null
  startingHandId: string | null
  seed: string
  library: string[]
  turnsToSimulate: number
  autoGenerateReport: boolean
  completedLlmRunCount: number
  activeLlmRunCount: number
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
  requestedCards: string[]
  matches: {
    requestedCard: string
    foundCard: string | null
  }[]
  foundCards: string[]
  cardsRemaining: number
}

export const TURN_PHASE_CHANGES = [
  "untap",
  "upkeep",
  "draw",
  "precombat_main",
  "combat",
  "postcombat_main",
  "end_step_cleanup",
] as const

export type TurnPhaseChange = (typeof TURN_PHASE_CHANGES)[number]

export type TurnActionLogEntry = {
  sequence: number
  action: string
  phaseChange: TurnPhaseChange | null
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
  llmModelPresetId: string | null
  turnsToSimulate: number
  autoGenerateReport: boolean
  startingHandId: string | null
  createdVia?: SimulationCreatedVia
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
  autoGenerateReport,
  autoSimulateNextStep,
  turnNumber,
  turnsToSimulate,
}: {
  autoGenerateReport: boolean
  autoSimulateNextStep: boolean
  turnNumber: number
  turnsToSimulate: number
}): SimulationCompletionDecision {
  if (turnNumber >= turnsToSimulate) {
    if (autoGenerateReport && autoSimulateNextStep) {
      return {
        simulationStatus: "completed",
        nextStep: {
          type: "report",
        },
        disableAutoSimulateNextStep: false,
        failureMessage: null,
      }
    }

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
  mulliganGuidelines: string | null
  commanders: SimulationPromptCard[]
  library: SimulationPromptCard[]
}

export type DeckCardReferenceData = {
  deckId: string
  name: string
  description: string | null
  mulliganGuidelines: string | null
  strategyGuidelines: string | null
  format: string
  createdAt: string
  updatedAt: string
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
  strategyGuidelines: string | null
  commanders: SimulationPromptCard[]
  libraryCards: SimulationPromptCard[]
  library: string[]
  startingHand: string[]
}

export type SimulationReportTurnPromptData = {
  turnNumber: number
  summary: string
  gameState: string
  loggedActions: string[]
}

export type SimulationReportPromptData = {
  simulationId: string
  deckId: string
  seed: string
  turnsToSimulate: number
  startingHand: string[]
  openingHandSummary: string | null
  turns: SimulationReportTurnPromptData[]
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
    "unmanaged",
    "running",
    "completed",
    "failed",
    "cancelled",
  ])
  await createEnumType("simulation_created_via", ["app", "external_mcp"])
  await createEnumType("llm_run_status", [
    "pending",
    "streaming",
    "completed",
    "failed",
    "cancel_requested",
    "cancelled",
  ])
  await createEnumType("llm_run_phase", [
    "opening_hand",
    "turn",
    "report",
    "other",
  ])
  await createEnumType("llm_chunk_kind", LLM_CHUNK_KINDS)
  await createEnumType("llm_run_chunk_card_mention_resolution_status", [
    "exact",
    "face_exact",
    "missing",
  ])

  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      created_via simulation_created_via NOT NULL DEFAULT 'app',
      llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT,

      seed text NOT NULL,
      random_state bigint NOT NULL,
      turns_to_simulate integer NOT NULL CHECK (turns_to_simulate >= 0),
      starting_hand_id uuid REFERENCES starting_hands(id) ON DELETE SET NULL,
      library jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(library) = 'array'),
      mulligan_count integer NOT NULL DEFAULT 0 CHECK (mulligan_count >= 0),
      has_drawn_starting_hand boolean NOT NULL DEFAULT false,
      auto_simulate_next_step boolean NOT NULL DEFAULT true,
      auto_generate_report boolean NOT NULL DEFAULT false,

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
    ALTER TABLE simulations
    ADD COLUMN IF NOT EXISTS auto_generate_report boolean NOT NULL DEFAULT false
  `)
  await queryDatabase(`
    ALTER TABLE simulations
    ADD COLUMN IF NOT EXISTS created_via simulation_created_via NOT NULL DEFAULT 'app'
  `)
  await queryDatabase(`
    ALTER TABLE simulations
    ADD COLUMN IF NOT EXISTS llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT
  `)
  await queryDatabase(`
    UPDATE simulations
    SET status = 'unmanaged',
        updated_at = now()
    WHERE created_via = 'external_mcp'
      AND status = 'pending'
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      phase llm_run_phase NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      openrouter_model_provider text,
      reasoning_effort text,
      llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT,
      owner_user_id text REFERENCES "user"(id) ON DELETE SET NULL,

      status llm_run_status NOT NULL DEFAULT 'pending',
      runtime_stream_key text UNIQUE,
      queued_at timestamptz,

      full_prompt text NOT NULL DEFAULT '',
      request_payload jsonb NOT NULL DEFAULT '{}',
      response_metadata jsonb NOT NULL DEFAULT '{}',
      usage jsonb NOT NULL DEFAULT '{}',
      estimated_cost_usd numeric,
      openrouter_reported_cost_usd numeric,

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
    ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS openrouter_reported_cost_usd numeric
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    DROP CONSTRAINT IF EXISTS llm_runs_costs_nonnegative_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD CONSTRAINT llm_runs_costs_nonnegative_check
      CHECK (
        (estimated_cost_usd IS NULL OR estimated_cost_usd >= 0)
        AND (openrouter_reported_cost_usd IS NULL OR openrouter_reported_cost_usd >= 0)
      )
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS openrouter_model_provider text
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ALTER COLUMN openrouter_model_provider DROP NOT NULL
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ALTER COLUMN openrouter_model_provider DROP DEFAULT
  `)
  await queryDatabase(`
    UPDATE llm_runs
    SET openrouter_model_provider = NULL
    WHERE provider <> 'openrouter'
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    DROP CONSTRAINT IF EXISTS llm_runs_openrouter_model_provider_requires_openrouter_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD CONSTRAINT llm_runs_openrouter_model_provider_requires_openrouter_check
      CHECK (
        openrouter_model_provider IS NULL
        OR provider = 'openrouter'
      )
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS reasoning_effort text
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES "user"(id) ON DELETE SET NULL
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ADD COLUMN IF NOT EXISTS queued_at timestamptz
  `)
  await queryDatabase(`
    UPDATE llm_runs llm_run
    SET owner_user_id = deck.owner_user_id,
        updated_at = now()
    FROM (
      SELECT simulation_id, llm_run_id
      FROM simulation_opening_hand_llm_runs
      UNION
      SELECT simulation_id, llm_run_id
      FROM simulation_turn_llm_runs
      UNION
      SELECT simulation_id, llm_run_id
      FROM simulation_report_llm_runs
    ) linked_run
    JOIN simulations simulation
      ON simulation.id = linked_run.simulation_id
    JOIN decks deck
      ON deck.id = simulation.deck_id
    WHERE llm_run.id = linked_run.llm_run_id
      AND llm_run.owner_user_id IS NULL
      AND deck.owner_user_id IS NOT NULL
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ALTER COLUMN reasoning_effort DROP NOT NULL
  `)
  await queryDatabase(`
    ALTER TABLE llm_runs
    ALTER COLUMN reasoning_effort DROP DEFAULT
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
    CREATE TABLE IF NOT EXISTS llm_run_openrouter_generations (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      openrouter_turn_index integer NOT NULL CHECK (openrouter_turn_index >= 0),
      generation_id text NOT NULL CHECK (btrim(generation_id) <> ''),
      response_metadata jsonb NOT NULL DEFAULT '{}',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (llm_run_id, openrouter_turn_index),
      UNIQUE (generation_id)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_chunks (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      kind llm_chunk_kind NOT NULL,
      mcp_function_name text,
      mcp_function_output jsonb,
      mcp_function_reason text,
      reasoning_delta text,
      output_delta text,
      payload jsonb NOT NULL DEFAULT '{}',
      received_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT llm_run_chunks_kind_active_values_check
        CHECK (
          kind IN (${LLM_CHUNK_KINDS.map(quoteSqlLiteral).join(", ")})
        ),
      UNIQUE (llm_run_id, sequence)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_chunk_card_mentions (
      id bigserial PRIMARY KEY,

      llm_run_chunk_id bigint NOT NULL REFERENCES llm_run_chunks(id) ON DELETE CASCADE,
      source_path text NOT NULL,
      position integer NOT NULL CHECK (position >= 0),
      requested_name text NOT NULL CHECK (btrim(requested_name) <> ''),
      normalized_name text NOT NULL,
      oracle_id uuid REFERENCES scryfall_oracle_cards(oracle_id) ON DELETE SET NULL,
      resolution_status llm_run_chunk_card_mention_resolution_status NOT NULL,
      resolved_name text,
      default_image_url text,

      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (llm_run_chunk_id, source_path, position, requested_name)
    )
  `)
  await queryDatabase(`
    ALTER TABLE llm_run_chunks
    ADD COLUMN IF NOT EXISTS mcp_function_reason text
  `)
  await queryDatabase(`
    ALTER TABLE llm_run_chunks
    DROP COLUMN IF EXISTS provider_event_type
  `)
  await queryDatabase(`
    ALTER TABLE llm_run_chunks
    DROP COLUMN IF EXISTS item_type
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
    CREATE TABLE IF NOT EXISTS simulation_opening_hand_evaluations (
      id bigserial PRIMARY KEY,

      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      opening_hand_llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT,

      legal_simulation_pass boolean NOT NULL,
      reasoning_pass boolean NOT NULL,
      simulation_quality_score numeric(4,2) NOT NULL CHECK (
        simulation_quality_score >= 0
        AND simulation_quality_score <= 10
      ),
      evaluation_json jsonb NOT NULL CHECK (jsonb_typeof(evaluation_json) = 'object'),

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (opening_hand_llm_run_id)
    )
  `)
  await queryDatabase(`
    ALTER TABLE simulation_opening_hand_evaluations
    ADD COLUMN IF NOT EXISTS llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT
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
      phase_change text,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (turn_llm_run_id, sequence)
    )
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_actions
    ADD COLUMN IF NOT EXISTS phase_change text
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_actions
    DROP CONSTRAINT IF EXISTS simulation_turn_actions_phase_change_check
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_actions
    ADD CONSTRAINT simulation_turn_actions_phase_change_check
      CHECK (
        phase_change IS NULL
        OR phase_change IN (${TURN_PHASE_CHANGES.map(quoteSqlLiteral).join(", ")})
      )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_turn_evaluations (
      id bigserial PRIMARY KEY,

      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      turn_llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT,

      legal_turn_pass boolean NOT NULL,
      reasoning_pass boolean NOT NULL,
      simulation_quality_score numeric(4,2) NOT NULL CHECK (
        simulation_quality_score >= 0
        AND simulation_quality_score <= 10
      ),
      evaluation_json jsonb NOT NULL CHECK (jsonb_typeof(evaluation_json) = 'object'),

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (turn_llm_run_id)
    )
  `)
  await queryDatabase(`
    ALTER TABLE simulation_turn_evaluations
    ADD COLUMN IF NOT EXISTS llm_model_preset_id uuid REFERENCES llm_model_presets(id) ON DELETE RESTRICT
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_report_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      report text,
      outdated boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_mcp_tokens (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      phase llm_run_phase NOT NULL,
      token_hash text NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT llm_run_mcp_tokens_phase_check
        CHECK (phase IN ('opening_hand', 'turn')),
      UNIQUE (llm_run_id),
      UNIQUE (token_hash)
    )
  `)

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_deck_id_idx
      ON simulations (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_llm_model_preset_id_idx
      ON simulations (llm_model_preset_id)
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
    CREATE INDEX IF NOT EXISTS llm_runs_llm_model_preset_id_idx
      ON llm_runs (llm_model_preset_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_queue_idx
      ON llm_runs (status, queued_at, id)
      WHERE status = 'pending' AND queued_at IS NOT NULL
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_streaming_owner_idx
      ON llm_runs (owner_user_id)
      WHERE status = 'streaming'
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_mcp_tokens_hash_phase_idx
      ON llm_run_mcp_tokens (token_hash, phase)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_openrouter_generations_llm_run_id_turn_idx
      ON llm_run_openrouter_generations (llm_run_id, openrouter_turn_index)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_chunks_llm_run_id_sequence_idx
      ON llm_run_chunks (llm_run_id, sequence)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_chunk_card_mentions_chunk_id_idx
      ON llm_run_chunk_card_mentions (llm_run_chunk_id, position)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_chunk_card_mentions_oracle_id_idx
      ON llm_run_chunk_card_mentions (oracle_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_opening_hand_llm_runs_simulation_id_idx
      ON simulation_opening_hand_llm_runs (simulation_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_opening_hand_evaluations_simulation_id_idx
      ON simulation_opening_hand_evaluations (simulation_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_llm_runs_simulation_id_turn_number_idx
      ON simulation_turn_llm_runs (simulation_id, turn_number)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_actions_turn_llm_run_id_sequence_idx
      ON simulation_turn_actions (turn_llm_run_id, sequence)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_evaluations_simulation_id_idx
      ON simulation_turn_evaluations (simulation_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_report_llm_runs_simulation_id_idx
      ON simulation_report_llm_runs (simulation_id)
  `)
}

type SimulationSummaryRow = {
  id: string
  deck_id: string
  created_via: SimulationCreatedVia
  llm_model_preset_id: string | null
  starting_hand_id: string | null
  seed: string
  library: unknown
  turns_to_simulate: number
  auto_generate_report: boolean
  completed_llm_run_count: number
  active_llm_run_count: number
  status: SimulationStatus
  created_at: Date
  updated_at: Date
}

const SIMULATION_SUMMARY_COMPLETED_RUN_COUNT_SQL = `
  (
    SELECT COUNT(*)::integer
    FROM simulation_opening_hand_llm_runs opening_run
    JOIN llm_runs llm_run
      ON llm_run.id = opening_run.llm_run_id
    WHERE opening_run.simulation_id = simulations.id
      AND opening_run.attempt_number = (
        SELECT MAX(latest_run.attempt_number)
        FROM simulation_opening_hand_llm_runs latest_run
        WHERE latest_run.simulation_id = opening_run.simulation_id
      )
      AND (
        llm_run.status IN ('pending', 'streaming', 'cancel_requested', 'failed', 'cancelled')
        OR (
          llm_run.status = 'completed'
          AND opening_run.opening_hand_is_valid = true
        )
      )
  ) + (
    SELECT COUNT(*)::integer
    FROM simulation_turn_llm_runs turn_run
    JOIN llm_runs llm_run
      ON llm_run.id = turn_run.llm_run_id
    WHERE turn_run.simulation_id = simulations.id
      AND turn_run.outdated = false
      AND (
        llm_run.status IN ('pending', 'streaming', 'cancel_requested', 'failed', 'cancelled')
        OR (
          llm_run.status = 'completed'
          AND turn_run.game_state IS NOT NULL
          AND btrim(turn_run.game_state) <> ''
        )
      )
  ) + (
    SELECT COUNT(*)::integer
    FROM simulation_report_llm_runs report_run
    JOIN llm_runs llm_run
      ON llm_run.id = report_run.llm_run_id
    WHERE report_run.simulation_id = simulations.id
      AND report_run.outdated = false
      AND (
        llm_run.status IN ('pending', 'streaming', 'cancel_requested', 'failed', 'cancelled')
        OR (
          llm_run.status = 'completed'
          AND report_run.report IS NOT NULL
          AND btrim(report_run.report) <> ''
        )
      )
  )
`

const SIMULATION_SUMMARY_ACTIVE_RUN_COUNT_SQL = `
  (
    SELECT COUNT(*)::integer
    FROM (
      SELECT opening_run.llm_run_id
      FROM simulation_opening_hand_llm_runs opening_run
      JOIN llm_runs llm_run
        ON llm_run.id = opening_run.llm_run_id
      WHERE opening_run.simulation_id = simulations.id
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      UNION ALL
      SELECT turn_run.llm_run_id
      FROM simulation_turn_llm_runs turn_run
      JOIN llm_runs llm_run
        ON llm_run.id = turn_run.llm_run_id
      WHERE turn_run.simulation_id = simulations.id
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      UNION ALL
      SELECT report_run.llm_run_id
      FROM simulation_report_llm_runs report_run
      JOIN llm_runs llm_run
        ON llm_run.id = report_run.llm_run_id
      WHERE report_run.simulation_id = simulations.id
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
    ) active_run
  )
`

function mapSimulationSummaryRow(
  simulation: SimulationSummaryRow
): SimulationSummary {
  return {
    id: simulation.id,
    deckId: simulation.deck_id,
    createdVia: simulation.created_via,
    llmModelPresetId: simulation.llm_model_preset_id,
    startingHandId: simulation.starting_hand_id,
    seed: simulation.seed,
    library: parseStringArray(simulation.library),
    turnsToSimulate: simulation.turns_to_simulate,
    autoGenerateReport: simulation.auto_generate_report,
    completedLlmRunCount: simulation.completed_llm_run_count,
    activeLlmRunCount: simulation.active_llm_run_count,
    status: simulation.status,
    createdAt: simulation.created_at.toISOString(),
    updatedAt: simulation.updated_at.toISOString(),
  }
}

export async function listSimulationsForDeck(
  deckId: string
): Promise<SimulationSummary[]> {
  const result = await queryDatabase<SimulationSummaryRow>(
    `
      SELECT
        id,
        deck_id,
        created_via,
        llm_model_preset_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        auto_generate_report,
        ${SIMULATION_SUMMARY_COMPLETED_RUN_COUNT_SQL} AS completed_llm_run_count,
        ${SIMULATION_SUMMARY_ACTIVE_RUN_COUNT_SQL} AS active_llm_run_count,
        status,
        created_at,
        updated_at
      FROM simulations
      WHERE deck_id = $1
        AND created_via = 'app'
      ORDER BY created_at DESC
    `,
    [deckId]
  )

  return result.rows.map(mapSimulationSummaryRow)
}

export async function createSimulation(
  deckId: string,
  input: CreateSimulationInput
): Promise<SimulationSummary> {
  const seed = input.seed.trim()
  const createdVia = input.createdVia ?? "app"
  const llmModelPresetId = input.llmModelPresetId?.trim() || null

  if (!seed) {
    throw new SimulationValidationError("Simulation seed is required.")
  }

  if (createdVia !== "app" && createdVia !== "external_mcp") {
    throw new SimulationValidationError(
      "Simulation creation source is invalid."
    )
  }

  if (!Number.isInteger(input.turnsToSimulate) || input.turnsToSimulate < 0) {
    throw new SimulationValidationError(
      "Turns to simulate must be a non-negative integer."
    )
  }

  if (createdVia === "app" && llmModelPresetId === null) {
    throw new SimulationValidationError("Model preset is required.")
  }

  const deckResult = await queryDatabase("SELECT id FROM decks WHERE id = $1", [
    deckId,
  ])

  if (deckResult.rowCount === 0) {
    throw new SimulationValidationError("Deck not found.")
  }

  if (llmModelPresetId !== null) {
    const presetResult = await queryDatabase(
      `
        SELECT id
        FROM llm_model_presets
        WHERE id = $1
          AND is_enabled = true
      `,
      [llmModelPresetId]
    )

    if (presetResult.rowCount === 0) {
      throw new SimulationValidationError(
        "Model preset not found or disabled."
      )
    }
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
  const initialStatus = getInitialSimulationStatus(createdVia)

  const result = await queryDatabase<SimulationSummaryRow>(
    `
      INSERT INTO simulations (
        deck_id,
        created_via,
        llm_model_preset_id,
        seed,
        random_state,
        turns_to_simulate,
        auto_generate_report,
        starting_hand_id,
        library,
        has_drawn_starting_hand,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
      RETURNING
        id,
        deck_id,
        created_via,
        llm_model_preset_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        auto_generate_report,
        0::integer AS completed_llm_run_count,
        0::integer AS active_llm_run_count,
        status,
        created_at,
        updated_at
    `,
    [
      deckId,
      createdVia,
      llmModelPresetId,
      seed,
      shuffledLibrary.randomState,
      input.turnsToSimulate,
      input.autoGenerateReport,
      input.startingHandId,
      JSON.stringify(shuffledLibrary.library),
      input.startingHandId !== null,
      initialStatus,
    ]
  )

  return mapSimulationSummaryRow(result.rows[0])
}

export async function getSimulationSummary(
  deckId: string,
  simulationId: string
): Promise<SimulationSummary | null> {
  const result = await queryDatabase<SimulationSummaryRow>(
    `
      SELECT
        id,
        deck_id,
        created_via,
        llm_model_preset_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        auto_generate_report,
        ${SIMULATION_SUMMARY_COMPLETED_RUN_COUNT_SQL} AS completed_llm_run_count,
        ${SIMULATION_SUMMARY_ACTIVE_RUN_COUNT_SQL} AS active_llm_run_count,
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

  return mapSimulationSummaryRow(simulation)
}

export async function updateSimulationLlmModelPreset(
  deckId: string,
  simulationId: string,
  llmModelPresetId: string
): Promise<SimulationSummary> {
  const trimmedPresetId = llmModelPresetId.trim()

  if (!trimmedPresetId) {
    throw new SimulationValidationError("Model preset is required.")
  }

  const presetResult = await queryDatabase(
    `
      SELECT id
      FROM llm_model_presets
      WHERE id = $1
        AND is_enabled = true
    `,
    [trimmedPresetId]
  )

  if (presetResult.rowCount === 0) {
    throw new SimulationValidationError("Model preset not found or disabled.")
  }

  const result = await queryDatabase<SimulationSummaryRow>(
    `
      UPDATE simulations
      SET llm_model_preset_id = $3,
          updated_at = now()
      WHERE id = $1
        AND deck_id = $2
      RETURNING
        id,
        deck_id,
        created_via,
        llm_model_preset_id,
        starting_hand_id,
        seed,
        library,
        turns_to_simulate,
        auto_generate_report,
        ${SIMULATION_SUMMARY_COMPLETED_RUN_COUNT_SQL} AS completed_llm_run_count,
        ${SIMULATION_SUMMARY_ACTIVE_RUN_COUNT_SQL} AS active_llm_run_count,
        status,
        created_at,
        updated_at
    `,
    [simulationId, deckId, trimmedPresetId]
  )

  if (result.rowCount === 0) {
    throw new SimulationValidationError("Simulation not found.")
  }

  return mapSimulationSummaryRow(result.rows[0])
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
          ? `If you keep this hand, put ${cardsToBottomIfKept} card(s) on the bottom.`
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
      requestedCards,
      matches,
      foundCards,
      cardsRemaining: library.length,
    }
  })
}

export async function logTurnAction(
  simulationId: string,
  action: string,
  phaseChange: TurnPhaseChange | null = null
): Promise<TurnActionLogResult> {
  const trimmedAction = action.trim()

  if (!trimmedAction) {
    throw new SimulationValidationError("Turn action is required.")
  }

  if (phaseChange !== null && !isTurnPhaseChange(phaseChange)) {
    throw new SimulationValidationError("Turn phase change is invalid.")
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
          action,
          phase_change
        )
        VALUES ($1, $2, $3, $4)
      `,
      [turnRun.llm_run_id, sequence, trimmedAction, phaseChange]
    )

    const actionsResult = await client.query<{
      sequence: number
      action: string
      phase_change: TurnPhaseChange | null
      created_at: Date
    }>(
      `
        SELECT
          sequence,
          action,
          phase_change,
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
  phase_change: TurnPhaseChange | null
  created_at: Date
}): TurnActionLogEntry {
  return {
    sequence: row.sequence,
    action: row.action,
    phaseChange: row.phase_change,
    createdAt: row.created_at.toISOString(),
  }
}

function isTurnPhaseChange(value: string): value is TurnPhaseChange {
  return TURN_PHASE_CHANGES.includes(value as TurnPhaseChange)
}

export async function createOpeningHandLlmRun(
  deckId: string,
  input: CreateOpeningHandLlmRunInput
): Promise<OpeningHandLlmRun> {
  return withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query<{
      id: string
      starting_hand_id: string | null
      owner_user_id: string | null
    }>(
      `
        SELECT
          simulation.id,
          simulation.starting_hand_id,
          deck.owner_user_id
        FROM simulations simulation
        JOIN decks deck
          ON deck.id = simulation.deck_id
        WHERE simulation.id = $1
          AND simulation.deck_id = $2
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

    await assertNoActiveSimulationLlmRuns(client, input.simulationId)

    const attemptResult = await client.query<{ attempt_number: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM simulation_opening_hand_llm_runs
        WHERE simulation_id = $1
      `,
      [input.simulationId]
    )
    const attemptNumber = Number(attemptResult.rows[0].attempt_number)
    const openrouterModelProvider = getPersistableOpenRouterModelProvider(input)
    const llmRunResult = await client.query<{
      id: string
      status: LlmRunStatus
      runtime_stream_key: string
      created_at: Date
    }>(
      `
        INSERT INTO llm_runs (
          phase,
          llm_model_preset_id,
          provider,
          model,
          openrouter_model_provider,
          reasoning_effort,
          owner_user_id,
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
          $6,
          $7,
          $8,
          $9::jsonb
        )
        RETURNING id, status, runtime_stream_key, created_at
      `,
      [
        input.llmModelPresetId,
        input.provider,
        input.model,
        openrouterModelProvider,
        input.reasoningEffort,
        simulationResult.rows[0].owner_user_id,
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
      createdAt: llmRun.created_at.toISOString(),
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

    await assertNoActiveSimulationLlmRuns(client, simulationId)

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

    await markSimulationReportRunsOutdatedWithClient(client, simulationId)
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
      owner_user_id: string | null
    }>(
      `
        SELECT
          simulation.id,
          simulation.deck_id,
          simulation.seed,
          simulation.starting_hand_id,
          simulation.status,
          simulation.auto_simulate_next_step,
          deck.owner_user_id
        FROM simulations simulation
        JOIN decks deck
          ON deck.id = simulation.deck_id
        WHERE simulation.id = $1
          AND simulation.deck_id = $2
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

    await markSimulationReportRunsOutdatedWithClient(client, input.simulationId)

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
    const openrouterModelProvider = getPersistableOpenRouterModelProvider(input)
    const llmRunResult = await client.query<{
      id: string
      status: LlmRunStatus
      runtime_stream_key: string
      created_at: Date
    }>(
      `
        INSERT INTO llm_runs (
          phase,
          llm_model_preset_id,
          provider,
          model,
          openrouter_model_provider,
          reasoning_effort,
          owner_user_id,
          runtime_stream_key
        )
        VALUES (
          'turn',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7
        )
        RETURNING id, status, runtime_stream_key, created_at
      `,
      [
        input.llmModelPresetId,
        input.provider,
        input.model,
        openrouterModelProvider,
        input.reasoningEffort,
        simulation.owner_user_id,
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
      createdAt: llmRun.created_at.toISOString(),
      previousGameState,
    }
  })
}

export async function createReportLlmRun(
  deckId: string,
  input: CreateReportLlmRunInput
): Promise<ReportLlmRun> {
  return withDatabaseTransaction(async (client) => {
    const simulationResult = await client.query<{
      id: string
      auto_simulate_next_step: boolean
      owner_user_id: string | null
    }>(
      `
        SELECT
          simulation.id,
          simulation.auto_simulate_next_step,
          deck.owner_user_id
        FROM simulations simulation
        JOIN decks deck
          ON deck.id = simulation.deck_id
        WHERE simulation.id = $1
          AND simulation.deck_id = $2
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

    await assertNoActiveSimulationLlmRuns(client, input.simulationId)
    await markSimulationReportRunsOutdatedWithClient(client, input.simulationId)

    const attemptResult = await client.query<{ attempt_number: number }>(
      `
        SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number
        FROM simulation_report_llm_runs
        WHERE simulation_id = $1
      `,
      [input.simulationId]
    )
    const attemptNumber = Number(attemptResult.rows[0].attempt_number)
    const openrouterModelProvider = getPersistableOpenRouterModelProvider(input)
    const llmRunResult = await client.query<{
      id: string
      status: LlmRunStatus
      runtime_stream_key: string
      created_at: Date
    }>(
      `
        INSERT INTO llm_runs (
          phase,
          llm_model_preset_id,
          provider,
          model,
          openrouter_model_provider,
          reasoning_effort,
          owner_user_id,
          runtime_stream_key,
          full_prompt,
          request_payload
        )
        VALUES (
          'report',
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9::jsonb
        )
        RETURNING id, status, runtime_stream_key, created_at
      `,
      [
        input.llmModelPresetId,
        input.provider,
        input.model,
        openrouterModelProvider,
        input.reasoningEffort,
        simulation.owner_user_id,
        input.runtimeStreamKey,
        input.fullPrompt,
        JSON.stringify(input.requestPayload),
      ]
    )
    const llmRun = llmRunResult.rows[0]

    await client.query(
      `
        INSERT INTO simulation_report_llm_runs (
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
      createdAt: llmRun.created_at.toISOString(),
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

export async function markLlmRunQueued(llmRunId: string) {
  const result = await queryDatabase(
    `
      UPDATE llm_runs
      SET queued_at = COALESCE(queued_at, now()),
          updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING id
    `,
    [llmRunId]
  )

  return (result.rowCount ?? 0) > 0
}

export async function createLlmRunMcpToken({
  deckId,
  expiresAt,
  llmRunId,
  phase,
  simulationId,
  tokenHash,
}: LlmRunMcpTokenContext & {
  expiresAt: Date
  tokenHash: string
}) {
  await queryDatabase(
    `
      INSERT INTO llm_run_mcp_tokens (
        llm_run_id,
        simulation_id,
        deck_id,
        phase,
        token_hash,
        expires_at
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (llm_run_id)
      DO UPDATE SET
        token_hash = EXCLUDED.token_hash,
        phase = EXCLUDED.phase,
        expires_at = EXCLUDED.expires_at,
        revoked_at = NULL,
        updated_at = now()
    `,
    [llmRunId, simulationId, deckId, phase, tokenHash, expiresAt]
  )
}

export async function getActiveLlmRunMcpTokenContext({
  phase,
  tokenHash,
}: {
  phase: LlmRunMcpTokenPhase
  tokenHash: string
}): Promise<LlmRunMcpTokenContext | null> {
  const result = await queryDatabase<{
    deck_id: string
    llm_run_id: string
    phase: LlmRunMcpTokenPhase
    simulation_id: string
  }>(
    `
      SELECT
        token.deck_id,
        token.llm_run_id,
        token.phase,
        token.simulation_id
      FROM llm_run_mcp_tokens token
      JOIN llm_runs run
        ON run.id = token.llm_run_id
      WHERE token.token_hash = $1
        AND token.phase = $2
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
        AND run.status IN ('pending', 'streaming')
    `,
    [tokenHash, phase]
  )
  const token = result.rows[0]

  if (!token) {
    return null
  }

  return {
    deckId: token.deck_id,
    llmRunId: token.llm_run_id,
    phase: token.phase,
    simulationId: token.simulation_id,
  }
}

export async function revokeLlmRunMcpToken(llmRunId: string) {
  await queryDatabase(
    `
      UPDATE llm_run_mcp_tokens
      SET
        revoked_at = COALESCE(revoked_at, now()),
        updated_at = now()
      WHERE llm_run_id = $1
    `,
    [llmRunId]
  )
}

export async function appendLlmRunChunks(
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  if (chunks.length === 0) {
    return
  }

  await withDatabaseTransaction(async (client) => {
    await appendLlmRunChunksWithClient(client, llmRunId, chunks)
  })
}

export async function appendLlmRunChunkWithResolvedCardMentions(
  llmRunId: string,
  chunk: LlmRunChunkInput
): Promise<SimulationDebugLlmRunChunk | null> {
  return withDatabaseTransaction(async (client) => {
    const insertedChunks = await appendLlmRunChunksWithClient(
      client,
      llmRunId,
      [chunk]
    )
    const insertedChunk = insertedChunks[0]

    if (!insertedChunk) {
      return null
    }

    return mapInsertedLlmRunChunkRow(insertedChunk, insertedChunk.cardMentions)
  })
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
    await appendLlmRunChunksWithClient(client, llmRunId, [
      {
        ...chunk,
        sequence,
      },
    ])
  })
}

async function appendLlmRunChunksWithClient(
  client: DatabaseTransactionClient,
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  const query = buildAppendLlmRunChunksQuery(llmRunId, chunks)
  const result = await client.query<InsertedLlmRunChunkRow>(
    query.text,
    query.values
  )
  const insertedChunks = result.rows.map((row) => ({
    ...row,
    cardMentions: [] as SimulationDebugLlmRunChunkCardMention[],
  }))

  await insertLlmRunChunkCardMentions(client, insertedChunks)

  return insertedChunks
}

export function buildAppendLlmRunChunksQuery(
  llmRunId: string,
  chunks: readonly LlmRunChunkInput[]
) {
  const values: unknown[] = []
  const valuePlaceholders = chunks.map((chunk, index) => {
    const offset = index * 9

    values.push(
      llmRunId,
      chunk.sequence,
      chunk.kind,
      chunk.mcpFunctionName,
      chunk.mcpFunctionOutput === null
        ? null
        : JSON.stringify(chunk.mcpFunctionOutput),
      chunk.mcpFunctionReason ?? extractMcpFunctionReasonFromChunk(chunk),
      chunk.reasoningDelta,
      chunk.outputDelta,
      JSON.stringify(chunk.payload)
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::jsonb, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::jsonb)`
  })

  return {
    text: `
      INSERT INTO llm_run_chunks (
        llm_run_id,
        sequence,
        kind,
        mcp_function_name,
        mcp_function_output,
        mcp_function_reason,
        reasoning_delta,
        output_delta,
        payload
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON CONFLICT (llm_run_id, sequence) DO NOTHING
      RETURNING
        id,
        sequence,
        kind,
        mcp_function_name,
        mcp_function_output,
        mcp_function_reason,
        reasoning_delta,
        output_delta,
        payload,
        received_at
    `,
    values,
  }
}

export function extractMcpFunctionReasonFromChunk(
  chunk: Pick<
    LlmRunChunkInput,
    "kind" | "mcpFunctionName" | "mcpFunctionOutput"
  >
) {
  if (
    chunk.kind !== "mcp_call_complete" ||
    chunk.mcpFunctionName === "log_turn_action"
  ) {
    return null
  }

  const output = asUnknownRecord(chunk.mcpFunctionOutput)
  const directReason = getTrimmedStringProperty(output, "reason")

  if (directReason !== null) {
    return directReason
  }

  const data = asUnknownRecord(output.data)

  return getTrimmedStringProperty(data, "reason")
}

function getTrimmedStringProperty(
  record: Record<string, unknown>,
  property: string
) {
  const value = record[property]

  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()

  return trimmedValue ? trimmedValue : null
}

type InsertedLlmRunChunkRow = {
  id: string | number
  sequence: number
  kind: LlmChunkKind
  mcp_function_name: string | null
  mcp_function_output: unknown | null
  mcp_function_reason: string | null
  reasoning_delta: string | null
  output_delta: string | null
  payload: unknown
  received_at: Date
}

type InsertedLlmRunChunkWithMentions = InsertedLlmRunChunkRow & {
  cardMentions: SimulationDebugLlmRunChunkCardMention[]
}

export type LlmRunChunkCardMentionRequest = {
  sourcePath: string
  position: number
  requestedName: string
}

type LlmRunChunkCardMentionInsert = LlmRunChunkCardMentionRequest & {
  llmRunChunkId: number
  normalizedName: string
  oracleId: string | null
  resolutionStatus: LlmRunChunkCardMentionResolutionStatus
  resolvedName: string | null
  scryfallUri: string | null
  defaultImageUrl: string | null
}

type ResolvedCardMentionRow = {
  normalized_name: string
  oracle_id: string
  resolved_name: string
  scryfall_uri: string
  default_image_url: string | null
  resolution_status: LlmRunChunkCardMentionResolutionStatus
}

async function insertLlmRunChunkCardMentions(
  client: DatabaseTransactionClient,
  chunks: InsertedLlmRunChunkWithMentions[]
) {
  const mentionRequests = chunks.flatMap((chunk) =>
    extractLlmRunChunkCardMentionRequests({
      kind: chunk.kind,
      mcpFunctionName: chunk.mcp_function_name,
      mcpFunctionOutput: chunk.mcp_function_output,
      payload: chunk.payload,
    }).map((mention) => ({
      ...mention,
      llmRunChunkId: Number(chunk.id),
      normalizedName: normalizeScryfallCardNameForExactMatch(
        mention.requestedName
      ),
    }))
  )

  if (mentionRequests.length === 0) {
    return
  }

  const mentionInserts = await resolveLlmRunChunkCardMentions(
    client,
    mentionRequests
  )

  if (mentionInserts.length === 0) {
    return
  }

  const values: unknown[] = []
  const valuePlaceholders = mentionInserts.map((mention, index) => {
    const offset = index * 9

    values.push(
      mention.llmRunChunkId,
      mention.sourcePath,
      mention.position,
      mention.requestedName,
      mention.normalizedName,
      mention.oracleId,
      mention.resolutionStatus,
      mention.resolvedName,
      mention.defaultImageUrl
    )

    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}::llm_run_chunk_card_mention_resolution_status, $${offset + 8}, $${offset + 9})`
  })

  await client.query(
    `
      INSERT INTO llm_run_chunk_card_mentions (
        llm_run_chunk_id,
        source_path,
        position,
        requested_name,
        normalized_name,
        oracle_id,
        resolution_status,
        resolved_name,
        default_image_url
      )
      VALUES ${valuePlaceholders.join(", ")}
      ON CONFLICT (llm_run_chunk_id, source_path, position, requested_name) DO NOTHING
    `,
    values
  )

  const chunksById = new Map(chunks.map((chunk) => [Number(chunk.id), chunk]))

  for (const mention of mentionInserts) {
    chunksById.get(mention.llmRunChunkId)?.cardMentions.push({
      requestedName: mention.requestedName,
      resolutionStatus: mention.resolutionStatus,
      resolvedName: mention.resolvedName,
      scryfallUri: mention.scryfallUri,
      defaultImageUrl: mention.defaultImageUrl,
    })
  }
}

async function resolveLlmRunChunkCardMentions(
  client: DatabaseTransactionClient,
  requests: readonly (LlmRunChunkCardMentionRequest & {
    llmRunChunkId: number
    normalizedName: string
  })[]
): Promise<LlmRunChunkCardMentionInsert[]> {
  const normalizedNames = Array.from(
    new Set(requests.map((request) => request.normalizedName))
  ).filter(Boolean)
  const resolvedCardsByNormalizedName = await getResolvedCardsByNormalizedName(
    client,
    normalizedNames
  )

  return requests.map((request) => {
    const resolvedCard = resolvedCardsByNormalizedName.get(
      request.normalizedName
    )

    return {
      ...request,
      oracleId: resolvedCard?.oracle_id ?? null,
      resolutionStatus: resolvedCard?.resolution_status ?? "missing",
      resolvedName: resolvedCard?.resolved_name ?? null,
      scryfallUri: resolvedCard?.scryfall_uri ?? null,
      defaultImageUrl: resolvedCard?.default_image_url ?? null,
    }
  })
}

async function getResolvedCardsByNormalizedName(
  client: DatabaseTransactionClient,
  normalizedNames: readonly string[]
) {
  const resolvedCardsByNormalizedName = new Map<
    string,
    ResolvedCardMentionRow
  >()

  if (normalizedNames.length === 0) {
    return resolvedCardsByNormalizedName
  }

  const result = await client.query<ResolvedCardMentionRow>(
    `
      WITH requested AS (
        SELECT DISTINCT unnest($1::text[]) AS normalized_name
      ),
      matches AS (
        SELECT
          requested.normalized_name,
          card.oracle_id,
          card.name AS resolved_name,
          card.scryfall_uri,
          card.default_image_url,
          'exact'::llm_run_chunk_card_mention_resolution_status AS resolution_status,
          0 AS match_priority,
          CASE
            WHEN card.layout NOT IN ('art_series', 'emblem', 'token')
              AND COALESCE(card.type_line, '') NOT ILIKE 'Token%'
              AND card.games && ARRAY['arena', 'mtgo', 'paper']::text[]
              AND card.legalities->>'commander' IN ('banned', 'legal')
              THEN 0
            WHEN card.layout NOT IN ('art_series', 'emblem', 'token')
              AND COALESCE(card.type_line, '') NOT ILIKE 'Token%'
              AND card.games && ARRAY['arena', 'mtgo', 'paper']::text[]
              THEN 1
            ELSE 2
          END AS card_priority
        FROM requested
        JOIN scryfall_oracle_cards card
          ON card.normalized_name = requested.normalized_name

        UNION ALL

        SELECT
          requested.normalized_name,
          card.oracle_id,
          card.name AS resolved_name,
          card.scryfall_uri,
          COALESCE(face.default_image_url, card.default_image_url) AS default_image_url,
          'face_exact'::llm_run_chunk_card_mention_resolution_status AS resolution_status,
          1 AS match_priority,
          CASE
            WHEN card.layout NOT IN ('art_series', 'emblem', 'token')
              AND COALESCE(card.type_line, '') NOT ILIKE 'Token%'
              AND card.games && ARRAY['arena', 'mtgo', 'paper']::text[]
              AND card.legalities->>'commander' IN ('banned', 'legal')
              THEN 0
            WHEN card.layout NOT IN ('art_series', 'emblem', 'token')
              AND COALESCE(card.type_line, '') NOT ILIKE 'Token%'
              AND card.games && ARRAY['arena', 'mtgo', 'paper']::text[]
              THEN 1
            ELSE 2
          END AS card_priority
        FROM requested
        JOIN scryfall_card_faces face
          ON face.normalized_name = requested.normalized_name
        JOIN scryfall_oracle_cards card
          ON card.oracle_id = face.oracle_id
      )
      SELECT DISTINCT ON (normalized_name)
        normalized_name,
        oracle_id,
        resolved_name,
        scryfall_uri,
        default_image_url,
        resolution_status
      FROM matches
      ORDER BY normalized_name, card_priority ASC, match_priority ASC, resolved_name ASC
    `,
    [normalizedNames]
  )

  for (const row of result.rows) {
    resolvedCardsByNormalizedName.set(row.normalized_name, row)
  }

  return resolvedCardsByNormalizedName
}

export function extractLlmRunChunkCardMentionRequests(
  chunk: Pick<
    LlmRunChunkInput,
    "kind" | "mcpFunctionName" | "mcpFunctionOutput" | "payload"
  >
): LlmRunChunkCardMentionRequest[] {
  if (chunk.kind === "final_parsed_output") {
    return getArrayCardMentions(
      asUnknownRecord(chunk.payload).keptHand,
      "payload.keptHand"
    )
  }

  if (chunk.kind === "mcp_call_complete") {
    const toolOutputData = getToolOutputDataRecord(chunk.mcpFunctionOutput)

    switch (chunk.mcpFunctionName) {
      case "draw_starting_hand":
      case "mulligan":
      case "draw_card_from_top":
      case "draw_card_from_bottom":
        return getArrayCardMentions(toolOutputData.cards, "data.cards")
      case "return_card_to_library":
        return getSingleCardMention(toolOutputData.card, "data.card")
      case "return_cards_to_library":
        return getArrayCardMentions(toolOutputData.cards, "data.cards")
      case "take_cards_from_library":
        return getTakeCardsMatchMentions(toolOutputData.matches)
      default:
        return []
    }
  }

  return []
}

function getToolOutputDataRecord(output: unknown) {
  const outputRecord = asUnknownRecord(output)
  const dataRecord = asUnknownRecord(outputRecord.data)

  if (Object.hasOwn(outputRecord, "data") && dataRecord !== EMPTY_RECORD) {
    return dataRecord
  }

  return outputRecord
}

function getArrayCardMentions(
  value: unknown,
  sourcePath: string
): LlmRunChunkCardMentionRequest[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((cardName, index) =>
    getMentionFromCardName(cardName, sourcePath, index)
  )
}

function getSingleCardMention(
  value: unknown,
  sourcePath: string
): LlmRunChunkCardMentionRequest[] {
  return getMentionFromCardName(value, sourcePath, 0)
}

function getTakeCardsMatchMentions(
  value: unknown
): LlmRunChunkCardMentionRequest[] {
  if (!Array.isArray(value)) {
    return []
  }

  return value.flatMap((match, index) => {
    const matchRecord = asUnknownRecord(match)
    const foundCardMentions = getMentionFromCardName(
      matchRecord.foundCard,
      "data.matches[*].foundCard",
      index
    )

    if (foundCardMentions.length > 0) {
      return foundCardMentions
    }

    return getMentionFromCardName(
      matchRecord.requestedCard,
      "data.matches[*].requestedCard",
      index
    )
  })
}

function getMentionFromCardName(
  value: unknown,
  sourcePath: string,
  position: number
): LlmRunChunkCardMentionRequest[] {
  if (typeof value !== "string") {
    return []
  }

  const requestedName = value.trim()

  if (!requestedName) {
    return []
  }

  return [
    {
      sourcePath,
      position,
      requestedName,
    },
  ]
}

function mapInsertedLlmRunChunkRow(
  row: InsertedLlmRunChunkRow,
  cardMentions: SimulationDebugLlmRunChunkCardMention[] = []
): SimulationDebugLlmRunChunk {
  return {
    id: Number(row.id),
    sequence: row.sequence,
    kind: row.kind,
    mcpFunctionName: row.mcp_function_name,
    mcpFunctionOutput: row.mcp_function_output,
    mcpFunctionReason: row.mcp_function_reason,
    reasoningDelta: row.reasoning_delta,
    outputDelta: row.output_delta,
    payload: row.payload,
    cardMentions,
    receivedAt: row.received_at.toISOString(),
  }
}

const EMPTY_RECORD: Record<string, unknown> = {}

function asUnknownRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : EMPTY_RECORD
}

const LLM_RUN_QUEUE_ADVISORY_LOCK_ID = 836_417_052

export async function claimNextQueuedLlmRun({
  maxConcurrentRuns,
}: {
  maxConcurrentRuns: number
}): Promise<LlmRunQueueClaimResult | null> {
  return withDatabaseTransaction(async (client) => {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_xact_lock($1) AS acquired",
      [LLM_RUN_QUEUE_ADVISORY_LOCK_ID]
    )

    if (!lockResult.rows[0]?.acquired) {
      return null
    }

    const result = await client.query<{
      simulation_id: string
      deck_id: string
      llm_run_id: string
      llm_model_preset_id: string | null
      phase: Extract<LlmRunPhase, "opening_hand" | "turn" | "report">
      provider: string
      model: string
      openrouter_model_provider: string | null
      reasoning_effort: string | null
      runtime_stream_key: string
      attempt_number: number
      created_at: Date
      full_prompt: string
      turn_number: number | null
      owner_user_id: string | null
    }>(
      `
        WITH linked_run AS (
          SELECT
            opening_run.simulation_id,
            simulation.deck_id,
            opening_run.llm_run_id,
            opening_run.attempt_number,
            NULL::integer AS turn_number
          FROM simulation_opening_hand_llm_runs opening_run
          JOIN simulations simulation
            ON simulation.id = opening_run.simulation_id
          UNION ALL
          SELECT
            turn_run.simulation_id,
            simulation.deck_id,
            turn_run.llm_run_id,
            turn_run.attempt_number,
            turn_run.turn_number
          FROM simulation_turn_llm_runs turn_run
          JOIN simulations simulation
            ON simulation.id = turn_run.simulation_id
          UNION ALL
          SELECT
            report_run.simulation_id,
            simulation.deck_id,
            report_run.llm_run_id,
            report_run.attempt_number,
            NULL::integer AS turn_number
          FROM simulation_report_llm_runs report_run
          JOIN simulations simulation
            ON simulation.id = report_run.simulation_id
        ),
        candidate AS (
          SELECT
            llm_run.id,
            linked_run.simulation_id,
            linked_run.deck_id,
            linked_run.attempt_number,
            linked_run.turn_number
          FROM llm_runs llm_run
          JOIN linked_run
            ON linked_run.llm_run_id = llm_run.id
          WHERE llm_run.status = 'pending'
            AND llm_run.queued_at IS NOT NULL
            AND (
              SELECT COUNT(*)::integer
              FROM llm_runs active_run
              WHERE active_run.status = 'streaming'
            ) < $1::integer
            AND (
              SELECT COUNT(*)::integer
              FROM llm_runs active_run
              WHERE active_run.status = 'streaming'
                AND active_run.owner_user_id IS NOT DISTINCT FROM llm_run.owner_user_id
            ) < (
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM "subscription" active_subscription
                  WHERE active_subscription."referenceId" = llm_run.owner_user_id
                    AND active_subscription.status IN ('active', 'trialing')
                    AND lower(active_subscription.plan) = 'pro'
                ) THEN $4::integer
                WHEN EXISTS (
                  SELECT 1
                  FROM "subscription" active_subscription
                  WHERE active_subscription."referenceId" = llm_run.owner_user_id
                    AND active_subscription.status IN ('active', 'trialing')
                    AND lower(active_subscription.plan) = 'plus'
                ) THEN $3::integer
                ELSE $2::integer
              END
            )
          ORDER BY llm_run.queued_at ASC, llm_run.id ASC
          LIMIT 1
          FOR UPDATE OF llm_run SKIP LOCKED
        )
        SELECT
          candidate.simulation_id,
          candidate.deck_id,
          llm_run.id AS llm_run_id,
          llm_run.llm_model_preset_id,
          llm_run.phase,
          llm_run.provider,
          llm_run.model,
          llm_run.openrouter_model_provider,
          llm_run.reasoning_effort,
          llm_run.runtime_stream_key,
          candidate.attempt_number,
          llm_run.created_at,
          llm_run.full_prompt,
          candidate.turn_number,
          llm_run.owner_user_id
        FROM candidate
        JOIN llm_runs llm_run
          ON llm_run.id = candidate.id
      `,
      [
        maxConcurrentRuns,
        BILLING_TIER_LIMITS.free.maxConcurrentLlmRuns,
        BILLING_TIER_LIMITS.plus.maxConcurrentLlmRuns,
        BILLING_TIER_LIMITS.pro.maxConcurrentLlmRuns,
      ]
    )
    const run = result.rows[0]

    if (!run) {
      return null
    }

    const claimStartedAtResult = await client.query<{ claim_started_at: Date }>(
      "SELECT clock_timestamp() AS claim_started_at"
    )
    const claimStartedAt = claimStartedAtResult.rows[0]?.claim_started_at

    if (!claimStartedAt) {
      throw new Error("Failed to resolve LLM run claim timestamp.")
    }

    if (run.owner_user_id !== null) {
      const usageDecision =
        await ensureUserUsageLimitWindowsForRunStartWithClient(
          client,
          run.owner_user_id,
          claimStartedAt
        )

      if (!usageDecision.allowed) {
        const failRunQuery = buildFailQueuedLlmRunUsageLimitQuery(
          run.llm_run_id,
          USAGE_LIMIT_OUT_OF_USAGE_MESSAGE
        )
        await client.query(failRunQuery.text, failRunQuery.values)

        if (run.phase !== "report") {
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
            [run.simulation_id, USAGE_LIMIT_OUT_OF_USAGE_MESSAGE]
          )
        }

        return {
          usageLimitExceeded: true,
          simulationId: run.simulation_id,
          deckId: run.deck_id,
          llmRunId: run.llm_run_id,
          phase: run.phase,
          failureMessage: USAGE_LIMIT_OUT_OF_USAGE_MESSAGE,
        }
      }
    }

    const claimRunQuery = buildClaimQueuedLlmRunStreamingQuery(
      run.llm_run_id,
      claimStartedAt
    )
    const claimedResult = await client.query<{
      started_at: Date
    }>(claimRunQuery.text, claimRunQuery.values)
    const claimed = claimedResult.rows[0]

    if (!claimed) {
      return null
    }

    const claimedRun: ClaimedQueuedLlmRun = {
      simulationId: run.simulation_id,
      deckId: run.deck_id,
      llmRunId: run.llm_run_id,
      llmModelPresetId: run.llm_model_preset_id,
      phase: run.phase,
      provider: run.provider,
      model: run.model,
      openrouterModelProvider: run.openrouter_model_provider,
      reasoningEffort: run.reasoning_effort,
      runtimeStreamKey: run.runtime_stream_key,
      attemptNumber: run.attempt_number,
      createdAt: run.created_at.toISOString(),
      startedAt: claimed.started_at.toISOString(),
      fullPrompt: run.full_prompt,
    }

    if (run.turn_number !== null) {
      claimedRun.turnNumber = run.turn_number
    }

    return claimedRun
  })
}

export function buildClaimQueuedLlmRunStreamingQuery(
  llmRunId: string,
  startedAt: Date
) {
  return {
    text: `
      UPDATE llm_runs
      SET status = 'streaming',
          started_at = COALESCE(started_at, $2::timestamptz),
          updated_at = $2::timestamptz
      WHERE id = $1
        AND status = 'pending'
      RETURNING started_at
    `,
    values: [llmRunId, startedAt],
  }
}

export function buildFailQueuedLlmRunUsageLimitQuery(
  llmRunId: string,
  failureMessage: string
) {
  return {
    text: `
      UPDATE llm_runs
      SET status = 'failed',
          estimated_cost_usd = NULL,
          openrouter_reported_cost_usd = NULL,
          failed_at = now(),
          failure_message = $2,
          updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING id
    `,
    values: [llmRunId, failureMessage],
  }
}

export async function markLlmRunStreaming(llmRunId: string) {
  const result = await queryDatabase(
    `
      UPDATE llm_runs
      SET status = 'streaming',
          started_at = COALESCE(started_at, now()),
          updated_at = now()
      WHERE id = $1
        AND status = 'pending'
      RETURNING id
    `,
    [llmRunId]
  )

  return (result.rowCount ?? 0) > 0
}

export async function isLlmRunStreaming(llmRunId: string) {
  const result = await queryDatabase(
    `
      SELECT 1
      FROM llm_runs
      WHERE id = $1
        AND status = 'streaming'
      LIMIT 1
    `,
    [llmRunId]
  )

  return (result.rowCount ?? 0) > 0
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
      llm_run_status: LlmRunStatus
      provider: string
      input_token_cost_usd_per_million: string | number | null
      cached_input_token_cost_usd_per_million: string | number | null
      output_token_cost_usd_per_million: string | number | null
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
          llm_run.status AS llm_run_status,
          llm_run.provider,
          preset.input_token_cost_usd_per_million,
          preset.cached_input_token_cost_usd_per_million,
          preset.output_token_cost_usd_per_million,
          simulation.library,
          simulation.random_state,
          simulation.mulligan_count,
          simulation.turns_to_simulate,
          simulation.auto_simulate_next_step,
          COALESCE(deck_counts.library_card_count, 0)::integer AS deck_library_card_count
        FROM simulation_opening_hand_llm_runs opening_run
        JOIN llm_runs llm_run
          ON llm_run.id = opening_run.llm_run_id
        LEFT JOIN llm_model_presets preset
          ON preset.id = llm_run.llm_model_preset_id
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
        FOR UPDATE OF llm_run
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Opening-hand LLM run not found.")
    }

    const snapshot = snapshotResult.rows[0]
    const costValues = getCompletedLlmRunCostValues(snapshot, usage)

    if (!canApplyLateLlmRunTerminalUpdate(snapshot.llm_run_status)) {
      throw new SimulationValidationError("LLM run is no longer active.")
    }

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
            estimated_cost_usd = $4,
            openrouter_reported_cost_usd = $5,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming')
      `,
      [
        llmRunId,
        JSON.stringify(responseMetadata),
        JSON.stringify(usage),
        costValues.estimatedCostUsd,
        costValues.openrouterReportedCostUsd,
      ]
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
      llm_run_status: LlmRunStatus
      provider: string
      input_token_cost_usd_per_million: string | number | null
      cached_input_token_cost_usd_per_million: string | number | null
      output_token_cost_usd_per_million: string | number | null
      turn_number: number
      library: unknown
      random_state: string
      turns_to_simulate: number
      auto_simulate_next_step: boolean
      auto_generate_report: boolean
    }>(
      `
        SELECT
          simulation.id AS simulation_id,
          simulation.deck_id,
          llm_run.status AS llm_run_status,
          llm_run.provider,
          preset.input_token_cost_usd_per_million,
          preset.cached_input_token_cost_usd_per_million,
          preset.output_token_cost_usd_per_million,
          turn_run.turn_number,
          simulation.library,
          simulation.random_state,
          simulation.turns_to_simulate,
          simulation.auto_simulate_next_step,
          simulation.auto_generate_report
        FROM simulation_turn_llm_runs turn_run
        JOIN llm_runs llm_run
          ON llm_run.id = turn_run.llm_run_id
        LEFT JOIN llm_model_presets preset
          ON preset.id = llm_run.llm_model_preset_id
        JOIN simulations simulation
          ON simulation.id = turn_run.simulation_id
        WHERE turn_run.llm_run_id = $1
        FOR UPDATE OF llm_run
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Turn LLM run not found.")
    }

    const snapshot = snapshotResult.rows[0]
    const costValues = getCompletedLlmRunCostValues(snapshot, usage)

    if (!canApplyLateLlmRunTerminalUpdate(snapshot.llm_run_status)) {
      throw new SimulationValidationError("LLM run is no longer active.")
    }

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
            estimated_cost_usd = $4,
            openrouter_reported_cost_usd = $5,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming')
      `,
      [
        llmRunId,
        JSON.stringify(responseMetadata),
        JSON.stringify(usage),
        costValues.estimatedCostUsd,
        costValues.openrouterReportedCostUsd,
      ]
    )

    const decision = getTurnCompletionDecision({
      autoGenerateReport: snapshot.auto_generate_report,
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

export async function completeReportLlmRun({
  llmRunId,
  report,
  responseMetadata,
  usage,
}: {
  llmRunId: string
  report: string
  responseMetadata: unknown
  usage: unknown
}) {
  const trimmedReport = report.trim()

  if (!trimmedReport) {
    throw new SimulationValidationError("Report LLM response was empty.")
  }

  await withDatabaseTransaction(async (client) => {
    const snapshotResult = await client.query<{
      llm_run_status: LlmRunStatus
      provider: string
      input_token_cost_usd_per_million: string | number | null
      cached_input_token_cost_usd_per_million: string | number | null
      output_token_cost_usd_per_million: string | number | null
    }>(
      `
        SELECT
          llm_run.status AS llm_run_status,
          llm_run.provider,
          preset.input_token_cost_usd_per_million,
          preset.cached_input_token_cost_usd_per_million,
          preset.output_token_cost_usd_per_million
        FROM simulation_report_llm_runs report_run
        JOIN llm_runs llm_run
          ON llm_run.id = report_run.llm_run_id
        LEFT JOIN llm_model_presets preset
          ON preset.id = llm_run.llm_model_preset_id
        WHERE report_run.llm_run_id = $1
        FOR UPDATE OF llm_run
      `,
      [llmRunId]
    )

    if (snapshotResult.rowCount === 0) {
      throw new SimulationValidationError("Report LLM run not found.")
    }

    if (
      !canApplyLateLlmRunTerminalUpdate(snapshotResult.rows[0].llm_run_status)
    ) {
      throw new SimulationValidationError("LLM run is no longer active.")
    }

    const costValues = getCompletedLlmRunCostValues(
      snapshotResult.rows[0],
      usage
    )

    await client.query(
      `
        UPDATE simulation_report_llm_runs
        SET report = $2
        WHERE llm_run_id = $1
      `,
      [llmRunId, trimmedReport]
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'completed',
            response_metadata = $2::jsonb,
            usage = $3::jsonb,
            estimated_cost_usd = $4,
            openrouter_reported_cost_usd = $5,
            completed_at = now(),
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming')
      `,
      [
        llmRunId,
        JSON.stringify(responseMetadata),
        JSON.stringify(usage),
        costValues.estimatedCostUsd,
        costValues.openrouterReportedCostUsd,
      ]
    )
  })
}

function getCompletedLlmRunCostValues(
  run: {
    provider: string
    input_token_cost_usd_per_million: string | number | null
    cached_input_token_cost_usd_per_million: string | number | null
    output_token_cost_usd_per_million: string | number | null
  },
  usage: unknown
) {
  return {
    estimatedCostUsd: estimatePresetTokenCostUsd({
      tokenCosts: {
        inputDollarsPerMillion: toOptionalNumber(
          run.input_token_cost_usd_per_million
        ),
        cachedInputDollarsPerMillion: toOptionalNumber(
          run.cached_input_token_cost_usd_per_million
        ),
        outputDollarsPerMillion: toOptionalNumber(
          run.output_token_cost_usd_per_million
        ),
      },
      usage,
    }),
    openrouterReportedCostUsd:
      run.provider === "openrouter" ? getOpenRouterReportedCostUsd(usage) : null,
  }
}

type PartialLlmRunCostSnapshotRow = {
  full_prompt_character_count: string | number
  reasoning_delta_character_count: string | number
  output_delta_character_count: string | number
  cached_input_token_cost_usd_per_million: string | number | null
  output_token_cost_usd_per_million: string | number | null
}

export function buildPartialLlmRunCostSnapshotQuery(llmRunId: string) {
  return {
    text: `
      SELECT
        length(llm_run.full_prompt) AS full_prompt_character_count,
        COALESCE(SUM(length(COALESCE(chunk.reasoning_delta, ''))), 0) AS reasoning_delta_character_count,
        COALESCE(SUM(length(COALESCE(chunk.output_delta, ''))), 0) AS output_delta_character_count,
        preset.cached_input_token_cost_usd_per_million,
        preset.output_token_cost_usd_per_million
      FROM llm_runs llm_run
      LEFT JOIN llm_model_presets preset
        ON preset.id = llm_run.llm_model_preset_id
      LEFT JOIN llm_run_chunks chunk
        ON chunk.llm_run_id = llm_run.id
      WHERE llm_run.id = $1
      GROUP BY
        llm_run.id,
        preset.cached_input_token_cost_usd_per_million,
        preset.output_token_cost_usd_per_million
    `,
    values: [llmRunId],
  }
}

async function estimatePartialLlmRunCostUsdWithClient(
  client: DatabaseTransactionClient,
  llmRunId: string
) {
  const query = buildPartialLlmRunCostSnapshotQuery(llmRunId)
  const result = await client.query<PartialLlmRunCostSnapshotRow>(
    query.text,
    query.values
  )
  const snapshot = result.rows[0]

  if (!snapshot) {
    return null
  }

  return estimatePartialLlmRunCostUsd({
    fullPromptCharCount:
      toOptionalNumber(snapshot.full_prompt_character_count) ?? 0,
    reasoningDeltaCharCount:
      toOptionalNumber(snapshot.reasoning_delta_character_count) ?? 0,
    outputDeltaCharCount:
      toOptionalNumber(snapshot.output_delta_character_count) ?? 0,
    tokenCosts: {
      cachedInputDollarsPerMillion: toOptionalNumber(
        snapshot.cached_input_token_cost_usd_per_million
      ),
      outputDollarsPerMillion: toOptionalNumber(
        snapshot.output_token_cost_usd_per_million
      ),
    },
  })
}

export async function recordOpenRouterLlmRunGeneration({
  generationId,
  llmRunId,
  openrouterTurnIndex,
  responseMetadata,
}: RecordOpenRouterLlmRunGenerationInput): Promise<OpenRouterGeneration | null> {
  const trimmedGenerationId = generationId.trim()

  if (!Number.isInteger(openrouterTurnIndex) || openrouterTurnIndex < 0) {
    throw new SimulationValidationError(
      "OpenRouter turn index must be a non-negative integer."
    )
  }

  if (!trimmedGenerationId) {
    throw new SimulationValidationError(
      "OpenRouter generation ID must not be empty."
    )
  }

  const result = await queryDatabase<{
    openrouter_turn_index: number
    generation_id: string
    created_at: Date
  }>(
    `
      INSERT INTO llm_run_openrouter_generations (
        llm_run_id,
        openrouter_turn_index,
        generation_id,
        response_metadata
      )
      SELECT
        llm_run.id,
        $2,
        $3,
        $4::jsonb
      FROM llm_runs llm_run
      WHERE llm_run.id = $1
        AND llm_run.provider = 'openrouter'
      ON CONFLICT (llm_run_id, openrouter_turn_index)
      DO UPDATE
      SET generation_id = EXCLUDED.generation_id,
          response_metadata = EXCLUDED.response_metadata,
          updated_at = now()
      RETURNING openrouter_turn_index, generation_id, created_at
    `,
    [
      llmRunId,
      openrouterTurnIndex,
      trimmedGenerationId,
      JSON.stringify(responseMetadata ?? {}),
    ]
  )
  const generation = result.rows[0]

  if (!generation) {
    return null
  }

  return {
    openrouterTurnIndex: generation.openrouter_turn_index,
    generationId: generation.generation_id,
    createdAt: generation.created_at.toISOString(),
  }
}

export async function getOpenRouterGenerationForSimulation(
  deckId: string,
  simulationId: string,
  generationId: string
): Promise<OpenRouterGeneration | null> {
  const trimmedGenerationId = generationId.trim()

  if (!trimmedGenerationId) {
    throw new SimulationValidationError(
      "OpenRouter generation ID must not be empty."
    )
  }

  const result = await queryDatabase<{
    openrouter_turn_index: number
    generation_id: string
    created_at: Date
  }>(
    `
      SELECT
        generation.openrouter_turn_index,
        generation.generation_id,
        generation.created_at
      FROM llm_run_openrouter_generations generation
      JOIN llm_runs llm_run
        ON llm_run.id = generation.llm_run_id
      JOIN (
        SELECT simulation_id, llm_run_id
        FROM simulation_opening_hand_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_turn_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_report_llm_runs
      ) simulation_run
        ON simulation_run.llm_run_id = generation.llm_run_id
      JOIN simulations simulation
        ON simulation.id = simulation_run.simulation_id
      WHERE simulation.id = $1
        AND simulation.deck_id = $2
        AND llm_run.provider = 'openrouter'
        AND generation.generation_id = $3
      LIMIT 1
    `,
    [simulationId, deckId, trimmedGenerationId]
  )
  const generation = result.rows[0]

  if (!generation) {
    return null
  }

  return {
    openrouterTurnIndex: generation.openrouter_turn_index,
    generationId: generation.generation_id,
    createdAt: generation.created_at.toISOString(),
  }
}

export async function failLlmRun(llmRunId: string, failureMessage: string) {
  await withDatabaseTransaction(async (client) => {
    const estimatedCostUsd = await estimatePartialLlmRunCostUsdWithClient(
      client,
      llmRunId
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'failed',
            estimated_cost_usd = $3,
            failed_at = now(),
            failure_message = $2,
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming')
      `,
      [llmRunId, failureMessage, estimatedCostUsd]
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
          AND EXISTS (
            SELECT 1
            FROM llm_runs llm_run
            WHERE llm_run.id = $1
              AND llm_run.status = 'failed'
          )
          AND status NOT IN ('completed', 'cancelled')
      `,
      [llmRunId, failureMessage]
    )
  })
}

export async function failReportLlmRun(
  llmRunId: string,
  failureMessage: string
) {
  await withDatabaseTransaction(async (client) => {
    const estimatedCostUsd = await estimatePartialLlmRunCostUsdWithClient(
      client,
      llmRunId
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'failed',
            estimated_cost_usd = $3,
            failed_at = now(),
            failure_message = $2,
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming')
          AND phase = 'report'
      `,
      [llmRunId, failureMessage, estimatedCostUsd]
    )
  })
}

export async function cancelLlmRun(llmRunId: string, failureMessage?: string) {
  await withDatabaseTransaction(async (client) => {
    const estimatedCostUsd = await estimatePartialLlmRunCostUsdWithClient(
      client,
      llmRunId
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'cancelled',
            estimated_cost_usd = $3,
            cancelled_at = now(),
            failure_message = COALESCE($2, failure_message),
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming', 'cancel_requested')
      `,
      [llmRunId, failureMessage ?? null, estimatedCostUsd]
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

export async function cancelReportLlmRun(
  llmRunId: string,
  failureMessage?: string
) {
  await withDatabaseTransaction(async (client) => {
    const estimatedCostUsd = await estimatePartialLlmRunCostUsdWithClient(
      client,
      llmRunId
    )

    await client.query(
      `
        UPDATE llm_runs
        SET status = 'cancelled',
            estimated_cost_usd = $3,
            cancelled_at = now(),
            failure_message = COALESCE($2, failure_message),
            updated_at = now()
        WHERE id = $1
          AND status IN ('pending', 'streaming', 'cancel_requested')
          AND phase = 'report'
      `,
      [llmRunId, failureMessage ?? null, estimatedCostUsd]
    )
  })
}

export async function cancelStaleInFlightLlmRuns(): Promise<StaleInFlightLlmRunCleanupResult> {
  return withDatabaseTransaction(async (client) => {
    const activeRunsResult = await client.query<{
      id: string
      phase: LlmRunPhase
      simulation_id: string | null
    }>(
      `
        SELECT
          llm_run.id,
          llm_run.phase,
          COALESCE(
            opening_run.simulation_id,
            turn_run.simulation_id,
            report_run.simulation_id
          ) AS simulation_id
        FROM llm_runs llm_run
        LEFT JOIN simulation_opening_hand_llm_runs opening_run
          ON opening_run.llm_run_id = llm_run.id
        LEFT JOIN simulation_turn_llm_runs turn_run
          ON turn_run.llm_run_id = llm_run.id
        LEFT JOIN simulation_report_llm_runs report_run
          ON report_run.llm_run_id = llm_run.id
        WHERE (
          llm_run.status IN ('streaming', 'cancel_requested')
          OR (
            llm_run.status = 'pending'
            AND llm_run.queued_at IS NULL
          )
        )
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
          mcpFunctionName: null,
          mcpFunctionOutput: null,
          mcpFunctionReason: null,
          reasoningDelta: null,
          outputDelta: null,
          payload: {
            message: STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE,
          },
        },
      ])

      await client.query(insertChunkQuery.text, insertChunkQuery.values)

      const estimatedCostUsd = await estimatePartialLlmRunCostUsdWithClient(
        client,
        run.id
      )
      const cancelledRunResult = await client.query(
        `
          UPDATE llm_runs
          SET status = 'cancelled',
              estimated_cost_usd = $3,
              cancelled_at = now(),
              failure_message = $2,
              updated_at = now()
          WHERE id = $1
            AND (
              status IN ('streaming', 'cancel_requested')
              OR (
                status = 'pending'
                AND queued_at IS NULL
              )
            )
        `,
        [run.id, STALE_IN_FLIGHT_LLM_RUN_CANCELLATION_MESSAGE, estimatedCostUsd]
      )

      if ((cancelledRunResult.rowCount ?? 0) > 0) {
        cancelledLlmRunIds.push(run.id)
      }
    }

    const activeSimulationIds = Array.from(
      new Set(
        activeRunsResult.rows.flatMap((run) =>
          run.simulation_id === null || run.phase === "report"
            ? []
            : [run.simulation_id]
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
          AND NOT EXISTS (
            SELECT 1
            FROM (
              SELECT opening_run.llm_run_id
              FROM simulation_opening_hand_llm_runs opening_run
              WHERE opening_run.simulation_id = simulations.id
              UNION ALL
              SELECT turn_run.llm_run_id
              FROM simulation_turn_llm_runs turn_run
              WHERE turn_run.simulation_id = simulations.id
              UNION ALL
              SELECT report_run.llm_run_id
              FROM simulation_report_llm_runs report_run
              WHERE report_run.simulation_id = simulations.id
            ) linked_run
            JOIN llm_runs llm_run
              ON llm_run.id = linked_run.llm_run_id
            WHERE llm_run.status IN ('pending', 'streaming', 'cancel_requested')
          )
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
        UNION ALL
        SELECT
          report_run.simulation_id,
          llm_run.id AS llm_run_id,
          llm_run.phase,
          llm_run.runtime_stream_key,
          llm_run.status
        FROM simulation_report_llm_runs report_run
        JOIN llm_runs llm_run
          ON llm_run.id = report_run.llm_run_id
        WHERE report_run.simulation_id = $1
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
      UNION ALL
      SELECT
        report_run.simulation_id,
        llm_run.id AS llm_run_id,
        llm_run.phase,
        llm_run.runtime_stream_key,
        llm_run.status
      FROM simulation_report_llm_runs report_run
      JOIN llm_runs llm_run
        ON llm_run.id = report_run.llm_run_id
      WHERE report_run.simulation_id = $1
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
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, NULL::text AS report, NULL::boolean AS outdated, run.opening_hand_is_valid",
    orderBy: "run.attempt_number ASC",
  })
  await attachOpeningHandEvaluations(openingHandRuns)
  const turnRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_turn_llm_runs",
    selectColumns:
      "run.attempt_number, run.turn_number, run.game_state, NULL::text AS report, run.outdated, NULL::boolean AS opening_hand_is_valid",
    orderBy: "run.turn_number ASC, run.attempt_number ASC",
  })
  await attachTurnEvaluations(turnRuns)
  const reportRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_report_llm_runs",
    selectColumns:
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, run.report, run.outdated, NULL::boolean AS opening_hand_is_valid",
    orderBy: "run.attempt_number ASC",
  })

  return {
    simulationId,
    openingHandLlmRunCount: openingHandRuns.length,
    turnLlmRunCount: turnRuns.length,
    reportLlmRunCount: reportRuns.length,
    openingHandLlmRuns: openingHandRuns,
    turnLlmRuns: turnRuns,
    reportLlmRuns: reportRuns,
  }
}

export async function getSimulationLlmRunFullPrompt(
  deckId: string,
  simulationId: string,
  llmRunId: string
) {
  const result = await queryDatabase<{ full_prompt: string }>(
    `
      SELECT llm_run.full_prompt
      FROM simulations simulation
      JOIN (
        SELECT simulation_id, llm_run_id
        FROM simulation_opening_hand_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_turn_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_report_llm_runs
      ) linked_run
        ON linked_run.simulation_id = simulation.id
      JOIN llm_runs llm_run
        ON llm_run.id = linked_run.llm_run_id
      WHERE simulation.id = $1
        AND simulation.deck_id = $2
        AND linked_run.llm_run_id = $3
      LIMIT 1
    `,
    [simulationId, deckId, llmRunId]
  )

  return result.rows[0]?.full_prompt ?? null
}

export async function getOpeningHandLlmRunEvaluationData(
  deckId: string,
  simulationId: string,
  llmRunId: string
) {
  const runResult = await queryDatabase<{
    llm_run_id: string
    full_prompt: string
    phase: LlmRunPhase
    status: LlmRunStatus
    attempt_number: number
    opening_hand_is_valid: boolean
  }>(
    `
      SELECT
        llm_run.id AS llm_run_id,
        llm_run.full_prompt,
        llm_run.phase,
        llm_run.status,
        opening_run.attempt_number,
        opening_run.opening_hand_is_valid
      FROM simulations simulation
      JOIN simulation_opening_hand_llm_runs opening_run
        ON opening_run.simulation_id = simulation.id
      JOIN llm_runs llm_run
        ON llm_run.id = opening_run.llm_run_id
      WHERE simulation.id = $1
        AND simulation.deck_id = $2
        AND opening_run.llm_run_id = $3
      LIMIT 1
    `,
    [simulationId, deckId, llmRunId]
  )
  const run = runResult.rows[0]

  if (!run) {
    throw new SimulationValidationError("Opening-hand LLM run not found.")
  }

  const chunks = await getLlmRunEvaluationChunks(llmRunId)

  return {
    llmRunId: run.llm_run_id,
    fullPrompt: run.full_prompt,
    phase: run.phase,
    status: run.status,
    attemptNumber: run.attempt_number,
    openingHandIsValid: run.opening_hand_is_valid,
    chunks,
  }
}

export async function getTurnLlmRunEvaluationData(
  deckId: string,
  simulationId: string,
  llmRunId: string
) {
  const runResult = await queryDatabase<{
    llm_run_id: string
    full_prompt: string
    phase: LlmRunPhase
    status: LlmRunStatus
    turn_number: number
  }>(
    `
      SELECT
        llm_run.id AS llm_run_id,
        llm_run.full_prompt,
        llm_run.phase,
        llm_run.status,
        turn_run.turn_number
      FROM simulations simulation
      JOIN simulation_turn_llm_runs turn_run
        ON turn_run.simulation_id = simulation.id
      JOIN llm_runs llm_run
        ON llm_run.id = turn_run.llm_run_id
      WHERE simulation.id = $1
        AND simulation.deck_id = $2
        AND turn_run.llm_run_id = $3
      LIMIT 1
    `,
    [simulationId, deckId, llmRunId]
  )
  const run = runResult.rows[0]

  if (!run) {
    throw new SimulationValidationError("Turn LLM run not found.")
  }

  const chunks = await getLlmRunEvaluationChunks(llmRunId)

  return {
    llmRunId: run.llm_run_id,
    fullPrompt: run.full_prompt,
    phase: run.phase,
    status: run.status,
    turnNumber: run.turn_number,
    chunks,
  }
}

async function getLlmRunEvaluationChunks(llmRunId: string) {
  const chunksResult = await queryDatabase<{
    id: string
    sequence: number
    kind: LlmChunkKind
    mcp_function_name: string | null
    mcp_function_output: unknown | null
    mcp_function_reason: string | null
    reasoning_delta: string | null
    output_delta: string | null
    payload: unknown
    received_at: Date
  }>(
    `
      SELECT
        id,
        sequence,
        kind,
        mcp_function_name,
        mcp_function_output,
        mcp_function_reason,
        reasoning_delta,
        output_delta,
        payload,
        received_at
      FROM llm_run_chunks
      WHERE llm_run_id = $1
        AND (
          COALESCE(array_length($2::llm_chunk_kind[], 1), 0) = 0
          OR kind <> ALL($2::llm_chunk_kind[])
        )
      ORDER BY sequence ASC
    `,
    [llmRunId, SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS]
  )
  const chunks: SimulationDebugLlmRunChunk[] = chunksResult.rows.map((row) => ({
    id: Number(row.id),
    sequence: row.sequence,
    kind: row.kind,
    mcpFunctionName: row.mcp_function_name,
    mcpFunctionOutput: row.mcp_function_output,
    mcpFunctionReason: row.mcp_function_reason,
    reasoningDelta: row.reasoning_delta,
    outputDelta: row.output_delta,
    payload: row.payload,
    cardMentions: [],
    receivedAt: row.received_at.toISOString(),
  }))
  const cardMentionsByChunkId = await getCardMentionsByLlmRunChunkIds(
    chunks.map((chunk) => chunk.id)
  )

  for (const chunk of chunks) {
    chunk.cardMentions = cardMentionsByChunkId.get(chunk.id) ?? []
  }

  return chunks
}

export async function upsertOpeningHandEvaluation({
  evaluationJson,
  legalSimulationPass,
  llmModelPresetId,
  openingHandLlmRunId,
  reasoningPass,
  simulationId,
  simulationQualityScore,
}: {
  simulationId: string
  openingHandLlmRunId: string
  llmModelPresetId: string
  legalSimulationPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  evaluationJson: OpeningHandEvaluationJson
}) {
  const result = await queryDatabase<OpeningHandEvaluationRow>(
    OPENING_HAND_EVALUATION_UPSERT_SQL,
    [
      simulationId,
      openingHandLlmRunId,
      llmModelPresetId,
      legalSimulationPass,
      reasoningPass,
      simulationQualityScore,
      JSON.stringify(evaluationJson),
    ]
  )

  return mapOpeningHandEvaluationRow(result.rows[0])
}

export async function upsertTurnEvaluation({
  evaluationJson,
  legalTurnPass,
  llmModelPresetId,
  reasoningPass,
  simulationId,
  simulationQualityScore,
  turnLlmRunId,
}: {
  simulationId: string
  turnLlmRunId: string
  llmModelPresetId: string
  legalTurnPass: boolean
  reasoningPass: boolean
  simulationQualityScore: number
  evaluationJson: TurnEvaluationJson
}) {
  const result = await queryDatabase<TurnEvaluationRow>(
    TURN_EVALUATION_UPSERT_SQL,
    [
      simulationId,
      turnLlmRunId,
      llmModelPresetId,
      legalTurnPass,
      reasoningPass,
      simulationQualityScore,
      JSON.stringify(evaluationJson),
    ]
  )

  return mapTurnEvaluationRow(result.rows[0])
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
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, NULL::text AS report, NULL::boolean AS outdated, run.opening_hand_is_valid",
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
  await attachOpeningHandEvaluations(openingHandRuns)
  const turnRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_turn_llm_runs",
    selectColumns:
      "run.attempt_number, run.turn_number, run.game_state, NULL::text AS report, run.outdated, NULL::boolean AS opening_hand_is_valid",
    orderBy: "run.turn_number ASC, run.attempt_number ASC",
    excludeChunkKinds: SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
    additionalWhereSql: "run.outdated = false",
  })
  await attachTurnEvaluations(turnRuns)
  const reportRuns = await getSimulationDebugLlmRuns({
    simulationId,
    tableName: "simulation_report_llm_runs",
    selectColumns:
      "run.attempt_number, NULL::integer AS turn_number, NULL::text AS game_state, run.report, run.outdated, NULL::boolean AS opening_hand_is_valid",
    orderBy: "run.attempt_number ASC",
    excludeChunkKinds: SIMULATION_RESULTS_EXCLUDED_CHUNK_KINDS,
    additionalWhereSql: "run.outdated = false",
  })

  return {
    simulationId,
    openingHandLlmRunCount: openingHandRuns.length,
    turnLlmRunCount: turnRuns.length,
    reportLlmRunCount: reportRuns.length,
    openingHandLlmRuns: openingHandRuns,
    turnLlmRuns: turnRuns,
    reportLlmRuns: reportRuns,
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
        UNION
        SELECT llm_run_id
        FROM simulation_report_llm_runs
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
      UNION ALL
      SELECT
        report_run.simulation_id,
        llm_run.status,
        report_run.outdated
      FROM llm_runs llm_run
      JOIN simulation_report_llm_runs report_run
        ON report_run.llm_run_id = llm_run.id
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
        deck.mulligan_guidelines AS deck_mulligan_guidelines,
        deck.strategy_guidelines AS deck_strategy_guidelines,
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
      JOIN decks deck
        ON deck.id = simulation.deck_id
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
    mulliganGuidelines: firstRow.deck_mulligan_guidelines ?? null,
    commanders: cards.filter((card) => card.zone === "commander"),
    library: cards.filter((card) => card.zone === "library"),
  }
}

export async function getDeckCardReferenceData(
  deckId: string
): Promise<DeckCardReferenceData | null> {
  const result = await queryDatabase<DeckCardReferenceRow>(
    `
      SELECT
        deck.id AS deck_id,
        deck.name AS deck_name,
        deck.description AS deck_description,
        deck.mulligan_guidelines AS deck_mulligan_guidelines,
        deck.strategy_guidelines AS deck_strategy_guidelines,
        deck.format AS deck_format,
        deck.created_at AS deck_created_at,
        deck.updated_at AS deck_updated_at,
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
      FROM decks deck
      JOIN deck_cards deck_card
        ON deck_card.deck_id = deck.id
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE deck.id = $1
      ORDER BY
        CASE deck_card.zone
          WHEN 'commander' THEN 0
          ELSE 1
        END,
        card.name ASC
    `,
    [deckId]
  )

  const firstRow = result.rows[0]

  if (!firstRow) {
    return null
  }

  const cards = result.rows.map(mapSimulationPromptCard)

  return {
    deckId: firstRow.deck_id,
    name: firstRow.deck_name,
    description: firstRow.deck_description,
    mulliganGuidelines: firstRow.deck_mulligan_guidelines,
    strategyGuidelines: firstRow.deck_strategy_guidelines,
    format: firstRow.deck_format,
    createdAt: firstRow.deck_created_at.toISOString(),
    updatedAt: firstRow.deck_updated_at.toISOString(),
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
    strategy_guidelines: string | null
    starting_hand_id: string | null
    library: unknown
  }>(
    `
      SELECT
        simulation.id AS simulation_id,
        simulation.deck_id,
        deck.strategy_guidelines,
        simulation.starting_hand_id,
        simulation.library
      FROM simulations simulation
      JOIN decks deck
        ON deck.id = simulation.deck_id
      WHERE simulation.id = $1
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
    strategyGuidelines: simulation.strategy_guidelines,
    commanders: cards.filter((card) => card.zone === "commander"),
    libraryCards: cards.filter((card) => card.zone === "library"),
    library: parseStringArray(simulation.library),
    startingHand: await getTurnSimulationStartingHand({
      simulationId,
      startingHandId: simulation.starting_hand_id,
    }),
  }
}

export async function getSimulationReportPromptData(
  deckId: string,
  simulationId: string
): Promise<SimulationReportPromptData> {
  const simulation = await getSimulationSummary(deckId, simulationId)

  if (!simulation) {
    throw new SimulationValidationError("Simulation not found.")
  }

  const resultsInfo = await getSimulationResultsInfo(deckId, simulationId)
  const openingHand = await getReportOpeningHandPromptData(
    simulation,
    resultsInfo
  )
  const turns = await getReportTurnPromptData(resultsInfo.turnLlmRuns)

  return {
    simulationId,
    deckId,
    seed: simulation.seed,
    turnsToSimulate: simulation.turnsToSimulate,
    startingHand: openingHand.startingHand,
    openingHandSummary: openingHand.summary,
    turns,
  }
}

async function getReportOpeningHandPromptData(
  simulation: SimulationSummary,
  resultsInfo: SimulationResultsInfo
) {
  if (simulation.startingHandId !== null) {
    return {
      startingHand: await getTurnSimulationStartingHand({
        simulationId: simulation.id,
        startingHandId: simulation.startingHandId,
      }),
      summary: null,
    }
  }

  const latestOpeningHandRun =
    resultsInfo.openingHandLlmRuns.reduce<SimulationDebugLlmRun | null>(
      (latestRun, run) => {
        if (!latestRun || run.attemptNumber > latestRun.attemptNumber) {
          return run
        }

        return latestRun
      },
      null
    )

  if (!latestOpeningHandRun) {
    throw new SimulationValidationError(
      "No opening-hand LLM run exists for this simulation."
    )
  }

  if (latestOpeningHandRun.status !== "completed") {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run is not complete."
    )
  }

  if (latestOpeningHandRun.openingHandIsValid !== true) {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run does not have a valid starting hand."
    )
  }

  const finalOutput = getOpeningHandFinalOutput(latestOpeningHandRun)

  if (!finalOutput) {
    throw new SimulationValidationError(
      "The most recent opening-hand LLM run is missing its final kept hand and summary."
    )
  }

  return {
    startingHand: finalOutput.keptHand,
    summary: finalOutput.summary,
  }
}

async function getReportTurnPromptData(
  turnRuns: readonly SimulationDebugLlmRun[]
): Promise<SimulationReportTurnPromptData[]> {
  const sortedTurnRuns = [...turnRuns].sort(
    (firstRun, secondRun) =>
      (firstRun.turnNumber ?? 0) - (secondRun.turnNumber ?? 0) ||
      firstRun.attemptNumber - secondRun.attemptNumber
  )
  const seenTurnNumbers = new Set<number>()

  for (const run of sortedTurnRuns) {
    if (run.status !== "completed") {
      throw new SimulationValidationError(
        `The current turn ${run.turnNumber ?? "?"} LLM run is not complete.`
      )
    }

    if (run.outdated) {
      throw new SimulationValidationError(
        `The current turn ${run.turnNumber ?? "?"} LLM run is outdated.`
      )
    }

    if (typeof run.turnNumber !== "number") {
      throw new SimulationValidationError(
        "A current turn LLM run is missing its turn number."
      )
    }

    if (seenTurnNumbers.has(run.turnNumber)) {
      throw new SimulationValidationError(
        `Multiple current turn ${run.turnNumber} LLM runs exist.`
      )
    }

    seenTurnNumbers.add(run.turnNumber)
  }

  for (
    let turnNumber = 1;
    turnNumber <= sortedTurnRuns.length;
    turnNumber += 1
  ) {
    const run = sortedTurnRuns[turnNumber - 1]

    if (run && run.turnNumber !== turnNumber) {
      throw new SimulationValidationError(
        `Turn ${turnNumber} has not been simulated.`
      )
    }
  }

  const loggedActionsByRunId = await getTurnActionsByLlmRunIds(
    sortedTurnRuns.map((run) => run.llmRunId)
  )

  return sortedTurnRuns.map((run) => {
    const finalOutput = getTurnFinalOutput(run)
    const loggedActions = loggedActionsByRunId.get(run.llmRunId) ?? []

    if (!finalOutput) {
      throw new SimulationValidationError(
        `The current turn ${run.turnNumber} LLM run is missing its final summary and game state.`
      )
    }

    if (!run.gameState?.trim() || !finalOutput.gameState.trim()) {
      throw new SimulationValidationError(
        `The current turn ${run.turnNumber} LLM run is missing its game state.`
      )
    }

    if (loggedActions.length === 0) {
      throw new SimulationValidationError(
        `The current turn ${run.turnNumber} LLM run has no logged actions.`
      )
    }

    return {
      turnNumber: run.turnNumber as number,
      summary: finalOutput.summary,
      gameState: finalOutput.gameState,
      loggedActions,
    }
  })
}

async function getTurnActionsByLlmRunIds(llmRunIds: readonly string[]) {
  const actionsByRunId = new Map<string, string[]>()

  if (llmRunIds.length === 0) {
    return actionsByRunId
  }

  const result = await queryDatabase<{
    turn_llm_run_id: string
    action: string
  }>(
    `
      SELECT
        turn_llm_run_id,
        action
      FROM simulation_turn_actions
      WHERE turn_llm_run_id = ANY($1::uuid[])
      ORDER BY turn_llm_run_id ASC, sequence ASC
    `,
    [llmRunIds]
  )

  for (const row of result.rows) {
    const actions = actionsByRunId.get(row.turn_llm_run_id) ?? []
    actions.push(row.action)
    actionsByRunId.set(row.turn_llm_run_id, actions)
  }

  return actionsByRunId
}

function getOpeningHandFinalOutput(run: SimulationDebugLlmRun) {
  const payload = getFinalParsedOutputPayload(run)
  const keptHand = asStringArray(payload.keptHand)
  const summary = getRequiredString(payload.summary)

  if (!keptHand || !summary) {
    return null
  }

  return {
    keptHand,
    summary,
  }
}

function getTurnFinalOutput(run: SimulationDebugLlmRun) {
  const payload = getFinalParsedOutputPayload(run)
  const gameState = getRequiredString(payload.gameState)
  const summary = getRequiredString(payload.summary)

  if (!gameState || !summary) {
    return null
  }

  return {
    gameState,
    summary,
  }
}

function getFinalParsedOutputPayload(run: SimulationDebugLlmRun) {
  const finalParsedOutputChunk = [...run.chunks]
    .reverse()
    .find((chunk) => chunk.kind === "final_parsed_output")

  return asRecord(finalParsedOutputChunk?.payload)
}

type SimulationDebugLlmRunRow = {
  llm_run_id: string
  llm_model_preset_id: string | null
  phase: LlmRunPhase
  provider: string
  model: string
  estimated_cost_usd: string | number | null
  openrouter_reported_cost_usd: string | number | null
  reasoning_effort: string | null
  status: LlmRunStatus
  runtime_stream_key: string | null
  failure_message: string | null
  created_at: Date
  started_at: Date | null
  completed_at: Date | null
  failed_at: Date | null
  cancelled_at: Date | null
  attempt_number: number
  turn_number: number | null
  game_state: string | null
  report: string | null
  outdated: boolean | null
  opening_hand_is_valid: boolean | null
  chunk_id: string | null
  sequence: number | null
  kind: LlmChunkKind | null
  mcp_function_name: string | null
  mcp_function_output: unknown | null
  mcp_function_reason: string | null
  reasoning_delta: string | null
  output_delta: string | null
  payload: unknown
  received_at: Date | null
}

type OpenRouterGenerationRow = {
  llm_run_id: string
  openrouter_turn_index: number
  generation_id: string
  created_at: Date
}

type OpeningHandEvaluationRow = {
  id: string
  simulation_id: string
  opening_hand_llm_run_id: string
  llm_model_preset_id: string | null
  llm_model_preset_provider: LlmProvider | null
  llm_model_preset_model: string | null
  llm_model_preset_reasoning_effort: ReasoningEffort | null
  llm_model_preset_openrouter_model_provider: string | null
  llm_model_preset_is_enabled: boolean | null
  legal_simulation_pass: boolean
  reasoning_pass: boolean
  simulation_quality_score: number
  evaluation_json: unknown
  created_at: Date
  updated_at: Date
}

type TurnEvaluationRow = {
  id: string
  simulation_id: string
  turn_llm_run_id: string
  llm_model_preset_id: string | null
  llm_model_preset_provider: LlmProvider | null
  llm_model_preset_model: string | null
  llm_model_preset_reasoning_effort: ReasoningEffort | null
  llm_model_preset_openrouter_model_provider: string | null
  llm_model_preset_is_enabled: boolean | null
  legal_turn_pass: boolean
  reasoning_pass: boolean
  simulation_quality_score: number
  evaluation_json: unknown
  created_at: Date
  updated_at: Date
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
  tableName:
    | "simulation_opening_hand_llm_runs"
    | "simulation_turn_llm_runs"
    | "simulation_report_llm_runs"
  selectColumns: string
  orderBy: string
  excludeChunkKinds?: readonly LlmChunkKind[]
  additionalWhereSql?: string
}): Promise<SimulationDebugLlmRun[]> {
  const result = await queryDatabase<SimulationDebugLlmRunRow>(
    `
      SELECT
        llm_run.id AS llm_run_id,
        llm_run.llm_model_preset_id,
        llm_run.phase,
        COALESCE(preset.provider, llm_run.provider) AS provider,
        COALESCE(preset.model, llm_run.model) AS model,
        llm_run.estimated_cost_usd,
        llm_run.openrouter_reported_cost_usd,
        COALESCE(preset.reasoning_effort, llm_run.reasoning_effort) AS reasoning_effort,
        llm_run.status,
        llm_run.runtime_stream_key,
        llm_run.failure_message,
        llm_run.created_at,
        llm_run.started_at,
        llm_run.completed_at,
        llm_run.failed_at,
        llm_run.cancelled_at,
        ${selectColumns},
        chunk.id AS chunk_id,
        chunk.sequence,
        chunk.kind,
        chunk.mcp_function_name,
        chunk.mcp_function_output,
        chunk.mcp_function_reason,
        chunk.reasoning_delta,
        chunk.output_delta,
        chunk.payload,
        chunk.received_at
      FROM ${tableName} run
      JOIN llm_runs llm_run
        ON llm_run.id = run.llm_run_id
      LEFT JOIN llm_model_presets preset
        ON preset.id = llm_run.llm_model_preset_id
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
        llmModelPresetId: row.llm_model_preset_id,
        phase: row.phase,
        provider: row.provider,
        model: row.model,
        estimatedPriceCents: formatPreferredLlmRunCostAsCents({
          estimatedCostUsd: toOptionalNumber(row.estimated_cost_usd),
          openrouterReportedCostUsd: toOptionalNumber(
            row.openrouter_reported_cost_usd
          ),
        }),
        reasoningEffort: row.reasoning_effort || null,
        status: row.status,
        runtimeStreamKey: row.runtime_stream_key,
        attemptNumber: row.attempt_number,
        failureMessage: row.failure_message,
        createdAt: row.created_at.toISOString(),
        startedAt: row.started_at?.toISOString() ?? null,
        completedAt: row.completed_at?.toISOString() ?? null,
        failedAt: row.failed_at?.toISOString() ?? null,
        cancelledAt: row.cancelled_at?.toISOString() ?? null,
        openrouterGenerations: [],
        chunks: [],
      }

      if (row.turn_number !== null) {
        run.turnNumber = row.turn_number
      }

      if (row.game_state !== null) {
        run.gameState = row.game_state
      }

      if (row.report !== null) {
        run.report = row.report
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
        mcpFunctionName: row.mcp_function_name,
        mcpFunctionOutput: row.mcp_function_output,
        mcpFunctionReason: row.mcp_function_reason,
        reasoningDelta: row.reasoning_delta,
        outputDelta: row.output_delta,
        payload: row.payload,
        cardMentions: [],
        receivedAt: row.received_at?.toISOString() ?? "",
      })
    }
  }

  const runs = Array.from(runsById.values())
  const cardMentionsByChunkId = await getCardMentionsByLlmRunChunkIds(
    runs.flatMap((run) => run.chunks.map((chunk) => chunk.id))
  )

  for (const run of runs) {
    for (const chunk of run.chunks) {
      chunk.cardMentions = cardMentionsByChunkId.get(chunk.id) ?? []
    }
  }

  const openRouterGenerationsByRunId =
    await getOpenRouterGenerationsByLlmRunIds(
      runs
        .filter((run) => run.provider === "openrouter")
        .map((run) => run.llmRunId)
    )

  for (const run of runs) {
    run.openrouterGenerations =
      openRouterGenerationsByRunId.get(run.llmRunId) ?? []
  }

  return runs
}

async function attachOpeningHandEvaluations(runs: SimulationDebugLlmRun[]) {
  const evaluationsByRunId = await getOpeningHandEvaluationsByLlmRunIds(
    runs.map((run) => run.llmRunId)
  )

  for (const run of runs) {
    run.openingHandEvaluation = evaluationsByRunId.get(run.llmRunId) ?? null
  }
}

async function getOpeningHandEvaluationsByLlmRunIds(
  llmRunIds: readonly string[]
) {
  const evaluationsByRunId = new Map<string, OpeningHandEvaluation>()

  if (llmRunIds.length === 0) {
    return evaluationsByRunId
  }

  const result = await queryDatabase<OpeningHandEvaluationRow>(
    `
      SELECT
        evaluation.id,
        evaluation.simulation_id,
        evaluation.opening_hand_llm_run_id,
        evaluation.llm_model_preset_id,
        preset.provider AS llm_model_preset_provider,
        preset.model AS llm_model_preset_model,
        preset.reasoning_effort AS llm_model_preset_reasoning_effort,
        preset.openrouter_model_provider AS llm_model_preset_openrouter_model_provider,
        preset.is_enabled AS llm_model_preset_is_enabled,
        evaluation.legal_simulation_pass,
        evaluation.reasoning_pass,
        evaluation.simulation_quality_score::float8 AS simulation_quality_score,
        evaluation.evaluation_json,
        evaluation.created_at,
        evaluation.updated_at
      FROM simulation_opening_hand_evaluations evaluation
      LEFT JOIN llm_model_presets preset
        ON preset.id = evaluation.llm_model_preset_id
      WHERE evaluation.opening_hand_llm_run_id = ANY($1::uuid[])
      ORDER BY evaluation.opening_hand_llm_run_id ASC
    `,
    [llmRunIds]
  )

  for (const row of result.rows) {
    evaluationsByRunId.set(
      row.opening_hand_llm_run_id,
      mapOpeningHandEvaluationRow(row)
    )
  }

  return evaluationsByRunId
}

function mapOpeningHandEvaluationRow(
  row: OpeningHandEvaluationRow
): OpeningHandEvaluation {
  return {
    id: Number(row.id),
    simulationId: row.simulation_id,
    openingHandLlmRunId: row.opening_hand_llm_run_id,
    llmModelPresetId: row.llm_model_preset_id,
    llmModelPreset: mapEvaluationLlmModelPresetRow(row),
    legalSimulationPass: row.legal_simulation_pass,
    reasoningPass: row.reasoning_pass,
    simulationQualityScore: Number(row.simulation_quality_score),
    evaluationJson: row.evaluation_json as OpeningHandEvaluationJson,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

async function getCardMentionsByLlmRunChunkIds(chunkIds: readonly number[]) {
  const cardMentionsByChunkId = new Map<
    number,
    SimulationDebugLlmRunChunkCardMention[]
  >()

  if (chunkIds.length === 0) {
    return cardMentionsByChunkId
  }

  const result = await queryDatabase<{
    llm_run_chunk_id: string
    requested_name: string
    resolution_status: LlmRunChunkCardMentionResolutionStatus
    resolved_name: string | null
    scryfall_uri: string | null
    default_image_url: string | null
  }>(
    `
      SELECT
        mention.llm_run_chunk_id,
        mention.requested_name,
        mention.resolution_status,
        mention.resolved_name,
        card.scryfall_uri,
        mention.default_image_url
      FROM llm_run_chunk_card_mentions mention
      LEFT JOIN scryfall_oracle_cards card
        ON card.oracle_id = mention.oracle_id
      WHERE mention.llm_run_chunk_id = ANY($1::bigint[])
      ORDER BY mention.llm_run_chunk_id ASC, mention.position ASC, mention.source_path ASC, mention.id ASC
    `,
    [chunkIds]
  )

  for (const row of result.rows) {
    const chunkId = Number(row.llm_run_chunk_id)
    const cardMentions = cardMentionsByChunkId.get(chunkId) ?? []

    cardMentions.push({
      requestedName: row.requested_name,
      resolutionStatus: row.resolution_status,
      resolvedName: row.resolved_name,
      scryfallUri: row.scryfall_uri,
      defaultImageUrl: row.default_image_url,
    })
    cardMentionsByChunkId.set(chunkId, cardMentions)
  }

  return cardMentionsByChunkId
}

async function getOpenRouterGenerationsByLlmRunIds(
  llmRunIds: readonly string[]
) {
  const generationsByRunId = new Map<string, OpenRouterGeneration[]>()

  if (llmRunIds.length === 0) {
    return generationsByRunId
  }

  const result = await queryDatabase<OpenRouterGenerationRow>(
    `
      SELECT
        llm_run_id,
        openrouter_turn_index,
        generation_id,
        created_at
      FROM llm_run_openrouter_generations
      WHERE llm_run_id = ANY($1::uuid[])
      ORDER BY llm_run_id ASC, openrouter_turn_index ASC
    `,
    [llmRunIds]
  )

  for (const row of result.rows) {
    const generations = generationsByRunId.get(row.llm_run_id) ?? []

    generations.push({
      openrouterTurnIndex: row.openrouter_turn_index,
      generationId: row.generation_id,
      createdAt: row.created_at.toISOString(),
    })
    generationsByRunId.set(row.llm_run_id, generations)
  }

  return generationsByRunId
}

async function attachTurnEvaluations(runs: SimulationDebugLlmRun[]) {
  const evaluationsByRunId = await getTurnEvaluationsByLlmRunIds(
    runs.map((run) => run.llmRunId)
  )

  for (const run of runs) {
    run.turnEvaluation = evaluationsByRunId.get(run.llmRunId) ?? null
  }
}

async function getTurnEvaluationsByLlmRunIds(llmRunIds: readonly string[]) {
  const evaluationsByRunId = new Map<string, TurnEvaluation>()

  if (llmRunIds.length === 0) {
    return evaluationsByRunId
  }

  const result = await queryDatabase<TurnEvaluationRow>(
    `
      SELECT
        evaluation.id,
        evaluation.simulation_id,
        evaluation.turn_llm_run_id,
        evaluation.llm_model_preset_id,
        preset.provider AS llm_model_preset_provider,
        preset.model AS llm_model_preset_model,
        preset.reasoning_effort AS llm_model_preset_reasoning_effort,
        preset.openrouter_model_provider AS llm_model_preset_openrouter_model_provider,
        preset.is_enabled AS llm_model_preset_is_enabled,
        evaluation.legal_turn_pass,
        evaluation.reasoning_pass,
        evaluation.simulation_quality_score::float8 AS simulation_quality_score,
        evaluation.evaluation_json,
        evaluation.created_at,
        evaluation.updated_at
      FROM simulation_turn_evaluations evaluation
      LEFT JOIN llm_model_presets preset
        ON preset.id = evaluation.llm_model_preset_id
      WHERE evaluation.turn_llm_run_id = ANY($1::uuid[])
      ORDER BY evaluation.turn_llm_run_id ASC
    `,
    [llmRunIds]
  )

  for (const row of result.rows) {
    evaluationsByRunId.set(row.turn_llm_run_id, mapTurnEvaluationRow(row))
  }

  return evaluationsByRunId
}

function mapTurnEvaluationRow(row: TurnEvaluationRow): TurnEvaluation {
  return {
    id: Number(row.id),
    simulationId: row.simulation_id,
    turnLlmRunId: row.turn_llm_run_id,
    llmModelPresetId: row.llm_model_preset_id,
    llmModelPreset: mapEvaluationLlmModelPresetRow(row),
    legalTurnPass: row.legal_turn_pass,
    reasoningPass: row.reasoning_pass,
    simulationQualityScore: Number(row.simulation_quality_score),
    evaluationJson: row.evaluation_json as TurnEvaluationJson,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function mapEvaluationLlmModelPresetRow(
  row: Pick<
    OpeningHandEvaluationRow | TurnEvaluationRow,
    | "llm_model_preset_id"
    | "llm_model_preset_provider"
    | "llm_model_preset_model"
    | "llm_model_preset_reasoning_effort"
    | "llm_model_preset_openrouter_model_provider"
    | "llm_model_preset_is_enabled"
  >
): EvaluationLlmModelPreset | null {
  if (
    !row.llm_model_preset_id ||
    !row.llm_model_preset_provider ||
    !row.llm_model_preset_model ||
    !row.llm_model_preset_reasoning_effort ||
    row.llm_model_preset_is_enabled === null
  ) {
    return null
  }

  return {
    id: row.llm_model_preset_id,
    provider: row.llm_model_preset_provider,
    model: row.llm_model_preset_model,
    reasoningEffort: row.llm_model_preset_reasoning_effort,
    openrouterModelProvider: row.llm_model_preset_openrouter_model_provider,
    isEnabled: row.llm_model_preset_is_enabled,
  }
}

type PromptCardRow = {
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

type SimulationPromptCardRow = PromptCardRow & {
  simulation_id: string
  deck_id: string
  deck_mulligan_guidelines?: string | null
  deck_strategy_guidelines?: string | null
}

type DeckCardReferenceRow = PromptCardRow & {
  deck_id: string
  deck_name: string
  deck_description: string | null
  deck_mulligan_guidelines: string | null
  deck_strategy_guidelines: string | null
  deck_format: string
  deck_created_at: Date
  deck_updated_at: Date
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

async function markSimulationReportRunsOutdatedWithClient(
  client: DatabaseTransactionClient,
  simulationId: string
) {
  await client.query(
    `
      UPDATE simulation_report_llm_runs
      SET outdated = true
      WHERE simulation_id = $1
        AND outdated = false
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
        UNION ALL
        SELECT llm_run.id
        FROM simulation_report_llm_runs report_run
        JOIN llm_runs llm_run
          ON llm_run.id = report_run.llm_run_id
        WHERE report_run.simulation_id = $1
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

function mapSimulationPromptCard(row: PromptCardRow): SimulationPromptCard {
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

function getRequiredString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function asStringArray(value: unknown) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null
  }

  return value
}

function parseStringArray(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return value.filter((item): item is string => typeof item === "string")
}

function getPersistableOpenRouterModelProvider(input: {
  provider: string
  openrouterModelProvider: string | null
}) {
  if (input.provider !== "openrouter") {
    return null
  }

  return input.openrouterModelProvider?.trim() || null
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

function toOptionalNumber(value: string | number | null) {
  if (value === null) {
    return null
  }

  const parsedValue = Number(value)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

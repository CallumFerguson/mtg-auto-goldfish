import { queryDatabase, withDatabaseTransaction } from "./db.js"
import {
  llmProviderSchema,
  reasoningEffortSchema,
  type LlmProvider,
  type ReasoningEffort,
} from "./llm-config.js"

export type LlmModelPreset = {
  id: string
  provider: LlmProvider
  model: string
  reasoningEffort: ReasoningEffort
  openrouterModelProvider: string | null
  inputTokenCostUsdPerMillion: number | null
  cachedInputTokenCostUsdPerMillion: number | null
  outputTokenCostUsdPerMillion: number | null
  isEnabled: boolean
  isDefault: boolean
  createdAt: string
  updatedAt: string
}

export type AdminLlmModelPreset = LlmModelPreset & {
  simulationReferenceCount: number
  llmRunReferenceCount: number
  evaluationReferenceCount: number
  canDelete: boolean
}

export type CreateLlmModelPresetInput = {
  provider: LlmProvider
  model: string
  reasoningEffort: ReasoningEffort
  openrouterModelProvider: string | null
  inputTokenCostUsdPerMillion: number | null
  cachedInputTokenCostUsdPerMillion: number | null
  outputTokenCostUsdPerMillion: number | null
  isEnabled: boolean
  isDefault: boolean
}

type LlmModelPresetRow = {
  id: string
  provider: LlmProvider
  model: string
  reasoning_effort: ReasoningEffort
  openrouter_model_provider: string | null
  input_token_cost_usd_per_million: string | number | null
  cached_input_token_cost_usd_per_million: string | number | null
  output_token_cost_usd_per_million: string | number | null
  is_enabled: boolean
  is_default: boolean
  created_at: Date
  updated_at: Date
}

type AdminLlmModelPresetRow = LlmModelPresetRow & {
  simulation_reference_count: string | number
  llm_run_reference_count: string | number
  evaluation_reference_count: string | number
}

export class LlmModelPresetValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmModelPresetValidationError"
  }
}

const PROVIDER_VALUES = llmProviderSchema.options
const REASONING_EFFORT_VALUES = reasoningEffortSchema.options

export async function ensureLlmModelPresetsSchema() {
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_model_presets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      provider text NOT NULL,
      model text NOT NULL,
      reasoning_effort text NOT NULL,
      openrouter_model_provider text,

      input_token_cost_usd_per_million numeric(12,6),
      cached_input_token_cost_usd_per_million numeric(12,6),
      output_token_cost_usd_per_million numeric(12,6),

      is_enabled boolean NOT NULL DEFAULT true,
      is_default boolean NOT NULL DEFAULT false,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS openrouter_model_provider text
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS input_token_cost_usd_per_million numeric(12,6)
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS cached_input_token_cost_usd_per_million numeric(12,6)
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS output_token_cost_usd_per_million numeric(12,6)
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS is_enabled boolean NOT NULL DEFAULT true
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false
  `)
  await ensureLlmModelPresetConstraints()
  await dropLlmModelPresetImmutabilityTrigger()
  await queryDatabase(`
    CREATE UNIQUE INDEX IF NOT EXISTS llm_model_presets_one_default_idx
      ON llm_model_presets ((is_default))
      WHERE is_default
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_model_presets_enabled_default_idx
      ON llm_model_presets (is_enabled, is_default, created_at)
  `)
}

export async function listEnabledLlmModelPresets() {
  const result = await queryDatabase<LlmModelPresetRow>(`
    ${LLM_MODEL_PRESET_SELECT_SQL}
    FROM llm_model_presets
    WHERE is_enabled = true
    ORDER BY is_default DESC, provider ASC, model ASC, reasoning_effort ASC, created_at ASC
  `)

  return result.rows.map(mapLlmModelPresetRow)
}

export async function listAdminLlmModelPresets() {
  const result = await queryDatabase<AdminLlmModelPresetRow>(`
    SELECT
      preset.id,
      preset.provider,
      preset.model,
      preset.reasoning_effort,
      preset.openrouter_model_provider,
      preset.input_token_cost_usd_per_million,
      preset.cached_input_token_cost_usd_per_million,
      preset.output_token_cost_usd_per_million,
      preset.is_enabled,
      preset.is_default,
      preset.created_at,
      preset.updated_at,
      (
        SELECT COUNT(*)::integer
        FROM simulations simulation
        WHERE simulation.llm_model_preset_id = preset.id
      ) AS simulation_reference_count,
      (
        SELECT COUNT(*)::integer
        FROM llm_runs llm_run
        WHERE llm_run.llm_model_preset_id = preset.id
      ) AS llm_run_reference_count,
      (
        SELECT COUNT(*)::integer
        FROM simulation_opening_hand_evaluations opening_evaluation
        WHERE opening_evaluation.llm_model_preset_id = preset.id
      ) + (
        SELECT COUNT(*)::integer
        FROM simulation_turn_evaluations turn_evaluation
        WHERE turn_evaluation.llm_model_preset_id = preset.id
      ) AS evaluation_reference_count
    FROM llm_model_presets preset
    ORDER BY preset.created_at DESC
  `)

  return result.rows.map((row) => {
    const preset = mapLlmModelPresetRow(row)
    const simulationReferenceCount = toInteger(
      row.simulation_reference_count,
      "simulation reference count"
    )
    const llmRunReferenceCount = toInteger(
      row.llm_run_reference_count,
      "LLM run reference count"
    )
    const evaluationReferenceCount = toInteger(
      row.evaluation_reference_count,
      "evaluation reference count"
    )

    return {
      ...preset,
      simulationReferenceCount,
      llmRunReferenceCount,
      evaluationReferenceCount,
      canDelete:
        simulationReferenceCount === 0 &&
        llmRunReferenceCount === 0 &&
        evaluationReferenceCount === 0,
    } satisfies AdminLlmModelPreset
  })
}

export async function getLlmModelPreset(presetId: string) {
  const result = await queryDatabase<LlmModelPresetRow>(
    `
      ${LLM_MODEL_PRESET_SELECT_SQL}
      FROM llm_model_presets
      WHERE id = $1
    `,
    [presetId]
  )

  return result.rows[0] ? mapLlmModelPresetRow(result.rows[0]) : null
}

export async function getEnabledLlmModelPreset(presetId: string) {
  const preset = await getLlmModelPreset(presetId)

  return preset?.isEnabled ? preset : null
}

export async function createLlmModelPreset(input: CreateLlmModelPresetInput) {
  const normalizedInput = validateCreateLlmModelPresetInput(input)

  return withDatabaseTransaction(async (client) => {
    if (normalizedInput.isDefault) {
      await client.query(`
        UPDATE llm_model_presets
        SET is_default = false,
            updated_at = now()
        WHERE is_default = true
      `)
    }

    const result = await client.query<LlmModelPresetRow>(
      `
        INSERT INTO llm_model_presets (
          provider,
          model,
          reasoning_effort,
          openrouter_model_provider,
          input_token_cost_usd_per_million,
          cached_input_token_cost_usd_per_million,
          output_token_cost_usd_per_million,
          is_enabled,
          is_default
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING
          id,
          provider,
          model,
          reasoning_effort,
          openrouter_model_provider,
          input_token_cost_usd_per_million,
          cached_input_token_cost_usd_per_million,
          output_token_cost_usd_per_million,
          is_enabled,
          is_default,
          created_at,
          updated_at
      `,
      [
        normalizedInput.provider,
        normalizedInput.model,
        normalizedInput.reasoningEffort,
        normalizedInput.openrouterModelProvider,
        normalizedInput.inputTokenCostUsdPerMillion,
        normalizedInput.cachedInputTokenCostUsdPerMillion,
        normalizedInput.outputTokenCostUsdPerMillion,
        normalizedInput.isEnabled,
        normalizedInput.isDefault,
      ]
    )

    return mapLlmModelPresetRow(result.rows[0])
  })
}

export async function setLlmModelPresetEnabled(
  presetId: string,
  isEnabled: boolean
) {
  const result = await queryDatabase<LlmModelPresetRow>(
    `
      UPDATE llm_model_presets
      SET is_enabled = $2,
          is_default = CASE WHEN $2 THEN is_default ELSE false END,
          updated_at = now()
      WHERE id = $1
      RETURNING
        id,
        provider,
        model,
        reasoning_effort,
        openrouter_model_provider,
        input_token_cost_usd_per_million,
        cached_input_token_cost_usd_per_million,
        output_token_cost_usd_per_million,
        is_enabled,
        is_default,
        created_at,
        updated_at
    `,
    [presetId, isEnabled]
  )

  return result.rows[0] ? mapLlmModelPresetRow(result.rows[0]) : null
}

export async function setDefaultLlmModelPreset(presetId: string | null) {
  return withDatabaseTransaction(async (client) => {
    if (presetId === null) {
      await client.query(`
        UPDATE llm_model_presets
        SET is_default = false,
            updated_at = now()
        WHERE is_default = true
      `)

      return null
    }

    const targetResult = await client.query<{ id: string }>(
      `
        SELECT id
        FROM llm_model_presets
        WHERE id = $1
          AND is_enabled = true
        FOR UPDATE
      `,
      [presetId]
    )

    if (targetResult.rowCount === 0) {
      throw new LlmModelPresetValidationError(
        "Model preset not found or disabled."
      )
    }

    await client.query(
      `
        UPDATE llm_model_presets
        SET is_default = false,
            updated_at = now()
        WHERE is_default = true
          AND id <> $1
      `,
      [presetId]
    )

    const result = await client.query<LlmModelPresetRow>(
      `
        UPDATE llm_model_presets
        SET is_default = true,
            updated_at = now()
        WHERE id = $1
        RETURNING
          id,
          provider,
          model,
          reasoning_effort,
          openrouter_model_provider,
          input_token_cost_usd_per_million,
          cached_input_token_cost_usd_per_million,
          output_token_cost_usd_per_million,
          is_enabled,
          is_default,
          created_at,
          updated_at
      `,
      [presetId]
    )

    return mapLlmModelPresetRow(result.rows[0])
  })
}

export async function deleteUnusedLlmModelPreset(presetId: string) {
  return withDatabaseTransaction(async (client) => {
    const referenceResult = await client.query<{
      simulation_reference_count: number
      llm_run_reference_count: number
      evaluation_reference_count: number
    }>(
      `
        SELECT
          (
            SELECT COUNT(*)::integer
            FROM simulations
            WHERE llm_model_preset_id = $1
          ) AS simulation_reference_count,
          (
            SELECT COUNT(*)::integer
            FROM llm_runs
            WHERE llm_model_preset_id = $1
          ) AS llm_run_reference_count,
          (
            SELECT COUNT(*)::integer
            FROM simulation_opening_hand_evaluations
            WHERE llm_model_preset_id = $1
          ) + (
            SELECT COUNT(*)::integer
            FROM simulation_turn_evaluations
            WHERE llm_model_preset_id = $1
          ) AS evaluation_reference_count
      `,
      [presetId]
    )
    const references = referenceResult.rows[0]
    const referenceCount =
      references.simulation_reference_count +
      references.llm_run_reference_count +
      references.evaluation_reference_count

    if (referenceCount > 0) {
      throw new LlmModelPresetValidationError(
        "Model preset is referenced and cannot be deleted. Disable it instead."
      )
    }

    const result = await client.query(
      `
        DELETE FROM llm_model_presets
        WHERE id = $1
      `,
      [presetId]
    )

    return (result.rowCount ?? 0) > 0
  })
}

export function getLlmModelPresetLabel(preset: Pick<
  LlmModelPreset,
  "model" | "openrouterModelProvider" | "provider" | "reasoningEffort"
>) {
  return [
    preset.provider,
    preset.model,
    preset.openrouterModelProvider,
    preset.reasoningEffort,
  ]
    .filter(Boolean)
    .join(" / ")
}

const LLM_MODEL_PRESET_SELECT_SQL = `
  SELECT
    id,
    provider,
    model,
    reasoning_effort,
    openrouter_model_provider,
    input_token_cost_usd_per_million,
    cached_input_token_cost_usd_per_million,
    output_token_cost_usd_per_million,
    is_enabled,
    is_default,
    created_at,
    updated_at
`

async function ensureLlmModelPresetConstraints() {
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_provider_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_provider_check
      CHECK (provider IN (${PROVIDER_VALUES.map(quoteSqlLiteral).join(", ")}))
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_reasoning_effort_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_reasoning_effort_check
      CHECK (reasoning_effort IN (${REASONING_EFFORT_VALUES.map(quoteSqlLiteral).join(", ")}))
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_model_not_blank_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_model_not_blank_check
      CHECK (btrim(model) <> '')
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_openrouter_provider_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_openrouter_provider_check
      CHECK (
        (provider = 'openrouter' AND (openrouter_model_provider IS NULL OR btrim(openrouter_model_provider) <> ''))
        OR (provider <> 'openrouter' AND openrouter_model_provider IS NULL)
      )
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_costs_nonnegative_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_costs_nonnegative_check
      CHECK (
        (input_token_cost_usd_per_million IS NULL OR input_token_cost_usd_per_million >= 0)
        AND (cached_input_token_cost_usd_per_million IS NULL OR cached_input_token_cost_usd_per_million >= 0)
        AND (output_token_cost_usd_per_million IS NULL OR output_token_cost_usd_per_million >= 0)
      )
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    DROP CONSTRAINT IF EXISTS llm_model_presets_default_requires_enabled_check
  `)
  await queryDatabase(`
    ALTER TABLE llm_model_presets
    ADD CONSTRAINT llm_model_presets_default_requires_enabled_check
      CHECK (is_default = false OR is_enabled = true)
  `)
}

async function dropLlmModelPresetImmutabilityTrigger() {
  await queryDatabase(`
    DROP TRIGGER IF EXISTS llm_model_presets_immutable_fields_trigger
    ON llm_model_presets
  `)
  await queryDatabase(`
    DROP FUNCTION IF EXISTS prevent_llm_model_preset_immutable_update()
  `)
}

function validateCreateLlmModelPresetInput(
  input: CreateLlmModelPresetInput
): CreateLlmModelPresetInput {
  const parsedProvider = llmProviderSchema.safeParse(input.provider)

  if (!parsedProvider.success) {
    throw new LlmModelPresetValidationError(
      "Provider must be openai, openrouter, or llamacpp."
    )
  }

  const parsedReasoningEffort = reasoningEffortSchema.safeParse(
    input.reasoningEffort
  )

  if (!parsedReasoningEffort.success) {
    throw new LlmModelPresetValidationError(
      "Reasoning effort must be one of: none, minimal, low, medium, high, xhigh."
    )
  }

  const model = input.model.trim()

  if (!model) {
    throw new LlmModelPresetValidationError("Model is required.")
  }

  const openrouterModelProvider = input.openrouterModelProvider?.trim() || null

  if (parsedProvider.data !== "openrouter" && openrouterModelProvider) {
    throw new LlmModelPresetValidationError(
      "OpenRouter model provider can only be set for OpenRouter presets."
    )
  }

  return {
    ...input,
    provider: parsedProvider.data,
    model,
    reasoningEffort: parsedReasoningEffort.data,
    openrouterModelProvider:
      parsedProvider.data === "openrouter" ? openrouterModelProvider : null,
    inputTokenCostUsdPerMillion: validateOptionalCost(
      input.inputTokenCostUsdPerMillion,
      "Input token cost"
    ),
    cachedInputTokenCostUsdPerMillion: validateOptionalCost(
      input.cachedInputTokenCostUsdPerMillion,
      "Cached input token cost"
    ),
    outputTokenCostUsdPerMillion: validateOptionalCost(
      input.outputTokenCostUsdPerMillion,
      "Output token cost"
    ),
    isDefault: input.isDefault && input.isEnabled,
  }
}

function validateOptionalCost(value: number | null, label: string) {
  if (value === null) {
    return null
  }

  if (!Number.isFinite(value) || value < 0) {
    throw new LlmModelPresetValidationError(`${label} must be nonnegative.`)
  }

  return value
}

function mapLlmModelPresetRow(row: LlmModelPresetRow): LlmModelPreset {
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    openrouterModelProvider: row.openrouter_model_provider,
    inputTokenCostUsdPerMillion: toOptionalNumber(
      row.input_token_cost_usd_per_million
    ),
    cachedInputTokenCostUsdPerMillion: toOptionalNumber(
      row.cached_input_token_cost_usd_per_million
    ),
    outputTokenCostUsdPerMillion: toOptionalNumber(
      row.output_token_cost_usd_per_million
    ),
    isEnabled: row.is_enabled,
    isDefault: row.is_default,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function toOptionalNumber(value: string | number | null) {
  if (value === null) {
    return null
  }

  const parsedValue = Number(value)

  return Number.isFinite(parsedValue) ? parsedValue : null
}

function toInteger(value: string | number, label: string) {
  const parsedValue = Number(value)

  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Invalid ${label}: ${value}`)
  }

  return parsedValue
}

function quoteSqlLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`
}

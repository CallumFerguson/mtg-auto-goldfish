import { z } from "zod/v4"

export const llmProviderSchema = z.enum(["openai", "openrouter", "llamacpp"])
export const reasoningEffortSchema = z.enum([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

export type LlmProvider = z.infer<typeof llmProviderSchema>
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>

type Environment = Record<string, string | undefined>

type BaseLlmRunConfig = {
  apiKey: string
  provider: LlmProvider
}

type ReasoningEffortLlmRunConfig = BaseLlmRunConfig & {
  reasoningEffort: ReasoningEffort
}

type ConfiguredModelLlmRunConfig = ReasoningEffortLlmRunConfig & {
  model: string
}

export type OpenAiRunConfig = ConfiguredModelLlmRunConfig & {
  provider: "openai"
}

export type OpenRouterRunConfig = ConfiguredModelLlmRunConfig & {
  provider: "openrouter"
  modelProvider: string | null
  stopWhenStepCount: number
}

export type LlamaCppRunConfig = BaseLlmRunConfig & {
  provider: "llamacpp"
  baseUrl: string
  model: string | null
  reasoningEffort: null
  stopWhenStepCount: number
}

export type ResolvedLlamaCppRunConfig = LlamaCppRunConfig & {
  model: string
}

export type OpeningHandOpenAiRunConfig = OpenAiRunConfig & {
  openingHandMcpPublicUrl: string
}

export type TurnSimulationOpenAiRunConfig = OpenAiRunConfig & {
  turnSimulationMcpPublicUrl: string
}

export type OpeningHandLlmRunConfig =
  | OpeningHandOpenAiRunConfig
  | OpenRouterRunConfig
  | LlamaCppRunConfig

export type TurnSimulationLlmRunConfig =
  | TurnSimulationOpenAiRunConfig
  | OpenRouterRunConfig
  | LlamaCppRunConfig

export type ResolvedOpeningHandLlmRunConfig =
  | OpeningHandOpenAiRunConfig
  | OpenRouterRunConfig
  | ResolvedLlamaCppRunConfig

export type ResolvedTurnSimulationLlmRunConfig =
  | TurnSimulationOpenAiRunConfig
  | OpenRouterRunConfig
  | ResolvedLlamaCppRunConfig

export type EvaluationLlmRunConfig =
  | OpenAiRunConfig
  | OpenRouterRunConfig
  | LlamaCppRunConfig

export type ResolvedEvaluationLlmRunConfig =
  | OpenAiRunConfig
  | OpenRouterRunConfig
  | ResolvedLlamaCppRunConfig

export class LlmConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LlmConfigurationError"
  }
}

export function getOpeningHandLlmRunConfig(
  environment: Environment = process.env
): OpeningHandLlmRunConfig {
  const config = getLlmRunConfig(environment)

  if (config.provider === "openai") {
    return {
      ...config,
      openingHandMcpPublicUrl: getRequiredEnvironmentVariable(
        environment,
        "OPENING_HAND_MCP_PUBLIC_URL"
      ),
    }
  }

  return config
}

export function getTurnSimulationLlmRunConfig(
  environment: Environment = process.env
): TurnSimulationLlmRunConfig {
  const config = getLlmRunConfig(environment)

  if (config.provider === "openai") {
    return {
      ...config,
      turnSimulationMcpPublicUrl: getRequiredEnvironmentVariable(
        environment,
        "TURN_SIMULATION_MCP_PUBLIC_URL"
      ),
    }
  }

  return config
}

export function getEvaluationLlmRunConfig(
  environment: Environment = process.env
): EvaluationLlmRunConfig {
  return getLlmRunConfig(environment)
}

export function getOpenRouterApiKey(environment: Environment = process.env) {
  return getRequiredEnvironmentVariable(environment, "OPENROUTER_API_KEY")
}

function getLlmRunConfig(
  environment: Environment
): OpenAiRunConfig | OpenRouterRunConfig | LlamaCppRunConfig {
  const provider = getLlmProvider(environment)

  if (provider === "openai") {
    return {
      apiKey: getRequiredEnvironmentVariable(environment, "OPENAI_API_KEY"),
      model: getRequiredEnvironmentVariable(environment, "OPENAI_MODEL"),
      provider,
      reasoningEffort: getRequiredReasoningEffort(
        environment,
        "OPENAI_REASONING_EFFORT"
      ),
    }
  }

  if (provider === "llamacpp") {
    return {
      apiKey:
        getOptionalEnvironmentVariable(environment, "LLAMACPP_API_KEY") ??
        "not-needed",
      baseUrl: getRequiredEnvironmentVariable(environment, "LLAMACPP_BASE_URL"),
      model: null,
      provider,
      reasoningEffort: null,
      stopWhenStepCount: getRequiredPositiveIntegerEnvironmentVariable(
        environment,
        "LLAMACPP_STOP_WHEN_STEP_COUNT"
      ),
    }
  }

  return {
    apiKey: getRequiredEnvironmentVariable(environment, "OPENROUTER_API_KEY"),
    model: getRequiredEnvironmentVariable(environment, "OPENROUTER_MODEL"),
    modelProvider: getOptionalEnvironmentVariable(
      environment,
      "OPENROUTER_MODEL_PROVIDER"
    ),
    provider,
    reasoningEffort: getRequiredReasoningEffort(
      environment,
      "OPENROUTER_REASONING_EFFORT"
    ),
    stopWhenStepCount: getRequiredPositiveIntegerEnvironmentVariable(
      environment,
      "OPENROUTER_STOP_WHEN_STEP_COUNT"
    ),
  }
}

function getLlmProvider(environment: Environment): LlmProvider {
  const rawProvider = getRequiredEnvironmentVariable(
    environment,
    "LLM_PROVIDER"
  )
  const parsedProvider = llmProviderSchema.safeParse(rawProvider)

  if (!parsedProvider.success) {
    throw new LlmConfigurationError(
      "LLM_PROVIDER must be one of: openai, openrouter, llamacpp."
    )
  }

  return parsedProvider.data
}

function getRequiredReasoningEffort(
  environment: Environment,
  environmentVariable: string
) {
  const rawReasoningEffort = getRequiredEnvironmentVariable(
    environment,
    environmentVariable
  )
  const parsedReasoningEffort =
    reasoningEffortSchema.safeParse(rawReasoningEffort)

  if (!parsedReasoningEffort.success) {
    throw new LlmConfigurationError(
      `${environmentVariable} must be one of: none, minimal, low, medium, high, xhigh.`
    )
  }

  return parsedReasoningEffort.data
}

function getRequiredPositiveIntegerEnvironmentVariable(
  environment: Environment,
  environmentVariable: string
) {
  const value = getRequiredEnvironmentVariable(environment, environmentVariable)
  const parsedValue = Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new LlmConfigurationError(
      `${environmentVariable} must be a positive integer.`
    )
  }

  return parsedValue
}

function getRequiredEnvironmentVariable(
  environment: Environment,
  environmentVariable: string
) {
  const value = environment[environmentVariable]?.trim()

  if (!value) {
    throw new LlmConfigurationError(
      `Missing LLM environment variable(s): ${environmentVariable}. Add it to your repo-root .env file.`
    )
  }

  return value
}

function getOptionalEnvironmentVariable(
  environment: Environment,
  environmentVariable: string
) {
  return environment[environmentVariable]?.trim() || null
}

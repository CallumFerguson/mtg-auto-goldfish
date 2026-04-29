type OpenAiTokenPrice = {
  inputDollarsPerMillion: number
  cachedInputDollarsPerMillion: number | null
  outputDollarsPerMillion: number
}

export type OpenAiPriceEstimate = {
  cents: number
  formattedCents: string
}

const OPENAI_TOKEN_PRICES: Record<string, OpenAiTokenPrice> = {
  "gpt-5.5": {
    inputDollarsPerMillion: 5,
    cachedInputDollarsPerMillion: 0.5,
    outputDollarsPerMillion: 30,
  },
  "gpt-5.5-pro": {
    inputDollarsPerMillion: 30,
    cachedInputDollarsPerMillion: null,
    outputDollarsPerMillion: 180,
  },
  "gpt-5.4": {
    inputDollarsPerMillion: 2.5,
    cachedInputDollarsPerMillion: 0.25,
    outputDollarsPerMillion: 15,
  },
  "gpt-5.4-mini": {
    inputDollarsPerMillion: 0.75,
    cachedInputDollarsPerMillion: 0.075,
    outputDollarsPerMillion: 4.5,
  },
  "gpt-5.4-nano": {
    inputDollarsPerMillion: 0.2,
    cachedInputDollarsPerMillion: 0.02,
    outputDollarsPerMillion: 1.25,
  },
  "gpt-5.4-pro": {
    inputDollarsPerMillion: 30,
    cachedInputDollarsPerMillion: null,
    outputDollarsPerMillion: 180,
  },
}

export function estimateOpenAiTokenPriceCents({
  model,
  usage,
}: {
  model: string
  usage: unknown
}): OpenAiPriceEstimate | null {
  const normalizedModel = normalizeSupportedOpenAiModel(model)

  if (!normalizedModel) {
    return null
  }

  const usageRecord = asRecord(usage)
  const inputTokens = getNumberProperty(usageRecord, "input_tokens")
  const outputTokens = getNumberProperty(usageRecord, "output_tokens")

  if (inputTokens === null || outputTokens === null) {
    return null
  }

  const price = OPENAI_TOKEN_PRICES[normalizedModel]
  const inputDetails = asRecord(usageRecord.input_tokens_details)
  const cachedInputTokens = Math.min(
    getNumberProperty(inputDetails, "cached_tokens") ?? 0,
    inputTokens
  )
  const standardInputTokens = inputTokens - cachedInputTokens
  const cachedInputRate =
    price.cachedInputDollarsPerMillion ?? price.inputDollarsPerMillion
  const dollars =
    (standardInputTokens * price.inputDollarsPerMillion) / 1_000_000 +
    (cachedInputTokens * cachedInputRate) / 1_000_000 +
    (outputTokens * price.outputDollarsPerMillion) / 1_000_000
  const cents = dollars * 100

  return {
    cents,
    formattedCents: formatPriceEstimateCents(cents),
  }
}

function normalizeSupportedOpenAiModel(model: string) {
  const normalizedModel = model.trim().toLowerCase()

  for (const supportedModel of Object.keys(OPENAI_TOKEN_PRICES)) {
    if (
      normalizedModel === supportedModel ||
      normalizedModel.startsWith(`${supportedModel}-202`)
    ) {
      return supportedModel
    }
  }

  return null
}

function formatPriceEstimateCents(cents: number) {
  if (cents < 0.1) {
    return "<0.1"
  }

  return cents.toFixed(1)
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function getNumberProperty(record: Record<string, unknown>, property: string) {
  const value = record[property]

  return typeof value === "number" && Number.isFinite(value) ? value : null
}

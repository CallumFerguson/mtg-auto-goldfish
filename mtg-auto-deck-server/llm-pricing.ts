export type TokenPrice = {
  inputDollarsPerMillion: number | null
  cachedInputDollarsPerMillion: number | null
  outputDollarsPerMillion: number | null
}

export function estimatePresetTokenCostUsd({
  tokenCosts,
  usage,
}: {
  tokenCosts: TokenPrice
  usage: unknown
}) {
  const inputRate = getCostValue(tokenCosts.inputDollarsPerMillion)
  const cachedInputRate = getCostValue(
    tokenCosts.cachedInputDollarsPerMillion
  )
  const outputRate = getCostValue(tokenCosts.outputDollarsPerMillion)

  if (inputRate === null || cachedInputRate === null || outputRate === null) {
    return null
  }

  const usageRecord = asRecord(usage)
  const inputTokens = getNumberProperty(
    usageRecord,
    "input_tokens",
    "inputTokens",
    "prompt_tokens",
    "promptTokens"
  )
  const outputTokens = getNumberProperty(
    usageRecord,
    "output_tokens",
    "outputTokens",
    "completion_tokens",
    "completionTokens"
  )

  if (inputTokens === null || outputTokens === null) {
    return null
  }

  const inputDetails = asRecord(
    getFirstDefinedProperty(usageRecord, [
      "input_tokens_details",
      "inputTokensDetails",
      "prompt_tokens_details",
      "promptTokensDetails",
    ])
  )
  const cachedInputTokens = Math.min(
    getNumberProperty(inputDetails, "cached_tokens", "cachedTokens") ?? 0,
    inputTokens
  )
  const standardInputTokens = inputTokens - cachedInputTokens

  return (
    (standardInputTokens * inputRate) / 1_000_000 +
    (cachedInputTokens * cachedInputRate) / 1_000_000 +
    (outputTokens * outputRate) / 1_000_000
  )
}

export function getOpenRouterReportedCostUsd(usage: unknown) {
  const costUsd = getNumberProperty(asRecord(usage), "cost")

  return costUsd !== null && costUsd >= 0 ? costUsd : null
}

export function formatUsdCostAsCents(costUsd: number | null | undefined) {
  if (
    costUsd === null ||
    costUsd === undefined ||
    !Number.isFinite(costUsd) ||
    costUsd < 0
  ) {
    return null
  }

  const cents = costUsd * 100

  if (cents < 0.1) {
    return "<0.1"
  }

  return cents.toFixed(1)
}

export function formatPreferredLlmRunCostAsCents({
  estimatedCostUsd,
  openrouterReportedCostUsd,
}: {
  estimatedCostUsd: number | null
  openrouterReportedCostUsd: number | null
}) {
  return formatUsdCostAsCents(openrouterReportedCostUsd ?? estimatedCostUsd)
}

export function aggregateOpenRouterUsage(
  usageValues: readonly unknown[]
): Record<string, unknown> {
  const usageRecords = usageValues.map(asRecord)

  if (usageRecords.length === 0) {
    return {}
  }

  const inputTokens = sumRequiredNumberProperties(usageRecords, [
    "inputTokens",
    "input_tokens",
  ])
  const outputTokens = sumRequiredNumberProperties(usageRecords, [
    "outputTokens",
    "output_tokens",
  ])
  const reportedTotalTokens = sumRequiredNumberProperties(usageRecords, [
    "totalTokens",
    "total_tokens",
  ])
  const aggregate: Record<string, unknown> = {}

  if (inputTokens !== null) {
    aggregate.inputTokens = inputTokens
    aggregate.inputTokensDetails = {
      cachedTokens: Math.min(
        sumOptionalNestedNumberProperties(
          usageRecords,
          ["inputTokensDetails", "input_tokens_details"],
          ["cachedTokens", "cached_tokens"]
        ),
        inputTokens
      ),
    }
  }

  if (outputTokens !== null) {
    aggregate.outputTokens = outputTokens
    aggregate.outputTokensDetails = {
      reasoningTokens: sumOptionalNestedNumberProperties(
        usageRecords,
        ["outputTokensDetails", "output_tokens_details"],
        ["reasoningTokens", "reasoning_tokens"]
      ),
    }
  }

  if (reportedTotalTokens !== null) {
    aggregate.totalTokens = reportedTotalTokens
  } else if (inputTokens !== null && outputTokens !== null) {
    aggregate.totalTokens = inputTokens + outputTokens
  }

  const cost = sumRequiredNumberProperties(usageRecords, ["cost"])

  if (cost !== null) {
    aggregate.cost = cost
  }

  const costDetails = aggregateOpenRouterCostDetails(usageRecords)

  if (Object.keys(costDetails).length > 0) {
    aggregate.costDetails = costDetails
  }

  return aggregate
}

function getCostValue(value: number | null) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function getNumberProperty(
  record: Record<string, unknown>,
  ...properties: string[]
) {
  for (const property of properties) {
    const value = record[property]

    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }
  }

  return null
}

function sumRequiredNumberProperties(
  records: readonly Record<string, unknown>[],
  properties: readonly string[]
) {
  let total = 0

  for (const record of records) {
    const value = getNumberProperty(record, ...properties)

    if (value === null) {
      return null
    }

    total += value
  }

  return total
}

function sumOptionalNestedNumberProperties(
  records: readonly Record<string, unknown>[],
  parentProperties: readonly string[],
  properties: readonly string[]
) {
  return records.reduce((total, record) => {
    const nestedRecord = asRecord(
      getFirstDefinedProperty(record, parentProperties)
    )
    const value = getNumberProperty(nestedRecord, ...properties)

    return total + (value ?? 0)
  }, 0)
}

function aggregateOpenRouterCostDetails(
  usageRecords: readonly Record<string, unknown>[]
) {
  const costDetailsRecords = usageRecords.map((record) =>
    asRecord(record.costDetails ?? record.cost_details)
  )
  const costDetails: Record<string, number> = {}
  const upstreamInferenceCost = sumRequiredNumberProperties(
    costDetailsRecords,
    ["upstreamInferenceCost", "upstream_inference_cost"]
  )
  const upstreamInferenceInputCost = sumRequiredNumberProperties(
    costDetailsRecords,
    ["upstreamInferenceInputCost", "upstream_inference_input_cost"]
  )
  const upstreamInferenceOutputCost = sumRequiredNumberProperties(
    costDetailsRecords,
    ["upstreamInferenceOutputCost", "upstream_inference_output_cost"]
  )

  if (upstreamInferenceCost !== null) {
    costDetails.upstreamInferenceCost = upstreamInferenceCost
  }

  if (upstreamInferenceInputCost !== null) {
    costDetails.upstreamInferenceInputCost = upstreamInferenceInputCost
  }

  if (upstreamInferenceOutputCost !== null) {
    costDetails.upstreamInferenceOutputCost = upstreamInferenceOutputCost
  }

  return costDetails
}

function getFirstDefinedProperty(
  record: Record<string, unknown>,
  properties: readonly string[]
) {
  for (const property of properties) {
    if (record[property] !== undefined) {
      return record[property]
    }
  }

  return undefined
}

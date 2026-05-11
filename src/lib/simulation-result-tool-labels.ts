import type { SimulationDebugLlmRunChunk } from "./deck-types"

export type SimulationResultToolLabelState =
  | "active"
  | "started"
  | "completed"
  | "failed"

export function getKnownSimulationResultToolLabel({
  mcpFunctionName,
  mcpFunctionOutput = null,
  state,
}: {
  mcpFunctionName: string | null
  mcpFunctionOutput?: unknown | null
  state: SimulationResultToolLabelState
}) {
  if (mcpFunctionName === null) {
    return null
  }

  const outputData = getToolOutputDataRecord(mcpFunctionOutput)

  switch (mcpFunctionName) {
    case "draw_starting_hand":
      return getDrawStartingHandLabel(state)
    case "mulligan":
      return getMulliganLabel(state, outputData)
    case "draw_card_from_top":
      return getDrawCardsLabel(state, outputData, "top")
    case "draw_card_from_bottom":
      return getDrawCardsLabel(state, outputData, "bottom")
    case "take_cards_from_library":
      return getTakeCardsFromDeckLabel(state, outputData)
    case "return_card_to_library":
      return getReturnCardToDeckLabel(state, outputData)
    case "return_cards_to_library":
      return getReturnCardsToDeckLabel(state, outputData)
    case "shuffle_library":
      return getShuffleDeckLabel(state)
    case "log_turn_action":
      return getLogTurnActionLabel(state, mcpFunctionOutput)
    default:
      return null
  }
}

export function getKnownSimulationResultToolLabelForChunk({
  chunk,
  state,
}: {
  chunk: Pick<
    SimulationDebugLlmRunChunk,
    "mcpFunctionName" | "mcpFunctionOutput"
  >
  state: SimulationResultToolLabelState
}) {
  return getKnownSimulationResultToolLabel({
    mcpFunctionName: chunk.mcpFunctionName,
    mcpFunctionOutput: chunk.mcpFunctionOutput,
    state,
  })
}

export function getSimulationResultToolReason({
  mcpFunctionName,
  mcpFunctionOutput = null,
  mcpFunctionReason = null,
}: {
  mcpFunctionName: string | null
  mcpFunctionOutput?: unknown | null
  mcpFunctionReason?: string | null
}) {
  if (mcpFunctionName === null || mcpFunctionName === "log_turn_action") {
    return null
  }

  const storedReason = getTrimmedString(mcpFunctionReason)

  if (storedReason !== null) {
    return storedReason
  }

  const resolvedOutput = parseJsonObjectPayload(mcpFunctionOutput)
  const outputRecord = asRecord(resolvedOutput)
  const directReason = getTrimmedString(outputRecord.reason)

  if (directReason !== null) {
    return directReason
  }

  return getTrimmedString(asRecord(outputRecord.data).reason)
}

export function getSimulationResultToolReasonForChunk({
  chunk,
}: {
  chunk: Pick<
    SimulationDebugLlmRunChunk,
    "mcpFunctionName" | "mcpFunctionOutput" | "mcpFunctionReason"
  >
}) {
  return getSimulationResultToolReason({
    mcpFunctionName: chunk.mcpFunctionName,
    mcpFunctionOutput: chunk.mcpFunctionOutput,
    mcpFunctionReason: chunk.mcpFunctionReason,
  })
}

function getDrawStartingHandLabel(state: SimulationResultToolLabelState) {
  switch (state) {
    case "active":
    case "started":
      return "Drawing opening hand"
    case "failed":
      return "Could not draw opening hand"
    case "completed":
      return "Drew opening hand"
  }
}

function getMulliganLabel(
  state: SimulationResultToolLabelState,
  outputData: Record<string, unknown>
) {
  switch (state) {
    case "active":
    case "started":
      return "Taking mulligan"
    case "failed":
      return "Could not take mulligan"
    case "completed": {
      const mulliganCount = getNumber(outputData, "mulliganCount")

      return mulliganCount === null
        ? "Took mulligan and drew a replacement hand"
        : `Took mulligan ${mulliganCount} and drew a replacement hand`
    }
  }
}

function getDrawCardsLabel(
  state: SimulationResultToolLabelState,
  outputData: Record<string, unknown>,
  side: "top" | "bottom"
) {
  switch (state) {
    case "active":
    case "started":
      return `Drawing card from ${side} of deck`
    case "failed":
      return `Could not draw card from ${side} of deck`
    case "completed":
      return `Drew ${formatCardCount(
        getArrayLength(outputData, "cards")
      )} from ${side} of deck`
  }
}

function getTakeCardsFromDeckLabel(
  state: SimulationResultToolLabelState,
  outputData: Record<string, unknown>
) {
  switch (state) {
    case "active":
    case "started":
      return "Searching deck for cards"
    case "failed":
      return "Could not search deck for cards"
    case "completed": {
      const requestedCount =
        getArrayLength(outputData, "requestedCards") ??
        getArrayLength(outputData, "matches")
      const foundCount =
        getArrayLength(outputData, "foundCards") ??
        getFoundMatchCount(outputData)

      if (requestedCount !== null && foundCount !== null) {
        return `Found ${foundCount} of ${requestedCount} requested ${pluralize(
          requestedCount,
          "card",
          "cards"
        )} in deck`
      }

      if (foundCount !== null) {
        return `Found and removed ${formatCardCount(foundCount)} from deck`
      }

      return "Searched deck for requested cards"
    }
  }
}

function getReturnCardToDeckLabel(
  state: SimulationResultToolLabelState,
  outputData: Record<string, unknown>
) {
  switch (state) {
    case "active":
    case "started":
      return "Returning card to deck"
    case "failed":
      return "Could not return card to deck"
    case "completed": {
      const card = getString(outputData, "card") ?? "a card"
      const side = getDeckSide(outputData)
      const position = getNumber(outputData, "position")

      if (side === null) {
        return `Returned ${card} to deck`
      }

      if (position === null || position === 0) {
        return `Returned ${card} to ${side} of deck`
      }

      return `Returned ${card} to deck with ${position} ${pluralize(
        position,
        "card",
        "cards"
      )} ${side === "top" ? "above" : "below"} it`
    }
  }
}

function getReturnCardsToDeckLabel(
  state: SimulationResultToolLabelState,
  outputData: Record<string, unknown>
) {
  switch (state) {
    case "active":
    case "started":
      return "Returning cards to deck"
    case "failed":
      return "Could not return cards to deck"
    case "completed": {
      const side = getDeckSide(outputData)
      const cardCount = getArrayLength(outputData, "cards")
      const randomOrder = getBoolean(outputData, "randomizeOrder")
        ? " in random order"
        : ""

      if (side === null) {
        return `Returned ${formatCardCount(cardCount)} to deck${randomOrder}`
      }

      return `Returned ${formatCardCount(
        cardCount
      )} to ${side} of deck${randomOrder}`
    }
  }
}

function getShuffleDeckLabel(state: SimulationResultToolLabelState) {
  switch (state) {
    case "active":
    case "started":
      return "Shuffling deck"
    case "failed":
      return "Could not shuffle deck"
    case "completed":
      return "Shuffled deck"
  }
}

function getLogTurnActionLabel(
  state: SimulationResultToolLabelState,
  mcpFunctionOutput: unknown
) {
  switch (state) {
    case "active":
    case "started":
      return "Logging turn action"
    case "failed":
      return "Could not log turn action"
    case "completed": {
      const loggedAction = getLoggedTurnActionFromOutput(mcpFunctionOutput)

      return loggedAction === null
        ? "Logged turn action"
        : `Logged turn action: ${loggedAction}`
    }
  }
}

function getLoggedTurnActionFromOutput(output: unknown) {
  const resolvedOutput = parseJsonObjectPayload(output)
  const outputRecord = asRecord(resolvedOutput)
  const latestAction = asRecord(outputRecord.latestAction)
  const action = getString(latestAction, "action")?.trim()

  return action && action.length > 0 ? action : null
}

function getToolOutputDataRecord(output: unknown) {
  const resolvedOutput = parseJsonObjectPayload(output)
  const outputRecord = asRecord(resolvedOutput)
  const dataRecord = asRecord(outputRecord.data)

  if (Object.hasOwn(outputRecord, "data") && dataRecord !== EMPTY_RECORD) {
    return dataRecord
  }

  return outputRecord
}

function parseJsonObjectPayload(payload: unknown): unknown {
  if (Array.isArray(payload)) {
    for (const part of payload) {
      const text = getString(part, "text")

      if (text === null) {
        continue
      }

      const parsedTextPayload = parseJsonObjectPayload(text)

      if (typeof parsedTextPayload === "object" && parsedTextPayload !== null) {
        return parsedTextPayload
      }
    }

    return null
  }

  if (typeof payload === "object" && payload !== null) {
    const content = asRecord(payload).content

    if (Array.isArray(content)) {
      for (const part of content) {
        const text = getString(part, "text")

        if (text === null) {
          continue
        }

        const parsedTextPayload = parseJsonObjectPayload(text)

        if (typeof parsedTextPayload === "object" && parsedTextPayload !== null) {
          return parsedTextPayload
        }
      }
    }

    return payload
  }

  if (typeof payload !== "string") {
    return null
  }

  try {
    const parsedPayload = JSON.parse(payload) as unknown

    return typeof parsedPayload === "object" && parsedPayload !== null
      ? parsedPayload
      : null
  } catch {
    return null
  }
}

const EMPTY_RECORD: Record<string, unknown> = {}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : EMPTY_RECORD
}

function getArrayLength(value: unknown, property: string) {
  const propertyValue = asRecord(value)[property]

  return Array.isArray(propertyValue) ? propertyValue.length : null
}

function getBoolean(value: unknown, property: string) {
  const propertyValue = asRecord(value)[property]

  return typeof propertyValue === "boolean" ? propertyValue : null
}

function getDeckSide(value: unknown) {
  const side = getString(value, "side")

  return side === "top" || side === "bottom" ? side : null
}

function getFoundMatchCount(value: unknown) {
  const matches = asRecord(value).matches

  if (!Array.isArray(matches)) {
    return null
  }

  return matches.filter((match) => getString(match, "foundCard") !== null)
    .length
}

function getNumber(value: unknown, property: string) {
  const propertyValue = asRecord(value)[property]

  return typeof propertyValue === "number" && Number.isFinite(propertyValue)
    ? propertyValue
    : null
}

function getString(value: unknown, property: string) {
  const propertyValue = asRecord(value)[property]

  return typeof propertyValue === "string" ? propertyValue : null
}

function getTrimmedString(value: unknown) {
  if (typeof value !== "string") {
    return null
  }

  const trimmedValue = value.trim()

  return trimmedValue.length > 0 ? trimmedValue : null
}

function formatCardCount(count: number | null) {
  if (count === null) {
    return "cards"
  }

  return count === 1 ? "a card" : `${count} cards`
}

function pluralize(count: number, singular: string, plural: string) {
  return count === 1 ? singular : plural
}

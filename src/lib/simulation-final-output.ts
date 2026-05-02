import type { SimulationDebugLlmRun } from "./deck-types"

export type ParsedSimulationFinalOutput =
  | {
      type: "opening_hand"
      keptHand: string[]
      summary: string
    }
  | {
      type: "turn"
      gameState: string
      summary: string
    }

export function parseSimulationFinalOutput(
  run: Pick<SimulationDebugLlmRun, "phase" | "status" | "chunks">
): ParsedSimulationFinalOutput | null {
  if (run.status !== "completed") {
    return null
  }

  const finalOutput = run.chunks
    .map((chunk) => chunk.outputDelta ?? "")
    .join("")
    .trim()

  if (!finalOutput) {
    return null
  }

  let parsedOutput: unknown

  try {
    parsedOutput = parseJsonWithLastObjectFallback(finalOutput)
  } catch {
    return null
  }

  if (run.phase === "opening_hand") {
    return parseOpeningHandFinalOutput(parsedOutput)
  }

  if (run.phase === "turn") {
    return parseTurnFinalOutput(parsedOutput)
  }

  return null
}

function parseOpeningHandFinalOutput(
  value: unknown
): ParsedSimulationFinalOutput | null {
  if (!isRecord(value)) {
    return null
  }

  const keptHand = value.keptHand
  const summary = value.summary

  if (
    !Array.isArray(keptHand) ||
    !keptHand.every((cardName) => typeof cardName === "string") ||
    typeof summary !== "string"
  ) {
    return null
  }

  return {
    type: "opening_hand",
    keptHand,
    summary,
  }
}

function parseTurnFinalOutput(value: unknown): ParsedSimulationFinalOutput | null {
  if (!isRecord(value)) {
    return null
  }

  const gameState = value.gameState
  const summary = value.summary

  if (typeof gameState !== "string" || typeof summary !== "string") {
    return null
  }

  return {
    type: "turn",
    gameState,
    summary,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseJsonWithLastObjectFallback(responseText: string) {
  const trimmedResponseText = responseText.trim()

  try {
    return JSON.parse(trimmedResponseText) as unknown
  } catch (error) {
    const parsedObject = parseLastJsonObject(trimmedResponseText)

    if (parsedObject.found) {
      return parsedObject.value
    }

    throw error
  }
}

function parseLastJsonObject(
  text: string
): { found: true; value: unknown } | { found: false } {
  let lastParsedObject:
    | { end: number; start: number; value: unknown }
    | undefined

  for (
    let start = text.indexOf("{");
    start !== -1;
    start = text.indexOf("{", start + 1)
  ) {
    const end = findJsonObjectEnd(text, start)

    if (end === null) {
      continue
    }

    try {
      const value = JSON.parse(text.slice(start, end)) as unknown

      if (
        lastParsedObject === undefined ||
        end > lastParsedObject.end ||
        (end === lastParsedObject.end && start < lastParsedObject.start)
      ) {
        lastParsedObject = { end, start, value }
      }
    } catch {
      // Keep looking for another balanced object.
    }
  }

  return lastParsedObject === undefined
    ? { found: false }
    : { found: true, value: lastParsedObject.value }
}

function findJsonObjectEnd(text: string, start: number) {
  let objectDepth = 0
  let isInString = false
  let isEscaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]

    if (isInString) {
      if (isEscaped) {
        isEscaped = false
        continue
      }

      if (char === "\\") {
        isEscaped = true
        continue
      }

      if (char === '"') {
        isInString = false
      }

      continue
    }

    if (char === '"') {
      isInString = true
      continue
    }

    if (char === "{") {
      objectDepth += 1
      continue
    }

    if (char === "}") {
      objectDepth -= 1

      if (objectDepth === 0) {
        return index + 1
      }
    }
  }

  return null
}

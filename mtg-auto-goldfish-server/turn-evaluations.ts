import { z } from "zod/v4"
import { formatSimulationRunClipboardText } from "./simulation-run-text.js"
import type {
  LlmChunkKind,
  LlmRunPhase,
  LlmRunStatus,
  SimulationDebugLlmRunChunk,
  TurnEvaluationJson,
} from "./simulations-postgres.js"

const turnEvaluationJsonSchema = z
  .object({
    legalTurnPass: z.boolean(),
    reasoningPass: z.boolean(),
    simulationQualityScore: z.number().min(0).max(10),
    illegalActions: z.array(z.string()),
    reasoningMistakes: z.array(z.string()),
    strategicMistakes: z.array(z.string()),
  })
  .strict()

export function buildTurnEvaluationInputText({
  chunks,
  fullPrompt,
}: {
  chunks: readonly SimulationDebugLlmRunChunk[]
  fullPrompt: string
}) {
  return formatSimulationRunClipboardText({ chunks }, { fullPrompt })
}

export function buildTurnEvaluationPrompt({
  turnEvaluationInputText,
  turnNumber,
}: {
  turnEvaluationInputText: string
  turnNumber: number
}) {
  return `
You are evaluating a Magic: The Gathering Commander goldfish simulation turn.

Evaluate whether the simulated turn ${turnNumber} was legal, whether the model made reasoning mistakes, and how good the simulated turn was strategically.

Use the full turn prompt, card reference, game state, tool calls, tool results, logged actions, reasoning, and final output in the transcript below.

Return only valid JSON in this exact shape:
{
  "legalTurnPass": true,
  "reasoningPass": true,
  "simulationQualityScore": 8.5,
  "illegalActions": [],
  "reasoningMistakes": [],
  "strategicMistakes": []
}

Field rules:
- legalTurnPass is false if the turn performed illegal Magic actions, illegal tool interactions, impossible zone changes, illegal mana/payment choices, or a final game state inconsistent with the recorded actions.
- reasoningPass is false if the model made incorrect claims, contradicted itself, relied on wrong card text, or justified an action incorrectly.
- simulationQualityScore is a subjective score from 0 to 10.
- illegalActions, reasoningMistakes, and strategicMistakes must be arrays of concise strings. Use [] when none are found.

=== Turn Prompt And Activity ===

${turnEvaluationInputText}
`.trim()
}

export type TurnEvaluationEligibilityRun = {
  phase: LlmRunPhase
  status: LlmRunStatus
  chunks: readonly {
    kind: LlmChunkKind
  }[]
}

export function getTurnEvaluationIneligibilityMessage(
  run: TurnEvaluationEligibilityRun
) {
  if (run.phase !== "turn") {
    return "Only turn LLM runs can be evaluated."
  }

  if (run.status !== "completed") {
    return "Only completed turn LLM runs can be evaluated."
  }

  if (run.chunks.some((chunk) => chunk.kind === "error")) {
    return "Turn LLM runs with errors cannot be evaluated."
  }

  return null
}

export function parseTurnEvaluationResponseText(
  responseText: string
): TurnEvaluationJson {
  if (!responseText.trim()) {
    throw new Error("Turn evaluation response was empty.")
  }

  let parsedResponse: unknown

  try {
    parsedResponse = parseJsonWithLastObjectFallback(responseText)
  } catch (error) {
    throw new Error("Turn evaluation response was not valid JSON.", {
      cause: error,
    })
  }

  const parsedEvaluation = turnEvaluationJsonSchema.safeParse(parsedResponse)

  if (!parsedEvaluation.success) {
    throw new Error("Turn evaluation response did not match the expected JSON.")
  }

  return parsedEvaluation.data
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
      } else if (char === "\\") {
        isEscaped = true
      } else if (char === '"') {
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

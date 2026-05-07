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
  | {
      type: "report"
      report: string
    }

export function getSimulationFinalParsedOutput(
  run: Pick<SimulationDebugLlmRun, "phase" | "chunks">
): ParsedSimulationFinalOutput | null {
  const finalParsedOutputChunk = [...run.chunks]
    .reverse()
    .find((chunk) => chunk.kind === "final_parsed_output")

  if (!finalParsedOutputChunk) {
    return null
  }

  return getSimulationFinalParsedOutputFromPayload(
    run.phase,
    finalParsedOutputChunk.payload
  )
}

export function getSimulationFinalParsedOutputFromPayload(
  phase: string,
  payload: unknown
): ParsedSimulationFinalOutput | null {
  if (phase === "opening_hand") {
    return getOpeningHandFinalParsedOutput(payload)
  }

  if (phase === "turn") {
    return getTurnFinalParsedOutput(payload)
  }

  if (phase === "report") {
    return getReportFinalParsedOutput(payload)
  }

  return null
}

function getOpeningHandFinalParsedOutput(
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

function getTurnFinalParsedOutput(
  value: unknown
): ParsedSimulationFinalOutput | null {
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

function getReportFinalParsedOutput(
  value: unknown
): ParsedSimulationFinalOutput | null {
  if (!isRecord(value)) {
    return null
  }

  const report = value.report

  if (typeof report !== "string" || !report.trim()) {
    return null
  }

  return {
    type: "report",
    report,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

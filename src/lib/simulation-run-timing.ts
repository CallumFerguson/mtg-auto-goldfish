import type { SimulationDebugLlmRun } from "./deck-types"

export function getSimulationRunStartTimeMs(run: SimulationDebugLlmRun) {
  return parseTimestampMs(run.startedAt)
}

export function parseTimestampMs(timestamp: string | null | undefined) {
  if (!timestamp) {
    return null
  }

  const parsedTimestamp = Date.parse(timestamp)

  return Number.isNaN(parsedTimestamp) ? null : parsedTimestamp
}

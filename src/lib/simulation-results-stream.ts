import type {
  SimulationDebugLlmRun,
  SimulationDebugLlmRunChunk,
  SimulationResultsInfo,
  SimulationResultsStreamEvent,
} from "./deck-types"

type SimulationOpenRouterGeneration =
  SimulationDebugLlmRun["openrouterGenerations"][number]

export function applySimulationResultsStreamEvent(
  currentResults: SimulationResultsInfo | null,
  streamEvent: SimulationResultsStreamEvent
) {
  if (streamEvent.type === "snapshot" || streamEvent.type === "done") {
    return streamEvent.results
  }

  if (streamEvent.type === "llm_run_started") {
    return upsertSimulationResultsRun(currentResults, streamEvent.run)
  }

  if (streamEvent.type === "llm_run_updated") {
    return upsertSimulationResultsRun(currentResults, streamEvent.run)
  }

  if (streamEvent.type === "chunk") {
    return appendSimulationResultsRunChunk(
      currentResults,
      streamEvent.llmRunId,
      streamEvent.chunk
    )
  }

  return currentResults
}

export function upsertSimulationResultsRun(
  currentResults: SimulationResultsInfo | null,
  incomingRun: SimulationDebugLlmRun
) {
  if (!currentResults) {
    return currentResults
  }

  if (incomingRun.phase === "opening_hand") {
    const openingHandLlmRuns = upsertRun(
      currentResults.openingHandLlmRuns,
      incomingRun
    ).sort(compareOpeningHandRuns)

    return {
      ...currentResults,
      openingHandLlmRunCount: openingHandLlmRuns.length,
      openingHandLlmRuns,
    }
  }

  if (incomingRun.phase === "turn") {
    const turnLlmRuns = upsertRun(currentResults.turnLlmRuns, incomingRun).sort(
      compareTurnRuns
    )

    return {
      ...currentResults,
      turnLlmRunCount: turnLlmRuns.length,
      turnLlmRuns,
    }
  }

  if (incomingRun.phase === "report") {
    const reportLlmRuns = upsertRun(
      currentResults.reportLlmRuns,
      incomingRun
    ).sort(compareReportRuns)

    return {
      ...currentResults,
      reportLlmRunCount: reportLlmRuns.length,
      reportLlmRuns,
    }
  }

  return currentResults
}

export function appendSimulationResultsRunChunk(
  currentResults: SimulationResultsInfo | null,
  llmRunId: string,
  chunk: SimulationDebugLlmRunChunk
) {
  if (!currentResults) {
    return currentResults
  }

  const openingHandLlmRuns = appendChunkToRuns(
    currentResults.openingHandLlmRuns,
    llmRunId,
    chunk
  )
  const turnLlmRuns = appendChunkToRuns(
    currentResults.turnLlmRuns,
    llmRunId,
    chunk
  )
  const reportLlmRuns = appendChunkToRuns(
    currentResults.reportLlmRuns,
    llmRunId,
    chunk
  )

  if (
    openingHandLlmRuns === currentResults.openingHandLlmRuns &&
    turnLlmRuns === currentResults.turnLlmRuns &&
    reportLlmRuns === currentResults.reportLlmRuns
  ) {
    return currentResults
  }

  return {
    ...currentResults,
    openingHandLlmRuns,
    turnLlmRuns,
    reportLlmRuns,
  }
}

function upsertRun(
  currentRuns: SimulationDebugLlmRun[],
  incomingRun: SimulationDebugLlmRun
) {
  const existingRun = currentRuns.find(
    (run) => run.llmRunId === incomingRun.llmRunId
  )

  if (!existingRun) {
    return [...currentRuns, sortRunChunks(incomingRun)]
  }

  const mergedRun = {
    ...existingRun,
    ...incomingRun,
    openrouterGenerations: mergeOpenRouterGenerations(
      existingRun.openrouterGenerations ?? [],
      incomingRun.openrouterGenerations ?? []
    ),
    chunks: mergeChunks(existingRun.chunks, incomingRun.chunks),
  }

  return currentRuns.map((run) =>
    run.llmRunId === incomingRun.llmRunId ? mergedRun : run
  )
}

function appendChunkToRuns(
  currentRuns: SimulationDebugLlmRun[],
  llmRunId: string,
  chunk: SimulationDebugLlmRunChunk
) {
  const runIndex = currentRuns.findIndex((run) => run.llmRunId === llmRunId)

  if (runIndex === -1) {
    return currentRuns
  }

  return currentRuns.map((run, index) =>
    index === runIndex
      ? {
          ...run,
          chunks: mergeChunks(run.chunks, [chunk]),
        }
      : run
  )
}

function mergeChunks(
  currentChunks: readonly SimulationDebugLlmRunChunk[],
  incomingChunks: readonly SimulationDebugLlmRunChunk[]
) {
  const chunksBySequence = new Map<number, SimulationDebugLlmRunChunk>()

  for (const chunk of currentChunks) {
    chunksBySequence.set(chunk.sequence, chunk)
  }

  for (const chunk of incomingChunks) {
    const existingChunk = chunksBySequence.get(chunk.sequence)

    if (!existingChunk || shouldReplaceChunk(existingChunk, chunk)) {
      chunksBySequence.set(chunk.sequence, chunk)
    }
  }

  return Array.from(chunksBySequence.values()).sort(compareChunks)
}

function mergeOpenRouterGenerations(
  currentGenerations: readonly SimulationOpenRouterGeneration[] = [],
  incomingGenerations: readonly SimulationOpenRouterGeneration[] = []
) {
  const generationsByTurn = new Map<number, SimulationOpenRouterGeneration>()

  for (const generation of currentGenerations) {
    generationsByTurn.set(generation.openrouterTurnIndex, generation)
  }

  for (const generation of incomingGenerations) {
    generationsByTurn.set(generation.openrouterTurnIndex, generation)
  }

  return Array.from(generationsByTurn.values()).sort(
    (firstGeneration, secondGeneration) =>
      firstGeneration.openrouterTurnIndex - secondGeneration.openrouterTurnIndex
  )
}

function shouldReplaceChunk(
  existingChunk: SimulationDebugLlmRunChunk,
  incomingChunk: SimulationDebugLlmRunChunk
) {
  return existingChunk.id === null || incomingChunk.id !== null
}

function sortRunChunks(run: SimulationDebugLlmRun) {
  return {
    ...run,
    openrouterGenerations: mergeOpenRouterGenerations(
      [],
      run.openrouterGenerations ?? []
    ),
    chunks: [...run.chunks].sort(compareChunks),
  }
}

function compareChunks(
  firstChunk: SimulationDebugLlmRunChunk,
  secondChunk: SimulationDebugLlmRunChunk
) {
  return firstChunk.sequence - secondChunk.sequence
}

function compareOpeningHandRuns(
  firstRun: SimulationDebugLlmRun,
  secondRun: SimulationDebugLlmRun
) {
  return firstRun.attemptNumber - secondRun.attemptNumber
}

function compareTurnRuns(
  firstRun: SimulationDebugLlmRun,
  secondRun: SimulationDebugLlmRun
) {
  return (
    (firstRun.turnNumber ?? 0) - (secondRun.turnNumber ?? 0) ||
    firstRun.attemptNumber - secondRun.attemptNumber
  )
}

function compareReportRuns(
  firstRun: SimulationDebugLlmRun,
  secondRun: SimulationDebugLlmRun
) {
  return firstRun.attemptNumber - secondRun.attemptNumber
}

export type Deck = {
  id: string
  name: string
  description: string | null
}

export type DeckCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

export type DeckDetails = Deck & {
  commanders: DeckCard[]
  cards: DeckCard[]
}

export type DecksResponse = {
  decks: Deck[]
}

export type DeckResponse = {
  deck: DeckDetails
}

export type SimulationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type SimulationCreatedVia = "app" | "external_mcp"

export type Simulation = {
  id: string
  deckId: string
  createdVia: SimulationCreatedVia
  startingHandId: string | null
  seed: string
  library: string[]
  turnsToSimulate: number
  completedLlmRunCount: number
  activeLlmRunCount: number
  status: SimulationStatus
  createdAt: string
  updatedAt: string
}

export type SimulationsResponse = {
  simulations: Simulation[]
}

export type CreateSimulationResponse = {
  simulation: Simulation
}

export type CreateOpeningHandLlmRunResponse = {
  simulationId: string
  llmRunId: string
  attemptNumber: number
  runtimeStreamKey: string
  status: string
  createdAt: string
}

export type CreateTurnLlmRunResponse = CreateOpeningHandLlmRunResponse & {
  turnNumber: number
}

export type StopSimulationResponse = {
  simulationId: string
  stoppedLlmRunIds: string[]
  cancelRequestedLlmRunIds: string[]
}

export type SimulationDebugLlmRunChunkCardMention = {
  requestedName: string
  resolutionStatus: "exact" | "face_exact" | "missing"
  resolvedName: string | null
  scryfallUri: string | null
  defaultImageUrl: string | null
}

export type SimulationDebugLlmRunChunk = {
  id: number | null
  sequence: number
  kind: string
  mcpFunctionName: string | null
  mcpFunctionOutput: unknown | null
  reasoningDelta: string | null
  outputDelta: string | null
  payload: unknown
  cardMentions: SimulationDebugLlmRunChunkCardMention[]
  receivedAt: string
}

export type OpenRouterGeneration = {
  openrouterTurnIndex: number
  generationId: string
  createdAt: string
}

export type SimulationDebugLlmRun = {
  llmRunId: string
  phase: string
  provider: string
  model: string
  estimatedPriceCents: string | null
  reasoningEffort: string | null
  status: string
  runtimeStreamKey: string | null
  attemptNumber: number
  createdAt: string
  startedAt: string | null
  completedAt: string | null
  failedAt: string | null
  cancelledAt: string | null
  turnNumber?: number
  gameState?: string
  outdated?: boolean
  openingHandIsValid?: boolean
  openrouterGenerations: OpenRouterGeneration[]
  chunks: SimulationDebugLlmRunChunk[]
}

export type SimulationDebugInfo = {
  simulationId: string
  openingHandLlmRunCount: number
  turnLlmRunCount: number
  openingHandLlmRuns: SimulationDebugLlmRun[]
  turnLlmRuns: SimulationDebugLlmRun[]
}

export type SimulationDebugResponse = {
  debug: SimulationDebugInfo
}

export type OpenRouterGenerationDetailsResponse = {
  generation: OpenRouterGeneration
  providerName: string | null
  providerEntry: unknown | null
  providerSlug: string | null
  result: unknown
}

export type SimulationResultsInfo = SimulationDebugInfo

export type SimulationResultsResponse = {
  results: SimulationResultsInfo
}

export type SimulationResultsStreamEvent =
  | {
      type: "snapshot"
      simulation: Simulation
      results: SimulationResultsInfo
    }
  | {
      type: "llm_run_started"
      run: SimulationDebugLlmRun
    }
  | {
      type: "chunk"
      llmRunId: string
      chunk: SimulationDebugLlmRunChunk
    }
  | {
      type: "llm_run_updated"
      run: SimulationDebugLlmRun
    }
  | {
      type: "simulation_updated"
      simulation: Simulation
    }
  | {
      type: "done"
      simulation: Simulation
      results: SimulationResultsInfo
    }
  | {
      type: "error"
      message: string
    }

export type StartingHandCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

export type StartingHand = {
  id: string
  deckId: string
  name: string
  cards: StartingHandCard[]
  createdAt: string
  updatedAt: string
}

export type StartingHandsResponse = {
  startingHands: StartingHand[]
}

export type CreateStartingHandResponse = {
  startingHand: StartingHand
}

export type SavedSeed = {
  id: string
  deckId: string
  name: string
  seed: string
  createdAt: string
  updatedAt: string
}

export type SavedSeedsResponse = {
  savedSeeds: SavedSeed[]
}

export type CreateSavedSeedResponse = {
  savedSeed: SavedSeed
}

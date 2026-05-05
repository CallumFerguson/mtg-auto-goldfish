import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
  type UIEvent,
} from "react"
import {
  Bug,
  Dices,
  Eye,
  EyeOff,
  LoaderCircle,
  MoreVertical,
  Plus,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type {
  CreateSavedSeedResponse,
  CreateSimulationResponse,
  CreateStartingHandResponse,
  DeckCard,
  OpenRouterGenerationDetailsResponse,
  SavedSeed,
  SavedSeedsResponse,
  Simulation,
  SimulationDebugInfo,
  SimulationDebugLlmRun,
  SimulationDebugLlmRunChunk,
  SimulationResultsInfo,
  SimulationResultsStreamEvent,
  SimulationsResponse,
  SimulationDebugResponse,
  StartingHand,
  StartingHandsResponse,
  StopSimulationResponse,
} from "@/lib/deck-types"
import { getDeckSimulationPath, navigateTo } from "@/lib/navigation"
import {
  getSimulationFinalParsedOutput,
  getSimulationFinalParsedOutputFromPayload,
  type ParsedSimulationFinalOutput,
} from "@/lib/simulation-final-output"
import {
  formatDebugChunkBlocks,
  getDebugChunkBlockId,
  getDebugDeltaChunkLabel,
} from "@/lib/simulation-debug-chunks"
import { applySimulationResultsStreamEvent } from "@/lib/simulation-results-stream"
import {
  getLoggedTurnAction,
  getSimulationRunActiveToolCallName,
  getSimulationResultEntries,
  getSimulationRunThinkingPreview,
  hasSimulationRunFinalParsedOutputChunk,
  type SimulationResultEntry,
} from "@/lib/simulation-result-chunks"
import {
  getKnownSimulationResultToolLabel,
  getKnownSimulationResultToolLabelForChunk,
} from "@/lib/simulation-result-tool-labels"

type OpeningHandCardOption = {
  id: string
  deckCardId: number
  name: string
}

type SimulationResultsAction =
  | {
      kind: "opening_hand"
    }
  | {
      kind: "turn"
      turnNumber: number
    }

function getSimulationLabel(simulation: Simulation) {
  return `${simulation.id.slice(0, 8)} - ${simulation.completedLlmRunCount} runs`
}

function getSimulationRunCountFromResults(resultsInfo: SimulationResultsInfo) {
  return (
    getCurrentOpeningHandRunCount(resultsInfo) +
    resultsInfo.turnLlmRuns.filter(isCountedTurnRun).length
  )
}

function getActiveLlmRunCountFromResults(resultsInfo: SimulationResultsInfo) {
  return [...resultsInfo.openingHandLlmRuns, ...resultsInfo.turnLlmRuns].filter(
    (run) => isActiveLlmRunStatus(run.status)
  ).length
}

function isActiveLlmRunStatus(status: string) {
  return (
    status === "pending" ||
    status === "streaming" ||
    status === "cancel_requested"
  )
}

function getSimulationRunStartTimeMs(run: SimulationDebugLlmRun) {
  return parseTimestampMs(run.startedAt) ?? parseTimestampMs(run.createdAt)
}

function getSimulationRunFinishedTimeMs(run: SimulationDebugLlmRun) {
  return (
    parseTimestampMs(run.completedAt) ??
    parseTimestampMs(run.failedAt) ??
    parseTimestampMs(run.cancelledAt)
  )
}

function getSimulationRunFinishedDurationText(run: SimulationDebugLlmRun) {
  const startTimeMs = getSimulationRunStartTimeMs(run)
  const finishedTimeMs = getSimulationRunFinishedTimeMs(run)

  if (startTimeMs === null || finishedTimeMs === null) {
    return null
  }

  return formatMinutesSeconds(finishedTimeMs - startTimeMs)
}

function parseTimestampMs(timestamp: string | null | undefined) {
  if (!timestamp) {
    return null
  }

  const timeMs = Date.parse(timestamp)

  return Number.isNaN(timeMs) ? null : timeMs
}

function formatMinutesSeconds(durationMs: number) {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (minutes === 0) {
    return `${seconds}s`
  }

  return `${minutes}m ${String(seconds).padStart(2, "0")}s`
}

function getCurrentOpeningHandRunCount(resultsInfo: SimulationResultsInfo) {
  const maxAttemptNumber = Math.max(
    0,
    ...resultsInfo.openingHandLlmRuns.map((run) => run.attemptNumber)
  )

  return resultsInfo.openingHandLlmRuns.filter(
    (run) =>
      run.attemptNumber === maxAttemptNumber && isCountedOpeningHandRun(run)
  ).length
}

function isCountedOpeningHandRun(
  run: SimulationResultsInfo["openingHandLlmRuns"][number]
) {
  return (
    isActiveLlmRunStatus(run.status) ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    (run.status === "completed" && run.openingHandIsValid === true)
  )
}

function isCountedTurnRun(run: SimulationResultsInfo["turnLlmRuns"][number]) {
  return (
    run.outdated !== true &&
    (isActiveLlmRunStatus(run.status) ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      (run.status === "completed" && Boolean(run.gameState?.trim())))
  )
}

function isSuccessfulOpeningHandRun(
  run: SimulationResultsInfo["openingHandLlmRuns"][number]
) {
  return run.status === "completed" && run.openingHandIsValid === true
}

function isSuccessfulTurnRun(
  run: SimulationResultsInfo["turnLlmRuns"][number]
) {
  return (
    run.status === "completed" &&
    run.outdated !== true &&
    Boolean(run.gameState?.trim())
  )
}

function getRandomDigit(maxExclusive: number) {
  const maxUnbiasedValue = 256 - (256 % maxExclusive)
  const randomBytes = new Uint8Array(1)

  do {
    crypto.getRandomValues(randomBytes)
  } while (randomBytes[0] >= maxUnbiasedValue)

  return randomBytes[0] % maxExclusive
}

function createRandomSimulationSeed() {
  const digits = [String(getRandomDigit(9) + 1)]

  for (let digitIndex = 1; digitIndex < 20; digitIndex += 1) {
    digits.push(String(getRandomDigit(10)))
  }

  return digits.join("")
}

function getOpeningHandCardOptions(
  cards: readonly DeckCard[]
): OpeningHandCardOption[] {
  return cards
    .flatMap((card) =>
      Array.from({ length: card.quantity }, (_, copyIndex) => ({
        id: `${card.deckCardId}-${copyIndex}`,
        deckCardId: card.deckCardId,
        name: card.name,
      }))
    )
    .sort((firstCard, secondCard) =>
      firstCard.name.localeCompare(secondCard.name)
    )
}

export function DeckSimulation({
  cards,
  deckId,
  selectedSimulationIdFromUrl,
}: {
  cards: DeckCard[]
  deckId: string
  selectedSimulationIdFromUrl: string | null
}) {
  const [simulations, setSimulations] = useState<Simulation[]>([])
  const [isLoadingSimulations, setIsLoadingSimulations] = useState(true)
  const [startingHands, setStartingHands] = useState<StartingHand[]>([])
  const [isLoadingStartingHands, setIsLoadingStartingHands] = useState(true)
  const [startingHandLoadError, setStartingHandLoadError] = useState<
    string | null
  >(null)
  const [savedSeeds, setSavedSeeds] = useState<SavedSeed[]>([])
  const [isLoadingSavedSeeds, setIsLoadingSavedSeeds] = useState(true)
  const [savedSeedLoadError, setSavedSeedLoadError] = useState<string | null>(
    null
  )
  const [simulationLoadError, setSimulationLoadError] = useState<string | null>(
    null
  )
  const [isNewSimulationSelected, setIsNewSimulationSelected] = useState(true)
  const [selectedSimulationId, setSelectedSimulationId] = useState("")
  const [seedMode, setSeedMode] = useState<"random" | "set">("random")
  const [selectedSavedSeedId, setSelectedSavedSeedId] = useState("")
  const [turnsToSimulate, setTurnsToSimulate] = useState("5")
  const [openingHandMode, setOpeningHandMode] = useState<
    "simulate" | "provide"
  >("simulate")
  const [selectedOpeningHandId, setSelectedOpeningHandId] = useState("")
  const [isCreateHandModalOpen, setIsCreateHandModalOpen] = useState(false)
  const [isCreateSeedModalOpen, setIsCreateSeedModalOpen] = useState(false)
  const [createSimulationError, setCreateSimulationError] = useState<
    string | null
  >(null)
  const [isCreatingSimulation, setIsCreatingSimulation] = useState(false)
  const [openSimulationMenuId, setOpenSimulationMenuId] = useState<
    string | null
  >(null)
  const [detailsSimulationId, setDetailsSimulationId] = useState<string | null>(
    null
  )
  const [deletingSimulationId, setDeletingSimulationId] = useState<
    string | null
  >(null)
  const [isSimulationListScrolled, setIsSimulationListScrolled] =
    useState(false)
  const openingHandCardOptions = useMemo(
    () => getOpeningHandCardOptions(cards),
    [cards]
  )
  const selectedOpeningHand = useMemo(
    () =>
      startingHands.find((hand) => hand.id === selectedOpeningHandId) ?? null,
    [startingHands, selectedOpeningHandId]
  )
  const selectedSavedSeed = useMemo(
    () => savedSeeds.find((seed) => seed.id === selectedSavedSeedId) ?? null,
    [savedSeeds, selectedSavedSeedId]
  )
  const selectedSimulation = useMemo(
    () =>
      simulations.find(
        (simulation) => simulation.id === selectedSimulationId
      ) ?? null,
    [selectedSimulationId, simulations]
  )
  const detailsSimulation = useMemo(
    () =>
      simulations.find((simulation) => simulation.id === detailsSimulationId) ??
      null,
    [detailsSimulationId, simulations]
  )
  const detailsSimulationStartingHand = useMemo(
    () =>
      startingHands.find(
        (hand) => hand.id === detailsSimulation?.startingHandId
      ) ?? null,
    [detailsSimulation?.startingHandId, startingHands]
  )
  const selectedSimulationStartingHand = useMemo(
    () =>
      startingHands.find(
        (hand) => hand.id === selectedSimulation?.startingHandId
      ) ?? null,
    [selectedSimulation?.startingHandId, startingHands]
  )
  const canStartSimulation =
    (seedMode === "random" || Boolean(selectedSavedSeed)) &&
    turnsToSimulate.length > 0 &&
    (openingHandMode !== "provide" || Boolean(selectedOpeningHand))

  const loadSimulations = useCallback(
    async (options?: { silent?: boolean }) => {
      const isSilent = options?.silent ?? false

      if (!isSilent) {
        setIsLoadingSimulations(true)
        setSimulationLoadError(null)
      }

      try {
        const response = await fetch(
          `${API_BASE_URL}/decks/${deckId}/simulations`
        )

        if (!response.ok) {
          setSimulationLoadError(
            await readApiError(response, "Simulations could not be loaded.")
          )
          return []
        }

        const data = (await response.json()) as SimulationsResponse
        setSimulations(data.simulations)
        return data.simulations
      } catch {
        setSimulationLoadError("Simulations could not be loaded.")
        return []
      } finally {
        if (!isSilent) {
          setIsLoadingSimulations(false)
        }
      }
    },
    [deckId]
  )

  const updateSimulation = useCallback((updatedSimulation: Simulation) => {
    setSimulations((currentSimulations) => {
      const hasSimulation = currentSimulations.some(
        (simulation) => simulation.id === updatedSimulation.id
      )

      if (!hasSimulation) {
        return [updatedSimulation, ...currentSimulations]
      }

      return currentSimulations.map((simulation) =>
        simulation.id === updatedSimulation.id ? updatedSimulation : simulation
      )
    })
  }, [])

  const loadStartingHands = useCallback(async () => {
    setIsLoadingStartingHands(true)
    setStartingHandLoadError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/starting-hands`
      )

      if (!response.ok) {
        setStartingHandLoadError(
          await readApiError(response, "Starting hands could not be loaded.")
        )
        return
      }

      const data = (await response.json()) as StartingHandsResponse
      setStartingHands(data.startingHands)
      setSelectedOpeningHandId((currentStartingHandId) => {
        if (
          currentStartingHandId &&
          data.startingHands.some((hand) => hand.id === currentStartingHandId)
        ) {
          return currentStartingHandId
        }

        return data.startingHands[0]?.id ?? ""
      })
    } catch {
      setStartingHandLoadError("Starting hands could not be loaded.")
    } finally {
      setIsLoadingStartingHands(false)
    }
  }, [deckId])

  const loadSavedSeeds = useCallback(async () => {
    setIsLoadingSavedSeeds(true)
    setSavedSeedLoadError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/saved-seeds`
      )

      if (!response.ok) {
        setSavedSeedLoadError(
          await readApiError(response, "Saved seeds could not be loaded.")
        )
        return
      }

      const data = (await response.json()) as SavedSeedsResponse
      setSavedSeeds(data.savedSeeds)
      setSelectedSavedSeedId((currentSavedSeedId) => {
        if (
          currentSavedSeedId &&
          data.savedSeeds.some((seed) => seed.id === currentSavedSeedId)
        ) {
          return currentSavedSeedId
        }

        return data.savedSeeds[0]?.id ?? ""
      })
    } catch {
      setSavedSeedLoadError("Saved seeds could not be loaded.")
    } finally {
      setIsLoadingSavedSeeds(false)
    }
  }, [deckId])

  useEffect(() => {
    void loadSimulations()
  }, [loadSimulations])

  useEffect(() => {
    if (!simulations.some((simulation) => simulation.activeLlmRunCount > 0)) {
      return
    }

    let isCancelled = false
    let timeoutId: number | undefined

    async function refreshActiveSimulations() {
      const refreshedSimulations = await loadSimulations({ silent: true })

      if (
        isCancelled ||
        !refreshedSimulations.some(
          (simulation) => simulation.activeLlmRunCount > 0
        )
      ) {
        return
      }

      timeoutId = window.setTimeout(refreshActiveSimulations, 1000)
    }

    timeoutId = window.setTimeout(refreshActiveSimulations, 1000)

    return () => {
      isCancelled = true

      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId)
      }
    }
  }, [loadSimulations, simulations])

  useEffect(() => {
    void loadStartingHands()
  }, [loadStartingHands])

  useEffect(() => {
    void loadSavedSeeds()
  }, [loadSavedSeeds])

  useEffect(() => {
    if (selectedSimulationIdFromUrl) {
      setSelectedSimulationId(selectedSimulationIdFromUrl)
      setIsNewSimulationSelected(false)
      return
    }

    setSelectedSimulationId("")
    setIsNewSimulationSelected(true)
  }, [selectedSimulationIdFromUrl])

  function selectCreatedStartingHand(hand: StartingHand) {
    setStartingHands((currentStartingHands) => [hand, ...currentStartingHands])
    setSelectedOpeningHandId(hand.id)
    setOpeningHandMode("provide")
    setIsCreateHandModalOpen(false)
  }

  function selectCreatedSavedSeed(seed: SavedSeed) {
    setSavedSeeds((currentSavedSeeds) => [seed, ...currentSavedSeeds])
    setSelectedSavedSeedId(seed.id)
    setSeedMode("set")
    setIsCreateSeedModalOpen(false)
  }

  function resetCreateSimulationForm() {
    setSeedMode("random")
    setSelectedSavedSeedId(savedSeeds[0]?.id ?? "")
    setTurnsToSimulate("5")
    setOpeningHandMode("simulate")
    setSelectedOpeningHandId(startingHands[0]?.id ?? "")
  }

  async function handleStartSimulation() {
    if (!canStartSimulation || isCreatingSimulation) {
      return
    }

    const parsedTurnsToSimulate = Number(turnsToSimulate)

    if (!Number.isInteger(parsedTurnsToSimulate) || parsedTurnsToSimulate < 0) {
      setCreateSimulationError(
        "Turns to simulate must be a non-negative integer."
      )
      return
    }

    setCreateSimulationError(null)
    setIsCreatingSimulation(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            seed:
              seedMode === "random"
                ? createRandomSimulationSeed()
                : selectedSavedSeed?.seed,
            turnsToSimulate: parsedTurnsToSimulate,
            startingHandId:
              openingHandMode === "provide" && selectedOpeningHand
                ? selectedOpeningHand.id
                : null,
          }),
        }
      )

      if (!response.ok) {
        setCreateSimulationError(
          await readApiError(response, "Simulation could not be saved.")
        )
        return
      }

      const data = (await response.json()) as CreateSimulationResponse
      const refreshedSimulations = await loadSimulations()

      if (
        refreshedSimulations.some(
          (simulation) => simulation.id === data.simulation.id
        )
      ) {
        setSelectedSimulationId(data.simulation.id)
      } else {
        setSimulations((currentSimulations) => [
          data.simulation,
          ...currentSimulations,
        ])
        setSimulationLoadError(null)
        setSelectedSimulationId(data.simulation.id)
      }

      setIsNewSimulationSelected(false)
      resetCreateSimulationForm()
      navigateTo(getDeckSimulationPath(deckId, data.simulation.id))
    } catch {
      setCreateSimulationError("Simulation could not be sent to the server.")
    } finally {
      setIsCreatingSimulation(false)
    }
  }

  async function handleDeleteSimulation(simulationId: string) {
    if (deletingSimulationId) {
      return
    }

    setDeletingSimulationId(simulationId)
    setSimulationLoadError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulationId}`,
        {
          method: "DELETE",
        }
      )

      if (!response.ok) {
        setSimulationLoadError(
          await readApiError(response, "Simulation could not be deleted.")
        )
        return
      }

      setSimulations((currentSimulations) =>
        currentSimulations.filter(
          (simulation) => simulation.id !== simulationId
        )
      )
      setOpenSimulationMenuId(null)
      setDetailsSimulationId((currentSimulationId) =>
        currentSimulationId === simulationId ? null : currentSimulationId
      )

      if (!isNewSimulationSelected && selectedSimulationId === simulationId) {
        setSelectedSimulationId("")
        setIsNewSimulationSelected(true)
        navigateTo(getDeckSimulationPath(deckId))
      }
    } catch {
      setSimulationLoadError("Simulation could not be deleted.")
    } finally {
      setDeletingSimulationId(null)
    }
  }

  return (
    <>
      <div className="grid h-full min-h-0 min-w-[56rem] grid-cols-[18rem_minmax(0,1fr)] overflow-hidden">
        <aside className="simulation-sidebar-surface min-h-0 min-w-0 border-r border-border">
          <nav
            className="simulation-scrollbar h-full overflow-y-auto"
            aria-label="Simulations"
            onScroll={(event) =>
              setIsSimulationListScrolled(event.currentTarget.scrollTop > 0)
            }
          >
            <div className="simulation-sidebar-surface sticky top-0 z-10 px-2 pt-2 pb-1">
              <button
                className={`flex h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-medium transition-colors ${
                  isNewSimulationSelected
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                }`}
                type="button"
                aria-pressed={isNewSimulationSelected}
                onClick={() => {
                  setIsNewSimulationSelected(true)
                  setSelectedSimulationId("")
                  navigateTo(getDeckSimulationPath(deckId))
                }}
              >
                <Plus className="size-4" data-icon="inline-start" />
                New simulation
              </button>
              <div
                className={`absolute right-0 bottom-0 left-0 border-b border-border transition-opacity ${
                  isSimulationListScrolled ? "opacity-100" : "opacity-0"
                }`}
              />
            </div>

            <div className="px-2 pb-2">
              {isLoadingSimulations ? (
                <div className="rounded-md px-3 py-3 text-sm text-muted-foreground">
                  Loading simulations...
                </div>
              ) : simulationLoadError ? (
                <div className="grid gap-3 rounded-md px-3 py-3">
                  <p className="text-sm text-destructive">
                    {simulationLoadError}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void loadSimulations()}
                  >
                    <RefreshCw data-icon="inline-start" />
                    Try again
                  </Button>
                </div>
              ) : simulations.length > 0 ? (
                <ul className="grid gap-1">
                  {simulations.map((simulation) => (
                    <li key={simulation.id} className="group relative">
                      <button
                        className={`h-11 w-full rounded-md pr-11 pl-3 text-left text-sm font-medium transition-colors ${
                          !isNewSimulationSelected &&
                          selectedSimulationId === simulation.id
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                        }`}
                        type="button"
                        aria-pressed={
                          !isNewSimulationSelected &&
                          selectedSimulationId === simulation.id
                        }
                        onClick={() => {
                          setSelectedSimulationId(simulation.id)
                          setIsNewSimulationSelected(false)
                          navigateTo(
                            getDeckSimulationPath(deckId, simulation.id)
                          )
                        }}
                      >
                        {getSimulationLabel(simulation)}
                      </button>
                      {simulation.activeLlmRunCount > 0 &&
                      (isNewSimulationSelected ||
                        selectedSimulationId !== simulation.id) ? (
                        <div
                          className={`pointer-events-none absolute inset-y-0 right-1 flex items-center px-2 text-muted-foreground transition-opacity group-hover:opacity-0 ${
                            openSimulationMenuId === simulation.id
                              ? "opacity-0"
                              : "opacity-100"
                          }`}
                          aria-hidden="true"
                        >
                          <svg
                            className="size-[1.2rem] animate-spin text-sky-400"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeLinecap="round"
                            strokeWidth="1.6"
                          >
                            <circle
                              cx="12"
                              cy="12"
                              r="9"
                              className="text-muted-foreground/35"
                            />
                            <path d="M12 3 A9 9 0 1 1 3.65 15.37" />
                          </svg>
                        </div>
                      ) : null}
                      <div
                        className={`absolute inset-y-0 right-1 flex items-center opacity-0 transition-opacity group-hover:opacity-100 ${
                          openSimulationMenuId === simulation.id
                            ? "opacity-100"
                            : ""
                        }`}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Open actions for simulation ${getSimulationLabel(
                            simulation
                          )}`}
                          aria-expanded={openSimulationMenuId === simulation.id}
                          title="Simulation actions"
                          disabled={deletingSimulationId === simulation.id}
                          onClick={() =>
                            setOpenSimulationMenuId((currentSimulationId) =>
                              currentSimulationId === simulation.id
                                ? null
                                : simulation.id
                            )
                          }
                        >
                          <MoreVertical />
                        </Button>

                        {openSimulationMenuId === simulation.id ? (
                          <>
                            <button
                              className="fixed inset-0 z-10 cursor-default"
                              type="button"
                              aria-label="Close simulation actions"
                              onClick={() => setOpenSimulationMenuId(null)}
                            />
                            <div className="absolute top-9 right-0 z-20 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40">
                              <SimulationMenuButton
                                onClick={() => {
                                  setOpenSimulationMenuId(null)
                                  setDetailsSimulationId(simulation.id)
                                }}
                              >
                                <Eye data-icon="inline-start" />
                                View details
                              </SimulationMenuButton>
                              <SimulationMenuButton
                                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                                onClick={() =>
                                  void handleDeleteSimulation(simulation.id)
                                }
                              >
                                <Trash2 data-icon="inline-start" />
                                {deletingSimulationId === simulation.id
                                  ? "Deleting..."
                                  : "Delete simulation"}
                              </SimulationMenuButton>
                            </div>
                          </>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="rounded-md px-3 py-3 text-sm text-muted-foreground">
                  No simulations yet.
                </div>
              )}
            </div>
          </nav>
        </aside>

        <section className="simulation-scrollbar min-h-0 min-w-0 overflow-y-auto">
          {isNewSimulationSelected ? (
            <div className="grid flex-1 place-items-center px-5 py-10">
              <div className="grid w-full max-w-2xl gap-4">
                <h3 className="text-center text-lg font-semibold">
                  Create new simulation
                </h3>
                <div className="flex flex-col gap-6 rounded-lg border border-border bg-card/70 p-6 shadow-sm">
                  <div className="grid gap-6">
                    <fieldset className="grid gap-3">
                      <legend className="text-sm font-medium text-foreground">
                        Simulation seed
                      </legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label
                          className={`flex items-center gap-2 rounded-md border px-3 py-3 text-sm transition-colors ${
                            seedMode === "random"
                              ? "border-ring bg-accent text-accent-foreground"
                              : "border-border bg-background/35 text-muted-foreground"
                          }`}
                        >
                          <input
                            className="size-4 accent-sky-300"
                            type="radio"
                            name="seed-mode"
                            checked={seedMode === "random"}
                            onChange={() => setSeedMode("random")}
                          />
                          Random seed
                        </label>
                        <label
                          className={`flex items-center gap-2 rounded-md border px-3 py-3 text-sm transition-colors ${
                            seedMode === "set"
                              ? "border-ring bg-accent text-accent-foreground"
                              : "border-border bg-background/35 text-muted-foreground"
                          }`}
                        >
                          <input
                            className="size-4 accent-sky-300"
                            type="radio"
                            name="seed-mode"
                            checked={seedMode === "set"}
                            onChange={() => setSeedMode("set")}
                          />
                          Set seed
                        </label>
                      </div>

                      {seedMode === "set" ? (
                        <div className="grid gap-3 rounded-md border border-border bg-background/35 p-3">
                          {savedSeedLoadError ? (
                            <div className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                              <p className="text-sm text-destructive">
                                {savedSeedLoadError}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void loadSavedSeeds()}
                              >
                                <RefreshCw data-icon="inline-start" />
                                Try again
                              </Button>
                            </div>
                          ) : null}

                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                            <label
                              className="grid gap-2 text-sm font-medium"
                              htmlFor="saved-seed"
                            >
                              <span>Saved seed</span>
                              <select
                                id="saved-seed"
                                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors outline-none focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                                value={selectedSavedSeedId}
                                disabled={
                                  isLoadingSavedSeeds || savedSeeds.length === 0
                                }
                                onChange={(event) =>
                                  setSelectedSavedSeedId(event.target.value)
                                }
                              >
                                {isLoadingSavedSeeds ? (
                                  <option value="">
                                    Loading saved seeds...
                                  </option>
                                ) : savedSeeds.length === 0 ? (
                                  <option value="">No saved seeds yet</option>
                                ) : null}
                                {savedSeeds.map((seed) => (
                                  <option key={seed.id} value={seed.id}>
                                    {seed.name}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setIsCreateSeedModalOpen(true)}
                            >
                              <Plus data-icon="inline-start" />
                              New seed
                            </Button>
                          </div>

                          {selectedSavedSeed ? (
                            <dl className="grid gap-1 text-sm">
                              <dt className="text-muted-foreground">
                                Seed value
                              </dt>
                              <dd className="rounded-md bg-muted/30 px-3 py-2 font-medium break-all text-foreground">
                                {selectedSavedSeed.seed}
                              </dd>
                            </dl>
                          ) : !isLoadingSavedSeeds ? (
                            <p className="text-sm text-muted-foreground">
                              Choose a saved seed, or make a new one.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </fieldset>

                    <div className="grid gap-3">
                      <label
                        className="text-sm font-medium text-foreground"
                        htmlFor="turns-to-simulate"
                      >
                        Turns to simulate
                      </label>
                      <select
                        id="turns-to-simulate"
                        className="no-number-spinner h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 sm:max-w-36"
                        value={turnsToSimulate}
                        onChange={(event) =>
                          setTurnsToSimulate(event.target.value)
                        }
                      >
                        {Array.from({ length: 11 }, (_, turnCount) => (
                          <option key={turnCount} value={turnCount}>
                            {turnCount}
                          </option>
                        ))}
                      </select>
                    </div>

                    <fieldset className="grid gap-3">
                      <legend className="text-sm font-medium text-foreground">
                        Opening hand
                      </legend>
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label
                          className={`flex items-center gap-2 rounded-md border px-3 py-3 text-sm transition-colors ${
                            openingHandMode === "simulate"
                              ? "border-ring bg-accent text-accent-foreground"
                              : "border-border bg-background/35 text-muted-foreground"
                          }`}
                        >
                          <input
                            className="size-4 accent-sky-300"
                            type="radio"
                            name="opening-hand-mode"
                            checked={openingHandMode === "simulate"}
                            onChange={() => setOpeningHandMode("simulate")}
                          />
                          Simulate opening hand
                        </label>
                        <label
                          className={`flex items-center gap-2 rounded-md border px-3 py-3 text-sm transition-colors ${
                            openingHandMode === "provide"
                              ? "border-ring bg-accent text-accent-foreground"
                              : "border-border bg-background/35 text-muted-foreground"
                          }`}
                        >
                          <input
                            className="size-4 accent-sky-300"
                            type="radio"
                            name="opening-hand-mode"
                            checked={openingHandMode === "provide"}
                            onChange={() => setOpeningHandMode("provide")}
                          />
                          Provide opening hand
                        </label>
                      </div>

                      {openingHandMode === "provide" ? (
                        <div className="grid gap-3 rounded-md border border-border bg-background/35 p-3">
                          {startingHandLoadError ? (
                            <div className="grid gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                              <p className="text-sm text-destructive">
                                {startingHandLoadError}
                              </p>
                              <Button
                                type="button"
                                variant="outline"
                                onClick={() => void loadStartingHands()}
                              >
                                <RefreshCw data-icon="inline-start" />
                                Try again
                              </Button>
                            </div>
                          ) : null}

                          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                            <label
                              className="grid gap-2 text-sm font-medium"
                              htmlFor="saved-opening-hand"
                            >
                              <span>Starting hand</span>
                              <select
                                id="saved-opening-hand"
                                className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors outline-none focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                                value={selectedOpeningHandId}
                                disabled={
                                  isLoadingStartingHands ||
                                  startingHands.length === 0
                                }
                                onChange={(event) =>
                                  setSelectedOpeningHandId(event.target.value)
                                }
                              >
                                {isLoadingStartingHands ? (
                                  <option value="">
                                    Loading starting hands...
                                  </option>
                                ) : startingHands.length === 0 ? (
                                  <option value="">
                                    No starting hands yet
                                  </option>
                                ) : null}
                                {startingHands.map((hand) => (
                                  <option key={hand.id} value={hand.id}>
                                    {hand.name}
                                  </option>
                                ))}
                              </select>
                            </label>

                            <Button
                              type="button"
                              variant="outline"
                              onClick={() => setIsCreateHandModalOpen(true)}
                            >
                              <Plus data-icon="inline-start" />
                              New starting hand
                            </Button>
                          </div>

                          {selectedOpeningHand ? (
                            <div className="grid gap-2">
                              <p className="text-sm text-sky-300">
                                {countStartingHandCards(selectedOpeningHand)}{" "}
                                cards selected
                              </p>
                              <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                                {selectedOpeningHand.cards.map((card) => (
                                  <li
                                    key={card.deckCardId}
                                    className="rounded-md bg-muted/30 px-3 py-2"
                                  >
                                    {card.quantity > 1 ? (
                                      <span className="mr-2 text-sky-300">
                                        {card.quantity}x
                                      </span>
                                    ) : null}
                                    {card.name}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : !isLoadingStartingHands ? (
                            <p className="text-sm text-muted-foreground">
                              Choose a saved starting hand, or make a new one.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </fieldset>
                  </div>

                  <div>
                    <Button
                      type="button"
                      disabled={!canStartSimulation || isCreatingSimulation}
                      onClick={() => void handleStartSimulation()}
                    >
                      <Dices data-icon="inline-start" />
                      {isCreatingSimulation
                        ? "Creating..."
                        : "Start simulation"}
                    </Button>
                  </div>

                  {createSimulationError ? (
                    <p
                      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                      role="alert"
                    >
                      {createSimulationError}
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          ) : selectedSimulation ? (
            <SimulationDetails
              deckId={deckId}
              isLoadingStartingHand={isLoadingStartingHands}
              onSimulationUpdated={updateSimulation}
              simulation={selectedSimulation}
              startingHand={selectedSimulationStartingHand}
              startingHandLoadError={startingHandLoadError}
            />
          ) : (
            <EmptySimulationSelection />
          )}
        </section>
      </div>

      {isCreateHandModalOpen ? (
        <CreateStartingHandModal
          cardOptions={openingHandCardOptions}
          deckId={deckId}
          onClose={() => setIsCreateHandModalOpen(false)}
          onSaved={selectCreatedStartingHand}
        />
      ) : null}

      {isCreateSeedModalOpen ? (
        <CreateSavedSeedModal
          deckId={deckId}
          onClose={() => setIsCreateSeedModalOpen(false)}
          onSaved={selectCreatedSavedSeed}
        />
      ) : null}

      {detailsSimulation ? (
        <SimulationDetailsModal
          deckId={deckId}
          onClose={() => setDetailsSimulationId(null)}
          simulation={detailsSimulation}
          startingHand={detailsSimulationStartingHand}
        />
      ) : null}
    </>
  )
}

function SimulationMenuButton({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode
  className?: string
  onClick: () => void
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none ${className}`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function SimulationDetailsModal({
  deckId,
  onClose,
  simulation,
  startingHand,
}: {
  deckId: string
  onClose: () => void
  simulation: Simulation
  startingHand: StartingHand | null
}) {
  const [isLoadingDebugInfo, setIsLoadingDebugInfo] = useState(false)
  const [debugInfoError, setDebugInfoError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<SimulationDebugInfo | null>(null)
  const [isDebugModalOpen, setIsDebugModalOpen] = useState(false)
  const isLoadingDebugInfoRef = useRef(false)
  const shouldSimulateOpeningHand = simulation.startingHandId === null

  const handleRefreshDebugInfo = useCallback(async () => {
    if (isLoadingDebugInfoRef.current) {
      return
    }

    isLoadingDebugInfoRef.current = true
    setIsLoadingDebugInfo(true)
    setDebugInfoError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/debug`
      )

      if (!response.ok) {
        setDebugInfoError(
          await readApiError(
            response,
            "Simulation debug info could not be loaded."
          )
        )
        return
      }

      const data = (await response.json()) as SimulationDebugResponse
      setDebugInfo(data.debug)
    } catch {
      setDebugInfoError("Simulation debug info could not be loaded.")
    } finally {
      isLoadingDebugInfoRef.current = false
      setIsLoadingDebugInfo(false)
    }
  }, [deckId, simulation.id])

  useEffect(() => {
    setDebugInfo(null)
    setDebugInfoError(null)
    setIsLoadingDebugInfo(false)
    isLoadingDebugInfoRef.current = false
  }, [simulation.id])

  useEffect(() => {
    if (!isDebugModalOpen) {
      return
    }

    void handleRefreshDebugInfo()
  }, [handleRefreshDebugInfo, isDebugModalOpen])

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
        role="presentation"
        onMouseDown={onClose}
      >
        <section
          aria-labelledby="simulation-details-title"
          className="flex max-h-[calc(100svh-3rem)] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <h2
                  id="simulation-details-title"
                  className="text-xl font-semibold"
                >
                  Simulation details
                </h2>
                <span className="shrink-0 rounded-md border border-border bg-background/45 px-3 py-1 text-sm text-muted-foreground">
                  {simulation.status}
                </span>
              </div>
              <p className="text-sm font-medium break-all text-foreground">
                {simulation.id}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X />
            </Button>
          </header>

          <div className="simulation-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <section className="grid gap-3">
              <h3 className="text-sm font-semibold text-foreground">Setup</h3>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-md border border-border bg-background/35 p-3 sm:col-span-2">
                  <dt className="text-muted-foreground">Seed</dt>
                  <dd className="mt-1 font-medium break-all text-foreground">
                    {simulation.seed}
                  </dd>
                </div>
                <div className="rounded-md border border-border bg-background/35 p-3">
                  <dt className="text-muted-foreground">Turns to simulate</dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {simulation.turnsToSimulate}
                  </dd>
                </div>
                <div className="rounded-md border border-border bg-background/35 p-3">
                  <dt className="text-muted-foreground">
                    Simulate opening hand
                  </dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {shouldSimulateOpeningHand ? "Yes" : "No"}
                  </dd>
                </div>
              </dl>

              {!shouldSimulateOpeningHand ? (
                <div className="grid gap-2 rounded-md border border-border bg-background/35 p-3">
                  <p className="text-sm font-medium text-foreground">
                    Provided opening hand
                    {startingHand ? (
                      <span className="ml-2 text-muted-foreground">
                        {startingHand.name}
                      </span>
                    ) : null}
                  </p>
                  {startingHand ? (
                    <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
                      {startingHand.cards.map((card) => (
                        <li
                          key={card.deckCardId}
                          className="rounded-md bg-muted/30 px-3 py-2"
                        >
                          {card.quantity > 1 ? (
                            <span className="mr-2 text-sky-300">
                              {card.quantity}x
                            </span>
                          ) : null}
                          {card.name}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Opening hand details are loading.
                    </p>
                  )}
                </div>
              ) : null}
            </section>
          </div>

          <footer className="flex justify-end border-t border-border px-5 py-4">
            <Button
              className="w-fit"
              type="button"
              variant="outline"
              onClick={() => setIsDebugModalOpen(true)}
            >
              <Bug data-icon="inline-start" />
              View debug info
            </Button>
          </footer>
        </section>
      </div>

      {isDebugModalOpen ? (
        <SimulationDebugModal
          deckId={deckId}
          debugInfo={debugInfo}
          error={debugInfoError}
          isLoading={isLoadingDebugInfo}
          onClose={() => setIsDebugModalOpen(false)}
          onRefresh={() => void handleRefreshDebugInfo()}
          simulationId={simulation.id}
        />
      ) : null}
    </>
  )
}

function SimulationDetails({
  deckId,
  isLoadingStartingHand,
  onSimulationUpdated,
  simulation,
  startingHand,
  startingHandLoadError,
}: {
  deckId: string
  isLoadingStartingHand: boolean
  onSimulationUpdated: (simulation: Simulation) => void
  simulation: Simulation
  startingHand: StartingHand | null
  startingHandLoadError: string | null
}) {
  const [isStartingOpeningHandRun, setIsStartingOpeningHandRun] =
    useState(false)
  const [openingHandRunError, setOpeningHandRunError] = useState<string | null>(
    null
  )
  const [isStartingTurnRun, setIsStartingTurnRun] = useState(false)
  const [turnRunError, setTurnRunError] = useState<string | null>(null)
  const [isStoppingSimulation, setIsStoppingSimulation] = useState(false)
  const [stopSimulationError, setStopSimulationError] = useState<string | null>(
    null
  )
  const [isLoadingResults, setIsLoadingResults] = useState(false)
  const [resultsError, setResultsError] = useState<string | null>(null)
  const [resultsInfo, setResultsInfo] = useState<SimulationResultsInfo | null>(
    null
  )
  const resultsInfoRef = useRef<SimulationResultsInfo | null>(null)
  const resultsEventSourceRef = useRef<EventSource | null>(null)
  const resultsStreamErrorTimeoutRef = useRef<number | null>(null)
  const simulationRef = useRef(simulation)
  const resultsPanelRef = useRef<HTMLElement | null>(null)
  const keepResultsScrolledDownRef = useRef(true)
  const isProgrammaticResultsScrollRef = useRef(false)
  const previousResultsScrollTopRef = useRef(0)
  const [resultsStreamRestartKey, setResultsStreamRestartKey] = useState(0)
  const shouldSimulateOpeningHand = simulation.startingHandId === null

  useEffect(() => {
    simulationRef.current = simulation
  }, [simulation])

  const scrollResultsToBottom = useCallback(() => {
    const resultsPanel = resultsPanelRef.current

    if (!resultsPanel) {
      return
    }

    isProgrammaticResultsScrollRef.current = true
    resultsPanel.scrollTo({ top: resultsPanel.scrollHeight })

    window.requestAnimationFrame(() => {
      previousResultsScrollTopRef.current = resultsPanel.scrollTop
      isProgrammaticResultsScrollRef.current = false
    })
  }, [])

  const keepResultsScrolledToBottom = useCallback(() => {
    keepResultsScrolledDownRef.current = true
    scrollResultsToBottom()
  }, [scrollResultsToBottom])

  const scrollResultsToBottomIfKept = useCallback(() => {
    if (keepResultsScrolledDownRef.current) {
      scrollResultsToBottom()
    }
  }, [scrollResultsToBottom])

  useEffect(() => {
    keepResultsScrolledDownRef.current = true
    previousResultsScrollTopRef.current = 0
    scrollResultsToBottom()
    setIsStartingOpeningHandRun(false)
    setOpeningHandRunError(null)
    setIsStartingTurnRun(false)
    setTurnRunError(null)
    setIsStoppingSimulation(false)
    setStopSimulationError(null)
    resultsEventSourceRef.current?.close()
    resultsEventSourceRef.current = null

    if (resultsStreamErrorTimeoutRef.current !== null) {
      window.clearTimeout(resultsStreamErrorTimeoutRef.current)
      resultsStreamErrorTimeoutRef.current = null
    }

    setIsLoadingResults(false)
    setResultsError(null)
    setResultsInfo(null)
    resultsInfoRef.current = null
    setResultsStreamRestartKey(0)
  }, [scrollResultsToBottom, simulation.id])

  useLayoutEffect(() => {
    if (keepResultsScrolledDownRef.current) {
      scrollResultsToBottom()
    }
  }, [resultsError, resultsInfo, isLoadingResults, scrollResultsToBottom])

  useEffect(() => {
    const resultsPanel = resultsPanelRef.current

    if (!resultsPanel) {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      if (keepResultsScrolledDownRef.current) {
        scrollResultsToBottom()
      }
    })

    resizeObserver.observe(resultsPanel)

    return () => {
      resizeObserver.disconnect()
    }
  }, [scrollResultsToBottom])

  function handleResultsScroll(event: UIEvent<HTMLElement>) {
    const resultsPanel = event.currentTarget
    const distanceFromBottom =
      resultsPanel.scrollHeight -
      resultsPanel.clientHeight -
      resultsPanel.scrollTop

    if (distanceFromBottom <= 4) {
      keepResultsScrolledDownRef.current = true
    } else if (
      !isProgrammaticResultsScrollRef.current &&
      resultsPanel.scrollTop < previousResultsScrollTopRef.current
    ) {
      keepResultsScrolledDownRef.current = false
    }

    previousResultsScrollTopRef.current = resultsPanel.scrollTop
  }

  async function handleStartOpeningHandRun() {
    if (
      !shouldSimulateOpeningHand ||
      isStartingOpeningHandRun ||
      isStartingTurnRun ||
      isStoppingSimulation
    ) {
      return
    }

    setIsStartingOpeningHandRun(true)
    setOpeningHandRunError(null)
    setTurnRunError(null)

    try {
      const stopResult = await stopSimulation()

      if (!stopResult) {
        return
      }

      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/opening-hand-llm-runs`,
        {
          method: "POST",
        }
      )

      if (!response.ok) {
        setOpeningHandRunError(
          await readApiError(response, "Opening hand run could not be started.")
        )
        return
      }

      setResultsStreamRestartKey((currentKey) => currentKey + 1)
    } catch {
      setOpeningHandRunError(
        "Opening hand run could not be sent to the server."
      )
    } finally {
      setIsStartingOpeningHandRun(false)
    }
  }

  async function handleStartTurnRun(turnNumber: number) {
    if (isStartingTurnRun || isStartingOpeningHandRun || isStoppingSimulation) {
      return
    }

    if (!Number.isInteger(turnNumber) || turnNumber < 1) {
      setTurnRunError("Turn number must be a positive integer.")
      return
    }

    setIsStartingTurnRun(true)
    setTurnRunError(null)
    setOpeningHandRunError(null)

    try {
      const stopResult = await stopSimulation()

      if (!stopResult) {
        return
      }

      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/turn-llm-runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            turnNumber,
          }),
        }
      )

      if (!response.ok) {
        setTurnRunError(
          await readApiError(response, "Turn run could not be started.")
        )
        return
      }

      setResultsStreamRestartKey((currentKey) => currentKey + 1)
    } catch {
      setTurnRunError("Turn run could not be sent to the server.")
    } finally {
      setIsStartingTurnRun(false)
    }
  }

  async function stopSimulation() {
    setIsStoppingSimulation(true)
    setStopSimulationError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/stop`,
        {
          method: "POST",
        }
      )

      if (!response.ok) {
        setStopSimulationError(
          await readApiError(response, "Simulation could not be stopped.")
        )
        return null
      }

      const data = (await response.json()) as StopSimulationResponse
      return data
    } catch {
      setStopSimulationError("Simulation stop could not be sent to the server.")
      return null
    } finally {
      setIsStoppingSimulation(false)
    }
  }

  async function handleStopSimulation() {
    if (isStoppingSimulation) {
      return
    }

    await stopSimulation()
  }

  useEffect(() => {
    const eventSource = new EventSource(
      `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/results/stream`
    )
    let isStreamClosed = false

    resultsEventSourceRef.current?.close()
    resultsEventSourceRef.current = eventSource
    setIsLoadingResults(true)
    setResultsError(null)

    function clearStreamErrorTimeout() {
      if (resultsStreamErrorTimeoutRef.current === null) {
        return
      }

      window.clearTimeout(resultsStreamErrorTimeoutRef.current)
      resultsStreamErrorTimeoutRef.current = null
    }

    function markStreamLoaded() {
      setIsLoadingResults(false)
    }

    function closeStream() {
      if (isStreamClosed) {
        return
      }

      isStreamClosed = true
      clearStreamErrorTimeout()
      eventSource.close()

      if (resultsEventSourceRef.current === eventSource) {
        resultsEventSourceRef.current = null
      }

      markStreamLoaded()
    }

    eventSource.onmessage = (messageEvent) => {
      clearStreamErrorTimeout()

      try {
        const streamEvent = JSON.parse(
          messageEvent.data
        ) as SimulationResultsStreamEvent

        if (streamEvent.type === "error") {
          setResultsError(streamEvent.message)
          markStreamLoaded()
          return
        }

        const updatedResultsInfo = applySimulationResultsStreamEvent(
          resultsInfoRef.current,
          streamEvent
        )
        resultsInfoRef.current = updatedResultsInfo
        setResultsInfo(updatedResultsInfo)

        if (
          streamEvent.type === "snapshot" ||
          streamEvent.type === "simulation_updated" ||
          streamEvent.type === "done"
        ) {
          onSimulationUpdated(streamEvent.simulation)
        } else if (updatedResultsInfo) {
          onSimulationUpdated({
            ...simulationRef.current,
            activeLlmRunCount:
              getActiveLlmRunCountFromResults(updatedResultsInfo),
            completedLlmRunCount:
              getSimulationRunCountFromResults(updatedResultsInfo),
          })
        }

        markStreamLoaded()

        if (streamEvent.type === "done") {
          closeStream()
        }
      } catch {
        setResultsError("Simulation results stream sent an invalid event.")
        markStreamLoaded()
      }
    }

    eventSource.onerror = () => {
      if (eventSource.readyState === EventSource.CLOSED) {
        setResultsError("Simulation results stream disconnected.")
        closeStream()
        return
      }

      if (resultsStreamErrorTimeoutRef.current !== null) {
        return
      }

      resultsStreamErrorTimeoutRef.current = window.setTimeout(() => {
        if (isStreamClosed) {
          return
        }

        setResultsError("Simulation results stream is reconnecting.")
        markStreamLoaded()
      }, 10000)
    }

    return () => {
      closeStream()
    }
  }, [deckId, onSimulationUpdated, resultsStreamRestartKey, simulation.id])

  return (
    <main
      ref={resultsPanelRef}
      className="simulation-scrollbar h-full min-h-0 min-w-0 overflow-y-auto px-5 py-6"
      onScroll={handleResultsScroll}
    >
      <section className="mx-auto grid w-full max-w-5xl gap-4">
        {resultsError ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {resultsError}
          </p>
        ) : null}

        {isLoadingResults && !resultsInfo ? (
          <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
            Loading simulation results...
          </p>
        ) : null}

        {resultsInfo ? (
          <SimulationResultsPanel
            isStartingOpeningHandRun={isStartingOpeningHandRun}
            isStartingTurnRun={isStartingTurnRun}
            isLoadingStartingHand={isLoadingStartingHand}
            isStoppingSimulation={isStoppingSimulation}
            onStartOpeningHandRun={() => void handleStartOpeningHandRun()}
            onKeepResultsScrolledToBottom={keepResultsScrolledToBottom}
            onScrollResultsToBottomIfKept={scrollResultsToBottomIfKept}
            onStartTurnRun={(turnNumber) => void handleStartTurnRun(turnNumber)}
            onStopSimulation={() => void handleStopSimulation()}
            openingHandRunError={openingHandRunError}
            resultsInfo={resultsInfo}
            simulation={simulation}
            startingHand={startingHand}
            startingHandLoadError={startingHandLoadError}
            stopSimulationError={stopSimulationError}
            turnRunError={turnRunError}
          />
        ) : !isLoadingResults && !resultsError ? (
          <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
            Waiting for simulation results.
          </p>
        ) : null}
      </section>
    </main>
  )
}

function SimulationDebugModal({
  deckId,
  debugInfo,
  error,
  isLoading,
  onClose,
  onRefresh,
  simulationId,
}: {
  deckId: string
  debugInfo: SimulationDebugInfo | null
  error: string | null
  isLoading: boolean
  onClose: () => void
  onRefresh: () => void
  simulationId: string
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        aria-labelledby="simulation-debug-title"
        className="flex max-h-[calc(100svh-3rem)] w-full max-w-6xl flex-col rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-1">
            <h2 id="simulation-debug-title" className="text-xl font-semibold">
              Simulation debug
            </h2>
            <p className="text-sm break-all text-muted-foreground">
              {simulationId}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isLoading}
              onClick={onRefresh}
            >
              <RefreshCw data-icon="inline-start" />
              {isLoading ? "Refreshing..." : "Refresh debug"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close"
              title="Close"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </header>

        <div className="debug-scrollbar-neutral min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div className="grid gap-4">
            {error ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}

            {isLoading && !debugInfo ? (
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
                Loading debug info...
              </p>
            ) : null}

            {debugInfo ? (
              <SimulationDebugPanel deckId={deckId} debugInfo={debugInfo} />
            ) : !isLoading && !error ? (
              <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
                Debug info has not been loaded yet.
              </p>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

function SimulationResultsPanel({
  isStartingOpeningHandRun,
  isStartingTurnRun,
  isLoadingStartingHand,
  isStoppingSimulation,
  onStartOpeningHandRun,
  onKeepResultsScrolledToBottom,
  onScrollResultsToBottomIfKept,
  onStartTurnRun,
  onStopSimulation,
  openingHandRunError,
  resultsInfo,
  simulation,
  startingHand,
  startingHandLoadError,
  stopSimulationError,
  turnRunError,
}: {
  isStartingOpeningHandRun: boolean
  isStartingTurnRun: boolean
  isLoadingStartingHand: boolean
  isStoppingSimulation: boolean
  onStartOpeningHandRun: () => void
  onKeepResultsScrolledToBottom: () => void
  onScrollResultsToBottomIfKept: () => void
  onStartTurnRun: (turnNumber: number) => void
  onStopSimulation: () => void
  openingHandRunError: string | null
  resultsInfo: SimulationResultsInfo
  simulation: Simulation
  startingHand: StartingHand | null
  startingHandLoadError: string | null
  stopSimulationError: string | null
  turnRunError: string | null
}) {
  const canStartOpeningHandRun = simulation.startingHandId === null
  const hasPresetStartingHand = simulation.startingHandId !== null
  const isOpeningHandRunning = resultsInfo.openingHandLlmRuns.some((run) =>
    isActiveLlmRunStatus(run.status)
  )
  const isTurnRunning = resultsInfo.turnLlmRuns.some((run) =>
    isActiveLlmRunStatus(run.status)
  )
  const activeTurnNumbers = new Set(
    resultsInfo.turnLlmRuns
      .filter(
        (run) =>
          typeof run.turnNumber === "number" && isActiveLlmRunStatus(run.status)
      )
      .map((run) => run.turnNumber as number)
  )
  const isStartingSimulationRun =
    isStartingOpeningHandRun || isStartingTurnRun || isStoppingSimulation
  const isSimulationActionBlocked =
    isStartingSimulationRun ||
    isOpeningHandRunning ||
    isTurnRunning ||
    simulation.activeLlmRunCount > 0
  const latestOpeningHandRun = resultsInfo.openingHandLlmRuns.reduce<
    SimulationResultsInfo["openingHandLlmRuns"][number] | null
  >((latestRun, run) => {
    if (!latestRun || run.attemptNumber > latestRun.attemptNumber) {
      return run
    }

    return latestRun
  }, null)
  const latestTurnRun = resultsInfo.turnLlmRuns.reduce<
    SimulationResultsInfo["turnLlmRuns"][number] | null
  >((latestRun, run) => {
    if (!latestRun) {
      return run
    }

    const runTurnNumber = run.turnNumber ?? 0
    const latestRunTurnNumber = latestRun.turnNumber ?? 0

    if (
      runTurnNumber > latestRunTurnNumber ||
      (runTurnNumber === latestRunTurnNumber &&
        run.attemptNumber > latestRun.attemptNumber)
    ) {
      return run
    }

    return latestRun
  }, null)
  const hasLatestOpeningHandRun = latestOpeningHandRun !== null
  const hasLatestTurnRun = latestTurnRun !== null
  const isLatestOpeningHandRunSuccessful = latestOpeningHandRun
    ? isSuccessfulOpeningHandRun(latestOpeningHandRun)
    : false
  const latestTurnRunNumber = latestTurnRun?.turnNumber
  const isLatestTurnRunSuccessful = latestTurnRun
    ? isSuccessfulTurnRun(latestTurnRun)
    : false
  const simulationAction = useMemo<SimulationResultsAction | null>(() => {
    if (isSimulationActionBlocked) {
      return null
    }

    if (hasLatestTurnRun) {
      if (
        isLatestTurnRunSuccessful &&
        typeof latestTurnRunNumber === "number"
      ) {
        return {
          kind: "turn",
          turnNumber: latestTurnRunNumber + 1,
        } as const
      }

      return null
    }

    if (hasLatestOpeningHandRun) {
      if (isLatestOpeningHandRunSuccessful) {
        return {
          kind: "turn",
          turnNumber: 1,
        } as const
      }

      return null
    }

    if (canStartOpeningHandRun) {
      return {
        kind: "opening_hand",
      } as const
    }

    return {
      kind: "turn",
      turnNumber: 1,
    } as const
  }, [
    canStartOpeningHandRun,
    hasLatestOpeningHandRun,
    hasLatestTurnRun,
    isSimulationActionBlocked,
    isLatestOpeningHandRunSuccessful,
    isLatestTurnRunSuccessful,
    latestTurnRunNumber,
  ])
  const [renderedSimulationAction, setRenderedSimulationAction] =
    useState<SimulationResultsAction | null>(() => simulationAction)

  useEffect(() => {
    if (!simulationAction) {
      const hideTimeoutId = window.setTimeout(() => {
        setRenderedSimulationAction(null)
      }, 0)

      return () => {
        window.clearTimeout(hideTimeoutId)
      }
    }

    const showTimeoutId = window.setTimeout(() => {
      setRenderedSimulationAction(simulationAction)
    }, 200)

    return () => {
      window.clearTimeout(showTimeoutId)
    }
  }, [simulationAction])

  useLayoutEffect(() => {
    if (renderedSimulationAction?.kind === "turn") {
      onScrollResultsToBottomIfKept()
    }
  }, [onScrollResultsToBottomIfKept, renderedSimulationAction])

  const actionError = openingHandRunError ?? turnRunError
  const runs = [
    ...resultsInfo.openingHandLlmRuns.map((run) => ({
      ...run,
      canRerun: canStartOpeningHandRun && !isOpeningHandRunning,
      isActive: isActiveLlmRunStatus(run.status),
      resultKind: "opening_hand" as const,
      resultLabel: `Opening hand attempt ${run.attemptNumber}`,
      resultEntries: getSimulationResultEntries(run.chunks),
      activeToolCallName: getSimulationRunActiveToolCallName(run.chunks),
      thinkingPreview: getSimulationRunThinkingPreview(run.chunks),
      hasFinalParsedOutputChunk: hasSimulationRunFinalParsedOutputChunk(
        run.chunks
      ),
    })),
    ...resultsInfo.turnLlmRuns.map((run) => ({
      ...run,
      canRerun:
        typeof run.turnNumber === "number" &&
        !activeTurnNumbers.has(run.turnNumber),
      isActive: isActiveLlmRunStatus(run.status),
      resultKind: "turn" as const,
      resultLabel: `Turn ${run.turnNumber ?? "?"} attempt ${run.attemptNumber}`,
      resultEntries: getSimulationResultEntries(run.chunks),
      activeToolCallName: getSimulationRunActiveToolCallName(run.chunks),
      thinkingPreview: getSimulationRunThinkingPreview(run.chunks),
      hasFinalParsedOutputChunk: hasSimulationRunFinalParsedOutputChunk(
        run.chunks
      ),
    })),
  ]

  return (
    <div className="grid gap-3">
      {hasPresetStartingHand ? (
        <SimulationPresetStartingHandBlock
          isLoadingStartingHand={isLoadingStartingHand}
          startingHand={startingHand}
          startingHandLoadError={startingHandLoadError}
        />
      ) : null}

      {runs.length === 0 && !hasPresetStartingHand ? (
        <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
          No opening hand or turn runs have been saved for this simulation yet.
        </p>
      ) : null}

      {runs.map((run) => {
        const finishedDurationText = getSimulationRunFinishedDurationText(run)
        const runMetadata = [
          run.status,
          run.model,
          run.estimatedPriceCents ? `${run.estimatedPriceCents} cents` : null,
          finishedDurationText ? `took ${finishedDurationText}` : null,
          run.outdated ? "outdated" : null,
        ].filter(Boolean)

        return (
          <section
            key={run.llmRunId}
            className="grid gap-3 rounded-md border border-border bg-background/35 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h5 className="text-sm font-medium text-foreground">
                  {run.resultLabel}
                </h5>
                <p className="mt-1 text-xs text-muted-foreground">
                  {runMetadata.join(" / ")}
                </p>
              </div>
              {run.canRerun ? (
                <Button
                  className="shrink-0"
                  type="button"
                  variant="outline"
                  size="icon-sm"
                  disabled={isStartingSimulationRun}
                  aria-label={
                    run.resultKind === "opening_hand"
                      ? "Rerun opening hand"
                      : `Rerun turn ${run.turnNumber}`
                  }
                  title={
                    run.resultKind === "opening_hand"
                      ? "Rerun opening hand"
                      : `Rerun turn ${run.turnNumber}`
                  }
                  onClick={() => {
                    if (run.resultKind === "opening_hand") {
                      onStartOpeningHandRun()
                      return
                    }

                    if (typeof run.turnNumber === "number") {
                      onStartTurnRun(run.turnNumber)
                    }
                  }}
                >
                  <RefreshCw />
                </Button>
              ) : null}
            </div>

            {run.gameState && !getSimulationFinalParsedOutput(run) ? (
              <details className={simulationResultChunkSurfaceClassName}>
                <summary className={simulationResultChunkSummaryClassName}>
                  Game state
                </summary>
                <p className={simulationResultChunkTextClassName}>
                  {run.gameState}
                </p>
              </details>
            ) : null}

            {run.resultEntries.length > 0 ? (
              <SimulationResultChunkCards
                run={run}
                entries={run.resultEntries}
              />
            ) : null}

            {run.isActive && !run.hasFinalParsedOutputChunk ? (
              <SimulationResultThinkingPreview
                activeToolCallName={run.activeToolCallName}
                canStopSimulation={run.status !== "cancel_requested"}
                isStoppingSimulation={isStoppingSimulation}
                onStopSimulation={onStopSimulation}
                previewText={run.thinkingPreview}
                runStartTimeMs={getSimulationRunStartTimeMs(run)}
                stopSimulationError={stopSimulationError}
              />
            ) : run.resultEntries.length === 0 && !run.gameState ? (
              <p className="rounded-md border border-border bg-black/20 px-3 py-2 text-sm text-muted-foreground">
                No user-facing events have been saved for this run yet.
              </p>
            ) : null}
          </section>
        )
      })}

      {actionError ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {actionError}
        </p>
      ) : null}

      <div className="flex min-h-8 justify-center">
        {renderedSimulationAction ? (
          <div>
            <Button
              className="w-fit bg-background/35 text-foreground hover:bg-muted/45"
              variant="outline"
              type="button"
              onClick={() => {
                if (renderedSimulationAction.kind === "opening_hand") {
                  onStartOpeningHandRun()
                  return
                }

                onKeepResultsScrolledToBottom()
                onStartTurnRun(renderedSimulationAction.turnNumber)
              }}
            >
              <Sparkles data-icon="inline-start" />
              {renderedSimulationAction.kind === "opening_hand"
                ? "Simulate opening hand"
                : "Simulate next turn"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}

const simulationResultChunkSurfaceClassName =
  "rounded-md border border-border bg-black/20"
const simulationResultChunkSummaryClassName =
  "cursor-pointer px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
const simulationResultChunkTextClassName =
  "border-t border-border p-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground"
const simulationResultChunkPreClassName =
  "debug-scrollbar-neutral max-h-64 max-w-full overflow-y-auto border-t border-border p-3 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground"

function SimulationResultChunkCards({
  entries,
  run,
}: {
  entries: SimulationResultEntry[]
  run: SimulationDebugLlmRun
}) {
  return (
    <div className="grid gap-2">
      {entries.map((entry) => {
        if (entry.type === "turn_action_log") {
          return (
            <SimulationResultLoggedTurnActionEvent
              key={entry.id}
              actions={entry.actions}
              chunks={entry.chunks}
            />
          )
        }

        const { chunk } = entry

        if (chunk.kind === "final_parsed_output") {
          const finalOutput = getSimulationFinalParsedOutputFromPayload(
            run.phase,
            chunk.payload
          )

          if (finalOutput) {
            return (
              <SimulationFinalOutputBlock
                key={entry.id}
                finalOutput={finalOutput}
                cardMentions={chunk.cardMentions}
              />
            )
          }
        }

        return <SimulationResultEvent key={entry.id} chunk={chunk} />
      })}
    </div>
  )
}

function SimulationResultThinkingPreview({
  activeToolCallName,
  canStopSimulation,
  isStoppingSimulation,
  onStopSimulation,
  previewText,
  runStartTimeMs,
  stopSimulationError,
}: {
  activeToolCallName: string | null
  canStopSimulation: boolean
  isStoppingSimulation: boolean
  onStopSimulation: () => void
  previewText: string | null
  runStartTimeMs: number | null
  stopSimulationError: string | null
}) {
  const previewTextRef = useRef<HTMLParagraphElement | null>(null)
  const [isPreviewOverflowing, setIsPreviewOverflowing] = useState(false)
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now())

  useLayoutEffect(() => {
    const previewTextElement = previewTextRef.current

    if (!previewTextElement) {
      return
    }

    if (!previewText) {
      return
    }

    const measuredPreviewTextElement = previewTextElement

    function updatePreviewOverflow() {
      setIsPreviewOverflowing(
        measuredPreviewTextElement.scrollWidth >
          measuredPreviewTextElement.clientWidth + 1
      )
    }

    const animationFrameId = window.requestAnimationFrame(updatePreviewOverflow)

    const resizeObserver = new ResizeObserver(updatePreviewOverflow)
    resizeObserver.observe(measuredPreviewTextElement)

    return () => {
      window.cancelAnimationFrame(animationFrameId)
      resizeObserver.disconnect()
    }
  }, [previewText])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setCurrentTimeMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [])

  const activeToolCallLabel =
    activeToolCallName === null
      ? null
      : getKnownSimulationResultToolLabel({
          mcpFunctionName: activeToolCallName,
          state: "active",
        })
  const statusLabel = activeToolCallName
    ? (activeToolCallLabel ?? `Calling tool: ${activeToolCallName}`)
    : "Thinking"
  const elapsedText =
    runStartTimeMs === null
      ? null
      : formatMinutesSeconds(currentTimeMs - runStartTimeMs)
  const hasPreviewText = Boolean(previewText)

  return (
    <div
      className={`flex min-h-[3.5rem] items-stretch gap-2 px-3 py-2 ${simulationResultChunkSurfaceClassName}`}
    >
      <div
        className={`min-w-0 flex-1 ${
          hasPreviewText ? "grid gap-1" : "flex items-center"
        }`}
      >
        <div
          className={`flex min-w-0 flex-1 items-center gap-3 font-medium text-sky-100 ${
            hasPreviewText ? "text-sm" : "text-base"
          }`}
        >
          <div className="flex min-w-0 items-center gap-2">
            <LoaderCircle
              className={`shrink-0 animate-spin text-sky-300 ${
                hasPreviewText ? "size-4" : "size-5"
              }`}
            />
            <span className="min-w-0 truncate">{statusLabel}</span>
          </div>
          {elapsedText ? (
            <span
              className={`ml-auto shrink-0 font-normal text-sky-100/65 tabular-nums ${
                hasPreviewText ? "text-xs" : "text-sm"
              }`}
            >
              {elapsedText}
            </span>
          ) : null}
        </div>

        {previewText ? (
          <p
            ref={previewTextRef}
            className={`min-h-4 min-w-0 overflow-hidden text-xs whitespace-nowrap text-muted-foreground/65 ${
              isPreviewOverflowing ? "text-right" : "text-left"
            }`}
            style={{
              WebkitMaskImage:
                "linear-gradient(to right, transparent, black 1.25rem, black calc(100% - 1.25rem), transparent)",
              maskImage:
                "linear-gradient(to right, transparent, black 1.25rem, black calc(100% - 1.25rem), transparent)",
            }}
          >
            {previewText}
          </p>
        ) : null}

        {stopSimulationError ? (
          <p
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {stopSimulationError}
          </p>
        ) : null}
      </div>
      {canStopSimulation ? (
        <Button
          className="aspect-square h-auto min-h-full rounded-full bg-background/40 p-0 text-muted-foreground hover:text-foreground"
          type="button"
          variant="outline"
          disabled={isStoppingSimulation}
          aria-label="Stop simulation"
          title="Stop simulation"
          onClick={onStopSimulation}
        >
          {isStoppingSimulation ? (
            <LoaderCircle className="animate-spin" />
          ) : (
            <Square fill="currentColor" />
          )}
        </Button>
      ) : null}
    </div>
  )
}

type SimulationResultCardMention =
  SimulationDebugLlmRunChunk["cardMentions"][number]

function SimulationFinalOutputBlock({
  cardMentions = [],
  finalOutput,
}: {
  cardMentions?: SimulationDebugLlmRunChunk["cardMentions"]
  finalOutput: ParsedSimulationFinalOutput
}) {
  return (
    <div className={`grid gap-3 p-3 ${simulationResultChunkSurfaceClassName}`}>
      <p className="text-sm leading-6 text-muted-foreground">
        {finalOutput.summary}
      </p>

      {finalOutput.type === "opening_hand" ? (
        <SimulationOpeningHandCardsBlock
          label="Kept hand"
          mentions={getOpeningHandFinalOutputCardMentions(
            finalOutput.keptHand,
            cardMentions
          )}
        />
      ) : (
        <details className={simulationResultChunkSurfaceClassName}>
          <summary className={simulationResultChunkSummaryClassName}>
            Game state
          </summary>
          <p className={simulationResultChunkTextClassName}>
            {finalOutput.gameState}
          </p>
        </details>
      )}
    </div>
  )
}

function SimulationPresetStartingHandBlock({
  isLoadingStartingHand,
  startingHand,
  startingHandLoadError,
}: {
  isLoadingStartingHand: boolean
  startingHand: StartingHand | null
  startingHandLoadError: string | null
}) {
  const statusText = startingHand
    ? `Using preset opening hand: ${startingHand.name}.`
    : startingHandLoadError
      ? "Preset opening hand details could not be loaded."
      : isLoadingStartingHand
        ? "Loading preset opening hand..."
        : "Preset opening hand details are unavailable."

  return (
    <div className={`grid gap-3 p-3 ${simulationResultChunkSurfaceClassName}`}>
      <p className="text-sm leading-6 text-muted-foreground">{statusText}</p>

      {startingHand ? (
        <SimulationOpeningHandCardsBlock
          label="Preset hand"
          mentions={getStartingHandCardMentions(startingHand)}
        />
      ) : null}

      {!startingHand && startingHandLoadError ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {startingHandLoadError}
        </p>
      ) : null}
    </div>
  )
}

function SimulationOpeningHandCardsBlock({
  label,
  mentions,
}: {
  label: string
  mentions: SimulationResultCardMention[]
}) {
  return (
    <div>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </p>
      <div className="mt-2">
        <SimulationResultCardImageLinks mentions={mentions} />
      </div>
    </div>
  )
}

function SimulationResultLoggedTurnActionEvent({
  actions,
  chunks,
}: {
  actions: string[]
  chunks: SimulationDebugLlmRunChunk[]
}) {
  const hasFailure = chunks.some(isMcpCallFailure)
  const hasMultipleActions = chunks.length > 1 || actions.length > 1
  const title = hasFailure
    ? "Turn action log failed"
    : hasMultipleActions
      ? "Turn actions logged"
      : "Turn action logged"

  return (
    <div className={`grid gap-2 p-3 ${simulationResultChunkSurfaceClassName}`}>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {hasMultipleActions && actions.length > 0 ? (
        <ul className="list-disc space-y-1 pl-5 text-sm leading-6 text-foreground/90">
          {actions.map((action, index) => (
            <li key={`${action}-${index}`}>{action}</li>
          ))}
        </ul>
      ) : actions.length === 1 ? (
        <p className="text-sm leading-6 text-foreground/90">{actions[0]}</p>
      ) : (
        <p className="text-sm leading-6 text-muted-foreground">
          {getTurnActionLogFallbackText(chunks)}
        </p>
      )}
    </div>
  )
}

function SimulationResultEvent({
  chunk,
}: {
  chunk: SimulationDebugLlmRunChunk
}) {
  if (chunk.kind === "mcp_call_start") {
    const title =
      getKnownSimulationResultToolLabelForChunk({
        chunk,
        state: "started",
      }) ?? `Tool started: ${chunk.mcpFunctionName ?? "unknown tool"}`

    return (
      <div
        className={`${simulationResultChunkSurfaceClassName} px-3 py-2 text-sm text-muted-foreground`}
      >
        {title}
      </div>
    )
  }

  if (chunk.kind === "mcp_call_complete") {
    if (chunk.mcpFunctionName === "log_turn_action") {
      const loggedAction = getLoggedTurnAction(chunk)

      return (
        <SimulationResultLoggedTurnActionEvent
          actions={loggedAction === null ? [] : [loggedAction]}
          chunks={[chunk]}
        />
      )
    }

    if (chunk.cardMentions.length > 0 && !isMcpCallFailure(chunk)) {
      return <SimulationResultCompletedCardToolEvent chunk={chunk} />
    }

    return (
      <details className={simulationResultChunkSurfaceClassName}>
        <summary className={simulationResultChunkSummaryClassName}>
          {getMcpCallCompleteTitle(chunk)}
        </summary>
        {chunk.cardMentions.length > 0 ? (
          <SimulationResultCardMentions mentions={chunk.cardMentions} />
        ) : null}
        <pre className={simulationResultChunkPreClassName}>
          {formatResultEventPayload(getMcpCallResultPayload(chunk))}
        </pre>
      </details>
    )
  }

  if (chunk.kind === "error") {
    return (
      <details className={simulationResultChunkSurfaceClassName}>
        <summary className={simulationResultChunkSummaryClassName}>
          Simulation event failed
        </summary>
        <pre className={simulationResultChunkPreClassName}>
          {formatResultEventPayload(chunk.payload)}
        </pre>
      </details>
    )
  }

  if (chunk.kind === "cancelled") {
    return (
      <div
        className={`${simulationResultChunkSurfaceClassName} px-3 py-2 text-sm text-muted-foreground`}
      >
        Simulation cancelled: {getPayloadMessage(chunk.payload)}
      </div>
    )
  }

  return (
    <details className={simulationResultChunkSurfaceClassName}>
      <summary className={simulationResultChunkSummaryClassName}>
        {getDebugChunkEventLabel(chunk)}
      </summary>
      <pre className={simulationResultChunkPreClassName}>
        {JSON.stringify(chunk, null, 2)}
      </pre>
    </details>
  )
}

function SimulationResultCompletedCardToolEvent({
  chunk,
}: {
  chunk: SimulationDebugLlmRunChunk
}) {
  const [showCardImages, setShowCardImages] = useState(false)

  return (
    <div className={simulationResultChunkSurfaceClassName}>
      <p className="px-3 py-2 text-sm text-muted-foreground">
        {getMcpCallCompleteTitle(chunk)}
      </p>
      <div className="grid gap-3 border-t border-border p-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Button
            className="border-emerald-500/30 bg-emerald-950/20 text-emerald-100 hover:bg-emerald-900/35 hover:text-emerald-50"
            size="xs"
            type="button"
            variant="outline"
            onClick={() => setShowCardImages((currentValue) => !currentValue)}
          >
            {showCardImages ? <EyeOff /> : <Eye />}
            {showCardImages ? "Hide cards" : "Show cards"}
          </Button>
          {!showCardImages
            ? chunk.cardMentions.map((mention, index) => (
                <a
                  key={`${mention.requestedName}-${index}`}
                  className="max-w-full rounded-full border border-sky-500/30 bg-sky-950/30 px-2.5 py-1 text-xs font-medium text-sky-100 transition-colors hover:border-sky-300/60 hover:bg-sky-900/40 hover:text-sky-50 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none"
                  href={getCardMentionScryfallUrl(mention)}
                  target="_blank"
                  rel="noreferrer"
                  title={getCardMentionDisplayName(mention)}
                >
                  <span className="block truncate">
                    {getCardMentionDisplayName(mention)}
                  </span>
                </a>
              ))
            : null}
        </div>

        {showCardImages ? (
          <SimulationResultCardImageLinks mentions={chunk.cardMentions} />
        ) : null}
      </div>
    </div>
  )
}

function SimulationResultCardImageLinks({
  mentions,
}: {
  mentions: SimulationResultCardMention[]
}) {
  const cardImageMentions = mentions.filter(hasCardMentionImage)
  const shouldFitSevenCardImages = cardImageMentions.length >= 7

  return (
    <div className="flex flex-wrap justify-start gap-3">
      {cardImageMentions.map((mention, index) => (
        <a
          key={`${mention.requestedName}-image-${index}`}
          className={
            shouldFitSevenCardImages
              ? "block w-[min(8rem,calc((100%-4.5rem)/7))] min-w-0 overflow-hidden rounded-sm bg-black/40 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none"
              : "block w-28 overflow-hidden rounded-sm bg-black/40 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none sm:w-32"
          }
          href={getCardMentionScryfallUrl(mention)}
          target="_blank"
          rel="noreferrer"
          title={getCardMentionDisplayName(mention)}
        >
          <img
            className="aspect-[488/680] w-full object-cover"
            src={mention.defaultImageUrl}
            alt={getCardMentionDisplayName(mention)}
            loading="lazy"
          />
        </a>
      ))}
    </div>
  )
}

function hasCardMentionImage(
  mention: SimulationResultCardMention
): mention is SimulationResultCardMention & { defaultImageUrl: string } {
  return typeof mention.defaultImageUrl === "string"
}

function SimulationResultCardMentions({
  mentions,
}: {
  mentions: SimulationDebugLlmRunChunk["cardMentions"]
}) {
  return (
    <div className="grid gap-2 border-t border-border p-3 sm:grid-cols-2 lg:grid-cols-3">
      {mentions.map((mention, index) => (
        <div
          key={`${mention.requestedName}-${index}`}
          className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-black/20 p-2"
        >
          {mention.defaultImageUrl ? (
            <img
              className="h-16 w-12 shrink-0 rounded-sm object-cover"
              src={mention.defaultImageUrl}
              alt=""
              loading="lazy"
            />
          ) : null}
          <div className="min-w-0 text-xs leading-5">
            <p className="truncate font-medium text-foreground">
              {mention.requestedName}
            </p>
            {mention.resolvedName &&
            mention.resolvedName !== mention.requestedName ? (
              <p className="truncate text-muted-foreground">
                {mention.resolvedName}
              </p>
            ) : null}
            {mention.resolutionStatus === "missing" ? (
              <p className="text-muted-foreground">No Scryfall match</p>
            ) : null}
          </div>
        </div>
      ))}
    </div>
  )
}

function getOpeningHandFinalOutputCardMentions(
  keptHand: readonly string[],
  cardMentions: SimulationDebugLlmRunChunk["cardMentions"]
) {
  return keptHand.map(
    (cardName, index): SimulationResultCardMention =>
      cardMentions[index] ?? {
        requestedName: cardName,
        resolutionStatus: "missing",
        resolvedName: null,
        scryfallUri: null,
        defaultImageUrl: null,
      }
  )
}

function getStartingHandCardMentions(startingHand: StartingHand) {
  return startingHand.cards.flatMap((card) =>
    Array.from(
      { length: card.quantity },
      (): SimulationResultCardMention => ({
        requestedName: card.name,
        resolutionStatus: "exact",
        resolvedName: card.name,
        scryfallUri: card.scryfallUri,
        defaultImageUrl: card.defaultImageUrl,
      })
    )
  )
}

function getCardMentionDisplayName(mention: SimulationResultCardMention) {
  return mention.requestedName
}

function getCardMentionScryfallUrl(mention: SimulationResultCardMention) {
  if (mention.scryfallUri) {
    return mention.scryfallUri
  }

  return `https://scryfall.com/search?q=${encodeURIComponent(
    mention.resolvedName ?? mention.requestedName
  )}`
}

function formatResultEventPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload
  }

  return JSON.stringify(payload, null, 2)
}

function getMcpCallCompleteTitle(chunk: SimulationDebugLlmRunChunk) {
  const toolName = chunk.mcpFunctionName ?? "unknown tool"
  const knownToolLabel = getKnownSimulationResultToolLabelForChunk({
    chunk,
    state: isMcpCallFailure(chunk) ? "failed" : "completed",
  })

  if (knownToolLabel !== null) {
    return knownToolLabel
  }

  if (isMcpCallFailure(chunk)) {
    return `Tool failed: ${toolName}`
  }

  if (chunk.mcpFunctionName === "log_turn_action") {
    const lastLoggedAction = getLoggedTurnAction(chunk)

    if (lastLoggedAction) {
      return `Tool completed: ${toolName} - ${lastLoggedAction}`
    }
  }

  return `Tool completed: ${toolName}`
}

function getMcpCallResultPayload(chunk: SimulationDebugLlmRunChunk) {
  if (isMcpCallFailure(chunk)) {
    return chunk.mcpFunctionOutput ?? getMcpCallErrorPayload(chunk)
  }

  return chunk.mcpFunctionOutput
}

function getTurnActionLogFallbackText(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  if (!chunks.some(isMcpCallFailure)) {
    return "The action log was updated."
  }

  const failurePayload = chunks
    .filter(isMcpCallFailure)
    .map(getMcpCallResultPayload)
    .find((payload) => payload !== null && payload !== undefined)

  if (typeof failurePayload === "string" && failurePayload.trim()) {
    return failurePayload
  }

  const failureMessage = getPayloadString(failurePayload, "message")

  return failureMessage ?? "The action was not logged."
}

function isMcpCallFailure(chunk: SimulationDebugLlmRunChunk) {
  if (chunk.kind !== "mcp_call_complete") {
    return false
  }

  return (
    getPayloadString(asPayloadRecord(chunk.payload).item, "status") ===
      "failed" || getMcpCallErrorPayload(chunk) !== null
  )
}

function getMcpCallErrorPayload(chunk: SimulationDebugLlmRunChunk) {
  const itemRecord = asPayloadRecord(asPayloadRecord(chunk.payload).item)
  const errorRecord = asPayloadRecord(itemRecord.error)
  const content = errorRecord.content

  if (!Array.isArray(content)) {
    return Object.keys(errorRecord).length > 0 ? errorRecord : null
  }

  const textParts = content.flatMap((part) => {
    const text = getPayloadString(part, "text")

    return text === null ? [] : [text]
  })

  if (textParts.length === 0) {
    return errorRecord
  }

  return textParts.join("\n")
}

function asPayloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {}
}

function getPayloadString(value: unknown, property: string) {
  const propertyValue = asPayloadRecord(value)[property]

  return typeof propertyValue === "string" ? propertyValue : null
}

function getPayloadMessage(payload: unknown) {
  if (typeof payload === "string" && payload.trim()) {
    return payload
  }

  if (typeof payload === "object" && payload !== null && "message" in payload) {
    const message = payload.message

    if (typeof message === "string" && message.trim()) {
      return message
    }
  }

  return "The run was cancelled."
}

function SimulationDebugPanel({
  deckId,
  debugInfo,
}: {
  deckId: string
  debugInfo: SimulationDebugInfo
}) {
  return (
    <div className="grid gap-4">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-md border border-border bg-background/35 p-3">
          <dt className="text-muted-foreground">Opening hand LLM runs</dt>
          <dd className="mt-1 font-medium text-foreground">
            {debugInfo.openingHandLlmRunCount}
          </dd>
        </div>
        <div className="rounded-md border border-border bg-background/35 p-3">
          <dt className="text-muted-foreground">Turn LLM runs</dt>
          <dd className="mt-1 font-medium text-foreground">
            {debugInfo.turnLlmRunCount}
          </dd>
        </div>
      </dl>

      <SimulationDebugRunGroup
        deckId={deckId}
        heading="Opening hand runs"
        runs={debugInfo.openingHandLlmRuns}
        simulationId={debugInfo.simulationId}
      />
      <SimulationDebugRunGroup
        deckId={deckId}
        heading="Turn runs"
        runs={debugInfo.turnLlmRuns}
        simulationId={debugInfo.simulationId}
      />
    </div>
  )
}

function SimulationDebugRunGroup({
  deckId,
  heading,
  runs,
  simulationId,
}: {
  deckId: string
  heading: string
  runs: SimulationDebugInfo["openingHandLlmRuns"]
  simulationId: string
}) {
  return (
    <section className="grid gap-3">
      <h5 className="text-sm font-medium text-foreground">{heading}</h5>
      {runs.length > 0 ? (
        runs.map((run) => (
          <div
            key={run.llmRunId}
            className="grid gap-3 rounded-md border border-border bg-background/35 p-3"
          >
            <div className="grid gap-2 text-sm sm:grid-cols-2">
              <p className="break-all text-muted-foreground">
                ID: <span className="text-foreground">{run.llmRunId}</span>
              </p>
              <p className="text-muted-foreground">
                Status: <span className="text-foreground">{run.status}</span>
              </p>
              <p className="text-muted-foreground">
                Attempt:{" "}
                <span className="text-foreground">{run.attemptNumber}</span>
              </p>
              {run.openingHandIsValid !== undefined ? (
                <p className="text-muted-foreground">
                  Valid opening hand:{" "}
                  <span className="text-foreground">
                    {run.openingHandIsValid ? "Yes" : "No"}
                  </span>
                </p>
              ) : null}
              {run.turnNumber ? (
                <p className="text-muted-foreground">
                  Turn:{" "}
                  <span className="text-foreground">{run.turnNumber}</span>
                </p>
              ) : null}
              {run.outdated !== undefined ? (
                <p className="text-muted-foreground">
                  Outdated:{" "}
                  <span className="text-foreground">
                    {run.outdated ? "Yes" : "No"}
                  </span>
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Model: <span className="text-foreground">{run.model}</span>
              </p>
              {run.estimatedPriceCents ? (
                <p className="text-muted-foreground">
                  Estimated price:{" "}
                  <span className="text-foreground">
                    {run.estimatedPriceCents} cents
                  </span>
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Reasoning effort:{" "}
                <span className="text-foreground">
                  {run.reasoningEffort || "N/A"}
                </span>
              </p>
              <p className="break-all text-muted-foreground">
                Runtime key:{" "}
                <span className="text-foreground">
                  {run.runtimeStreamKey ?? "none"}
                </span>
              </p>
            </div>

            {run.provider === "openrouter" &&
            (run.openrouterGenerations?.length ?? 0) > 0 ? (
              <OpenRouterGenerationsTable
                deckId={deckId}
                generations={run.openrouterGenerations ?? []}
                simulationId={simulationId}
              />
            ) : null}

            {run.gameState ? (
              <details className="rounded-md border border-emerald-500/35 bg-emerald-950/20 shadow-sm shadow-emerald-950/20">
                <summary className="cursor-pointer border-b border-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-200 transition-colors hover:text-emerald-100">
                  Game state
                </summary>
                <pre className="debug-scrollbar-neutral max-h-96 max-w-full min-w-0 overflow-y-auto p-3 text-xs leading-5 break-words whitespace-pre-wrap text-emerald-50/80">
                  {run.gameState}
                </pre>
              </details>
            ) : null}

            <div className="grid gap-2">
              <p className="text-sm text-muted-foreground">
                Chunks: {run.chunks.length}
              </p>
              {run.chunks.length > 0 ? (
                <>
                  <details className="min-w-0 rounded-md border border-sky-500/35 bg-sky-950/20 shadow-sm shadow-sky-950/20">
                    <summary className="cursor-pointer border-b border-sky-500/20 px-3 py-2 text-sm font-medium text-sky-200 transition-colors hover:text-sky-100">
                      Raw chunk JSON
                    </summary>
                    <pre className="debug-scrollbar-neutral max-h-96 max-w-full min-w-0 overflow-y-auto p-3 text-xs leading-5 break-words whitespace-pre-wrap text-sky-50/80">
                      {JSON.stringify(run.chunks, null, 2)}
                    </pre>
                  </details>
                  <FormattedDebugChunks chunks={run.chunks} />
                </>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
          No runs yet.
        </p>
      )}
    </section>
  )
}

type OpenRouterGenerationLookupState =
  | {
      status: "loading"
    }
  | {
      status: "loaded"
      providerName: string | null
      providerEntry: unknown | null
      providerSlug: string | null
      result: unknown
    }
  | {
      status: "error"
      error: string
    }

function OpenRouterGenerationsTable({
  deckId,
  generations,
  simulationId,
}: {
  deckId: string
  generations: SimulationDebugInfo["openingHandLlmRuns"][number]["openrouterGenerations"]
  simulationId: string
}) {
  const [generationLookups, setGenerationLookups] = useState<
    Record<string, OpenRouterGenerationLookupState>
  >({})

  const handleQueryGeneration = useCallback(
    async (generationId: string) => {
      setGenerationLookups((currentLookups) => ({
        ...currentLookups,
        [generationId]: { status: "loading" },
      }))

      try {
        const response = await fetch(
          `${API_BASE_URL}/decks/${encodeURIComponent(deckId)}/simulations/${encodeURIComponent(simulationId)}/openrouter-generations/${encodeURIComponent(generationId)}`
        )

        if (!response.ok) {
          const errorMessage = await readApiError(
            response,
            "OpenRouter generation could not be queried."
          )

          setGenerationLookups((currentLookups) => ({
            ...currentLookups,
            [generationId]: {
              status: "error",
              error: errorMessage,
            },
          }))
          return
        }

        const data =
          (await response.json()) as OpenRouterGenerationDetailsResponse
        setGenerationLookups((currentLookups) => ({
          ...currentLookups,
          [generationId]: {
            status: "loaded",
            providerName: data.providerName ?? null,
            providerEntry: data.providerEntry ?? null,
            providerSlug: data.providerSlug ?? null,
            result: data.result,
          },
        }))
      } catch {
        setGenerationLookups((currentLookups) => ({
          ...currentLookups,
          [generationId]: {
            status: "error",
            error: "OpenRouter generation could not be queried.",
          },
        }))
      }
    },
    [deckId, simulationId]
  )

  return (
    <section className="min-w-0 rounded-md border border-sky-500/35 bg-sky-950/20 shadow-sm shadow-sky-950/20">
      <h6 className="border-b border-sky-500/20 px-3 py-2 text-sm font-medium text-sky-200">
        OpenRouter generations
      </h6>
      <div className="debug-scrollbar-neutral max-w-full overflow-x-auto">
        <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
          <thead className="text-sky-100/80">
            <tr>
              <th className="w-36 border-b border-sky-500/20 px-3 py-2 font-medium">
                Turn
              </th>
              <th className="border-b border-sky-500/20 px-3 py-2 font-medium">
                Generation ID
              </th>
              <th className="w-32 border-b border-sky-500/20 px-3 py-2 font-medium">
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            {generations.map((generation) => {
              const lookup = generationLookups[generation.generationId]

              return (
                <Fragment key={generation.openrouterTurnIndex}>
                  <tr>
                    <td className="border-t border-sky-500/10 px-3 py-2 text-muted-foreground">
                      OpenRouter turn {generation.openrouterTurnIndex + 1}
                    </td>
                    <td className="border-t border-sky-500/10 px-3 py-2 break-all text-foreground select-all">
                      {generation.generationId}
                    </td>
                    <td className="border-t border-sky-500/10 px-3 py-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={lookup?.status === "loading"}
                        aria-expanded={lookup?.status === "loaded"}
                        title="Query OpenRouter generation endpoint"
                        onClick={() =>
                          void handleQueryGeneration(generation.generationId)
                        }
                      >
                        {lookup?.status === "loading" ? (
                          <RefreshCw
                            className="animate-spin"
                            data-icon="inline-start"
                          />
                        ) : (
                          <Search data-icon="inline-start" />
                        )}
                        {lookup?.status === "loading"
                          ? "Querying..."
                          : lookup?.status === "loaded"
                            ? "Refresh"
                            : "Query"}
                      </Button>
                    </td>
                  </tr>
                  {lookup ? (
                    <tr>
                      <td
                        className="border-t border-sky-500/10 px-3 py-2"
                        colSpan={3}
                      >
                        <OpenRouterGenerationLookupResult lookup={lookup} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function OpenRouterGenerationLookupResult({
  lookup,
}: {
  lookup: OpenRouterGenerationLookupState
}) {
  if (lookup.status === "loading") {
    return (
      <p className="rounded-md border border-sky-500/20 bg-black/20 px-3 py-2 text-xs text-muted-foreground">
        Querying OpenRouter generation endpoint...
      </p>
    )
  }

  if (lookup.status === "error") {
    return (
      <p
        className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        role="alert"
      >
        {lookup.error}
      </p>
    )
  }

  return (
    <details
      className="min-w-0 rounded-md border border-sky-500/25 bg-black/20"
      open
    >
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-sky-200 transition-colors hover:text-sky-100">
        Generation endpoint result
      </summary>
      <OpenRouterGenerationProviderMetadata
        providerName={lookup.providerName}
        providerSlug={lookup.providerSlug}
      />
      <pre className="debug-scrollbar-neutral max-h-96 max-w-full min-w-0 overflow-y-auto border-t border-sky-500/20 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-sky-50/80">
        {JSON.stringify(lookup.result, null, 2)}
      </pre>
      <OpenRouterMatchedProviderEntry providerEntry={lookup.providerEntry} />
    </details>
  )
}

function OpenRouterGenerationProviderMetadata({
  providerName,
  providerSlug,
}: {
  providerName: string | null
  providerSlug: string | null
}) {
  return (
    <dl className="grid gap-3 border-t border-sky-500/20 px-3 py-2 text-xs sm:grid-cols-2">
      <div className="min-w-0">
        <dt className="text-sky-100/70">Provider name</dt>
        <dd className="mt-1 break-all text-sky-50/90">
          {providerName ?? "Not reported"}
        </dd>
      </div>
      <div className="min-w-0">
        <dt className="text-sky-100/70">Provider slug</dt>
        <dd
          className={
            providerSlug
              ? "mt-1 font-mono break-all text-sky-50/90"
              : "mt-1 text-muted-foreground"
          }
        >
          {providerSlug ?? "No matching provider slug"}
        </dd>
      </div>
    </dl>
  )
}

function OpenRouterMatchedProviderEntry({
  providerEntry,
}: {
  providerEntry: unknown | null
}) {
  return (
    <section className="border-t border-sky-500/20">
      <p className="px-3 py-2 text-xs font-medium text-sky-200">
        Matched provider entry
      </p>
      {providerEntry ? (
        <pre className="debug-scrollbar-neutral max-h-96 max-w-full min-w-0 overflow-y-auto border-t border-sky-500/20 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-sky-50/80">
          {JSON.stringify(providerEntry, null, 2)}
        </pre>
      ) : (
        <p className="border-t border-sky-500/20 px-3 py-2 text-xs text-muted-foreground">
          No matching provider entry returned.
        </p>
      )}
    </section>
  )
}

function FormattedDebugChunks({
  chunks,
}: {
  chunks: SimulationDebugLlmRunChunk[]
}) {
  const blocks = formatDebugChunkBlocks(chunks)

  return (
    <div className="grid gap-2">
      {blocks.map((block) =>
        block.type === "event" ? (
          <details
            key={block.id}
            className="min-w-0 rounded-md border border-border bg-black/20"
          >
            <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
              {getDebugChunkEventLabel(block.chunk)}
            </summary>
            <pre className="debug-scrollbar-neutral max-h-80 max-w-full min-w-0 overflow-y-auto border-t border-border p-3 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(block.chunk, null, 2)}
            </pre>
          </details>
        ) : (
          <section
            key={block.id}
            className="grid gap-3 rounded-md border border-border bg-black/20 p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium tracking-wide text-sky-300 uppercase">
                {block.type === "reasoning" ? "Reasoning" : "Output"}
              </p>
              <p className="text-xs text-muted-foreground">
                {block.chunks.length} chunk
                {block.chunks.length === 1 ? "" : "s"}
              </p>
            </div>
            <p className="text-sm leading-6 whitespace-pre-wrap text-foreground">
              {block.text}
            </p>
            <DebugDeltaChunkList type={block.type} chunks={block.chunks} />
          </section>
        )
      )}
    </div>
  )
}

function DebugDeltaChunkList({
  type,
  chunks,
}: {
  type: "reasoning" | "output"
  chunks: SimulationDebugLlmRunChunk[]
}) {
  return (
    <details className="min-w-0 rounded-md border border-sky-500/25 bg-sky-950/15">
      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-sky-200 transition-colors hover:text-sky-100">
        View all chunks
      </summary>
      <div className="grid gap-2 border-t border-sky-500/20 p-2">
        {chunks.map((chunk) => (
          <details
            key={`${type}-${getDebugChunkBlockId(chunk)}`}
            className="min-w-0 rounded-md border border-border bg-black/25"
          >
            <summary className="cursor-pointer px-3 py-2 text-xs leading-5 break-words text-muted-foreground transition-colors hover:text-foreground">
              {getDebugDeltaChunkLabel(chunk, type)}
            </summary>
            <pre className="debug-scrollbar-neutral max-h-80 max-w-full min-w-0 overflow-y-auto border-t border-border p-3 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
              {JSON.stringify(chunk, null, 2)}
            </pre>
          </details>
        ))}
      </div>
    </details>
  )
}

function getDebugChunkEventLabel(chunk: SimulationDebugLlmRunChunk) {
  const eventType = getPayloadString(chunk.payload, "type")
  const eventLabel = eventType ?? chunk.kind

  if (chunk.mcpFunctionName) {
    return `${eventLabel}: ${chunk.mcpFunctionName}`
  }

  return eventLabel
}

function EmptySimulationSelection() {
  return (
    <div className="grid flex-1 place-items-center px-5 py-10 text-center">
      <div className="max-w-md space-y-3">
        <Sparkles className="mx-auto size-8 text-sky-300" />
        <h3 className="text-lg font-semibold">Simulation workspace</h3>
        <p className="text-sm leading-6 text-muted-foreground">
          Select a simulation to view its run details here.
        </p>
      </div>
    </div>
  )
}

function countStartingHandCards(hand: StartingHand) {
  return hand.cards.reduce((total, card) => total + card.quantity, 0)
}

function getSelectedStartingHandCards(
  selectedCardIds: readonly string[],
  cardOptions: readonly OpeningHandCardOption[]
) {
  const selectedCardIdSet = new Set(selectedCardIds)
  const cardsByDeckCardId = new Map<
    number,
    { deckCardId: number; quantity: number }
  >()

  for (const cardOption of cardOptions) {
    if (!selectedCardIdSet.has(cardOption.id)) {
      continue
    }

    const existingCard = cardsByDeckCardId.get(cardOption.deckCardId)

    if (existingCard) {
      existingCard.quantity += 1
      continue
    }

    cardsByDeckCardId.set(cardOption.deckCardId, {
      deckCardId: cardOption.deckCardId,
      quantity: 1,
    })
  }

  return Array.from(cardsByDeckCardId.values())
}

function CreateSavedSeedModal({
  deckId,
  onClose,
  onSaved,
}: {
  deckId: string
  onClose: () => void
  onSaved: (seed: SavedSeed) => void
}) {
  const [seedName, setSeedName] = useState("")
  const [seedValue, setSeedValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedSeedName = seedName.trim()
    const trimmedSeedValue = seedValue.trim()

    if (!trimmedSeedName) {
      setError("Seed name is required.")
      return
    }

    if (!trimmedSeedValue) {
      setError("Seed value is required.")
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/saved-seeds`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: trimmedSeedName,
            seed: trimmedSeedValue,
          }),
        }
      )

      if (!response.ok) {
        setError(await readApiError(response, "Seed could not be saved."))
        return
      }

      const data = (await response.json()) as CreateSavedSeedResponse
      onSaved(data.savedSeed)
    } catch {
      setError("Seed could not be sent to the server.")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={isSaving ? undefined : onClose}
    >
      <section
        aria-labelledby="create-saved-seed-title"
        className="flex max-h-[calc(100svh-3rem)] w-full max-w-lg flex-col rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id="create-saved-seed-title" className="text-xl font-semibold">
              New seed
            </h2>
            <p className="text-sm text-muted-foreground">
              Name this seed so it can be reused with this deck.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={isSaving}
          >
            <X />
          </Button>
        </header>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto px-5 py-5">
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="saved-seed-name"
            >
              <span>Name</span>
              <input
                id="saved-seed-name"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                type="text"
                value={seedName}
                disabled={isSaving}
                onChange={(event) => {
                  setSeedName(event.target.value)
                  setError(null)
                }}
              />
            </label>

            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="saved-seed-value"
            >
              <span>Seed</span>
              <input
                id="saved-seed-value"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                type="text"
                value={seedValue}
                disabled={isSaving}
                onChange={(event) => {
                  setSeedValue(event.target.value)
                  setError(null)
                }}
              />
            </label>

            {error ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              <Save data-icon="inline-start" />
              {isSaving ? "Saving..." : "Save seed"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function CreateStartingHandModal({
  cardOptions,
  deckId,
  onClose,
  onSaved,
}: {
  cardOptions: OpeningHandCardOption[]
  deckId: string
  onClose: () => void
  onSaved: (hand: StartingHand) => void
}) {
  const [handName, setHandName] = useState("")
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const selectedCardIdSet = useMemo(
    () => new Set(selectedCardIds),
    [selectedCardIds]
  )
  const hasExactlySevenCards = selectedCardIds.length === 7

  function toggleCard(cardId: string) {
    setSelectedCardIds((currentCardIds) => {
      if (currentCardIds.includes(cardId)) {
        return currentCardIds.filter(
          (currentCardId) => currentCardId !== cardId
        )
      }

      if (currentCardIds.length >= 7) {
        return currentCardIds
      }

      return [...currentCardIds, cardId]
    })
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const trimmedHandName = handName.trim()

    if (!trimmedHandName) {
      setError("Starting hand name is required.")
      return
    }

    if (!hasExactlySevenCards) {
      setError("Select exactly 7 cards.")
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/starting-hands`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: trimmedHandName,
            cards: getSelectedStartingHandCards(selectedCardIds, cardOptions),
          }),
        }
      )

      if (!response.ok) {
        setError(
          await readApiError(response, "Starting hand could not be saved.")
        )
        return
      }

      const data = (await response.json()) as CreateStartingHandResponse
      onSaved(data.startingHand)
    } catch {
      setError("Starting hand could not be sent to the server.")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={isSaving ? undefined : onClose}
    >
      <section
        aria-labelledby="create-starting-hand-title"
        className="flex max-h-[calc(100svh-3rem)] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2
              id="create-starting-hand-title"
              className="text-xl font-semibold"
            >
              New starting hand
            </h2>
            <p className="text-sm text-muted-foreground">
              Name this hand and choose exactly 7 cards.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={isSaving}
          >
            <X />
          </Button>
        </header>

        <form className="flex min-h-0 flex-1 flex-col" onSubmit={handleSubmit}>
          <div className="grid min-h-0 gap-4 overflow-y-auto px-5 py-5">
            <label
              className="grid gap-2 text-sm font-medium"
              htmlFor="starting-hand-name"
            >
              <span>Name</span>
              <input
                id="starting-hand-name"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/25 disabled:cursor-not-allowed disabled:opacity-50"
                type="text"
                value={handName}
                placeholder="Fast Sol Ring hand"
                disabled={isSaving}
                onChange={(event) => {
                  setHandName(event.target.value)
                  setError(null)
                }}
              />
            </label>

            <div className="grid gap-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <p
                  className={
                    hasExactlySevenCards
                      ? "text-sky-300"
                      : "text-muted-foreground"
                  }
                >
                  {selectedCardIds.length} of 7 selected
                </p>
                {!hasExactlySevenCards ? (
                  <p className="text-muted-foreground">
                    Select exactly 7 cards.
                  </p>
                ) : null}
              </div>

              <div className="max-h-80 overflow-y-auto rounded-md border border-border bg-background/35 p-2">
                <ul className="grid gap-1">
                  {cardOptions.map((card) => {
                    const isSelected = selectedCardIdSet.has(card.id)
                    const isDisabled =
                      isSaving || (!isSelected && selectedCardIds.length >= 7)

                    return (
                      <li key={card.id}>
                        <label
                          className={`flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                            isSelected
                              ? "bg-accent text-accent-foreground"
                              : isDisabled
                                ? "text-muted-foreground/55"
                                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                          }`}
                        >
                          <input
                            className="size-4 accent-sky-300"
                            type="checkbox"
                            checked={isSelected}
                            disabled={isDisabled}
                            onChange={() => {
                              toggleCard(card.id)
                              setError(null)
                            }}
                          />
                          <span>{card.name}</span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              </div>
            </div>

            {error ? (
              <p
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-border px-5 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving || !hasExactlySevenCards}>
              <Save data-icon="inline-start" />
              {isSaving ? "Saving..." : "Save hand"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

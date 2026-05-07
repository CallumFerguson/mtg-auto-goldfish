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
  type TransitionEvent,
  type UIEvent,
} from "react"
import ReactMarkdown from "react-markdown"
import {
  BookCopy,
  Bug,
  Check,
  ChevronRight,
  ClipboardCheck,
  ClipboardCopy,
  Dices,
  Eye,
  EyeOff,
  FileText,
  LoaderCircle,
  MoreVertical,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shuffle,
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
  LlmRunFullPromptResponse,
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
  formatSimulationRunClipboardText,
  getLoggedTurnAction,
  getSimulationRunActivityBlocks,
  getSimulationRunActiveToolCallName,
  getSimulationResultEntries,
  hasSimulationRunFinalParsedOutputChunk,
  type SimulationRunActivityBlock,
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

const DEFAULT_TURNS_TO_SIMULATE = "1"
const ACTIVITY_PANEL_EXIT_FALLBACK_MS = 350

async function writePlainTextToClipboard(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // Fall through to the textarea path for browsers that block Clipboard API.
    }
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "")
  textarea.style.left = "0"
  textarea.style.opacity = "0"
  textarea.style.position = "fixed"
  textarea.style.top = "0"

  document.body.append(textarea)
  textarea.focus()
  textarea.select()

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy failed.")
    }
  } finally {
    textarea.remove()
  }
}

async function loadLlmRunFullPrompt({
  deckId,
  llmRunId,
  simulationId,
}: {
  deckId: string
  llmRunId: string
  simulationId: string
}) {
  const response = await fetch(
    `${API_BASE_URL}/decks/${deckId}/simulations/${simulationId}/llm-runs/${llmRunId}/full-prompt`
  )

  if (!response.ok) {
    throw new Error(await readApiError(response, "Prompt could not be loaded."))
  }

  const data = (await response.json()) as LlmRunFullPromptResponse

  return data.fullPrompt
}

function getSimulationLabel(simulation: Simulation) {
  return `${simulation.id.slice(0, 8)} - ${simulation.completedLlmRunCount} runs`
}

function getSimulationRunCountFromResults(resultsInfo: SimulationResultsInfo) {
  return (
    getCurrentOpeningHandRunCount(resultsInfo) +
    resultsInfo.turnLlmRuns.filter(isCountedTurnRun).length +
    resultsInfo.reportLlmRuns.filter(isCountedReportRun).length
  )
}

function getActiveLlmRunCountFromResults(resultsInfo: SimulationResultsInfo) {
  return [
    ...resultsInfo.openingHandLlmRuns,
    ...resultsInfo.turnLlmRuns,
    ...resultsInfo.reportLlmRuns,
  ].filter((run) => isActiveLlmRunStatus(run.status)).length
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

  return `${minutes}m ${seconds}s`
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
  const [turnsToSimulate, setTurnsToSimulate] = useState(
    DEFAULT_TURNS_TO_SIMULATE
  )
  const [autoGenerateReport, setAutoGenerateReport] = useState(false)
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
    setTurnsToSimulate(DEFAULT_TURNS_TO_SIMULATE)
    setAutoGenerateReport(false)
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
            autoGenerateReport,
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

                    <label className="flex items-center gap-2 rounded-md border border-border bg-background/35 px-3 py-3 text-sm text-muted-foreground transition-colors has-checked:border-ring has-checked:bg-accent has-checked:text-accent-foreground">
                      <input
                        className="size-4 accent-sky-300"
                        type="checkbox"
                        checked={autoGenerateReport}
                        onChange={(event) =>
                          setAutoGenerateReport(event.target.checked)
                        }
                      />
                      Auto-generate report after final turn
                    </label>

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
                <div className="rounded-md border border-border bg-background/35 p-3">
                  <dt className="text-muted-foreground">
                    Auto-generate report
                  </dt>
                  <dd className="mt-1 font-medium text-foreground">
                    {simulation.autoGenerateReport ? "Yes" : "No"}
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
  const [isStartingReportRun, setIsStartingReportRun] = useState(false)
  const [reportRunError, setReportRunError] = useState<string | null>(null)
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
  const [selectedActivityRunId, setSelectedActivityRunId] = useState<
    string | null
  >(null)
  const [activityPanelRunId, setActivityPanelRunId] = useState<string | null>(
    null
  )
  const [isActivityPanelOpen, setIsActivityPanelOpen] = useState(false)
  const openActivityPanelFrameRef = useRef<number | null>(null)
  const shouldSimulateOpeningHand = simulation.startingHandId === null
  const activityRuns = useMemo(() => {
    if (!resultsInfo) {
      return []
    }

    return [
      ...resultsInfo.openingHandLlmRuns,
      ...resultsInfo.turnLlmRuns,
      ...resultsInfo.reportLlmRuns,
    ]
  }, [resultsInfo])
  const selectedActivityRun = useMemo(() => {
    if (selectedActivityRunId === null) {
      return null
    }

    return (
      activityRuns.find((run) => run.llmRunId === selectedActivityRunId) ?? null
    )
  }, [activityRuns, selectedActivityRunId])
  const activityPanelRun = useMemo(() => {
    if (activityPanelRunId === null) {
      return null
    }

    return (
      activityRuns.find((run) => run.llmRunId === activityPanelRunId) ?? null
    )
  }, [activityPanelRunId, activityRuns])

  useEffect(() => {
    simulationRef.current = simulation
  }, [simulation])

  const clearOpenActivityPanelFrame = useCallback(() => {
    if (openActivityPanelFrameRef.current === null) {
      return
    }

    window.cancelAnimationFrame(openActivityPanelFrameRef.current)
    openActivityPanelFrameRef.current = null
  }, [])

  const closeActivityPanel = useCallback(() => {
    clearOpenActivityPanelFrame()
    setSelectedActivityRunId(null)
    setIsActivityPanelOpen(false)

    if (!isActivityPanelOpen) {
      setActivityPanelRunId(null)
    }
  }, [clearOpenActivityPanelFrame, isActivityPanelOpen])

  const openActivityPanel = useCallback(
    (llmRunId: string) => {
      clearOpenActivityPanelFrame()
      setSelectedActivityRunId(llmRunId)
      setActivityPanelRunId(llmRunId)

      if (isActivityPanelOpen || activityPanelRunId !== null) {
        setIsActivityPanelOpen(true)
        return
      }

      setIsActivityPanelOpen(false)
      openActivityPanelFrameRef.current = window.requestAnimationFrame(() => {
        openActivityPanelFrameRef.current = null
        setIsActivityPanelOpen(true)
      })
    },
    [activityPanelRunId, clearOpenActivityPanelFrame, isActivityPanelOpen]
  )

  const toggleActivityRun = useCallback(
    (llmRunId: string) => {
      if (selectedActivityRunId === llmRunId) {
        closeActivityPanel()
        return
      }

      openActivityPanel(llmRunId)
    },
    [closeActivityPanel, openActivityPanel, selectedActivityRunId]
  )

  const handleActivityPanelExited = useCallback(() => {
    setActivityPanelRunId(null)
  }, [])

  useEffect(() => {
    return () => {
      clearOpenActivityPanelFrame()
    }
  }, [clearOpenActivityPanelFrame])

  useEffect(() => {
    if (resultsInfo === null) {
      return
    }

    const isSelectedRunMissing =
      selectedActivityRunId !== null && selectedActivityRun === null
    const isPanelRunMissing =
      activityPanelRunId !== null && activityPanelRun === null

    if (!isSelectedRunMissing && !isPanelRunMissing) {
      return
    }

    clearOpenActivityPanelFrame()

    if (isSelectedRunMissing) {
      setSelectedActivityRunId(null)
    }

    if (isPanelRunMissing) {
      setActivityPanelRunId(null)
    }

    setIsActivityPanelOpen(false)
  }, [
    activityPanelRun,
    activityPanelRunId,
    clearOpenActivityPanelFrame,
    resultsInfo,
    selectedActivityRun,
    selectedActivityRunId,
  ])

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
    setIsStartingReportRun(false)
    setReportRunError(null)
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
    setSelectedActivityRunId(null)
    setActivityPanelRunId(null)
    setIsActivityPanelOpen(false)
    clearOpenActivityPanelFrame()
  }, [clearOpenActivityPanelFrame, scrollResultsToBottom, simulation.id])

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
      isStartingReportRun ||
      isStoppingSimulation
    ) {
      return
    }

    setIsStartingOpeningHandRun(true)
    setOpeningHandRunError(null)
    setTurnRunError(null)
    setReportRunError(null)

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
    if (
      isStartingTurnRun ||
      isStartingOpeningHandRun ||
      isStartingReportRun ||
      isStoppingSimulation
    ) {
      return
    }

    if (!Number.isInteger(turnNumber) || turnNumber < 1) {
      setTurnRunError("Turn number must be a positive integer.")
      return
    }

    setIsStartingTurnRun(true)
    setTurnRunError(null)
    setOpeningHandRunError(null)
    setReportRunError(null)

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

  async function handleStartReportRun() {
    if (
      isStartingReportRun ||
      isStartingTurnRun ||
      isStartingOpeningHandRun ||
      isStoppingSimulation
    ) {
      return
    }

    setIsStartingReportRun(true)
    setReportRunError(null)
    setTurnRunError(null)
    setOpeningHandRunError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/report-llm-runs`,
        {
          method: "POST",
        }
      )

      if (!response.ok) {
        setReportRunError(
          await readApiError(response, "Report run could not be started.")
        )
        return
      }

      setResultsStreamRestartKey((currentKey) => currentKey + 1)
    } catch {
      setReportRunError("Report run could not be sent to the server.")
    } finally {
      setIsStartingReportRun(false)
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
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
      <main
        ref={resultsPanelRef}
        className="simulation-scrollbar h-full min-h-0 min-w-0 flex-1 overflow-y-auto px-5 py-6"
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
              isStartingReportRun={isStartingReportRun}
              isStartingTurnRun={isStartingTurnRun}
              isLoadingStartingHand={isLoadingStartingHand}
              isStoppingSimulation={isStoppingSimulation}
              onStartOpeningHandRun={() => void handleStartOpeningHandRun()}
              onStartReportRun={() => void handleStartReportRun()}
              onKeepResultsScrolledToBottom={keepResultsScrolledToBottom}
              onScrollResultsToBottomIfKept={scrollResultsToBottomIfKept}
              onSelectActivityRun={toggleActivityRun}
              onStartTurnRun={(turnNumber) =>
                void handleStartTurnRun(turnNumber)
              }
              onStopSimulation={() => void handleStopSimulation()}
              openingHandRunError={openingHandRunError}
              reportRunError={reportRunError}
              resultsInfo={resultsInfo}
              selectedActivityRunId={selectedActivityRunId}
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

      {activityPanelRun ? (
        <SimulationRunActivityPanel
          deckId={deckId}
          isOpen={isActivityPanelOpen}
          run={activityPanelRun}
          simulationId={simulation.id}
          onClose={closeActivityPanel}
          onExited={handleActivityPanelExited}
        />
      ) : null}
    </div>
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
  isStartingReportRun,
  isStartingTurnRun,
  isLoadingStartingHand,
  isStoppingSimulation,
  onStartOpeningHandRun,
  onKeepResultsScrolledToBottom,
  onScrollResultsToBottomIfKept,
  onSelectActivityRun,
  onStartTurnRun,
  onStartReportRun,
  onStopSimulation,
  openingHandRunError,
  reportRunError,
  resultsInfo,
  selectedActivityRunId,
  simulation,
  startingHand,
  startingHandLoadError,
  stopSimulationError,
  turnRunError,
}: {
  isStartingOpeningHandRun: boolean
  isStartingReportRun: boolean
  isStartingTurnRun: boolean
  isLoadingStartingHand: boolean
  isStoppingSimulation: boolean
  onStartOpeningHandRun: () => void
  onKeepResultsScrolledToBottom: () => void
  onScrollResultsToBottomIfKept: () => void
  onSelectActivityRun: (llmRunId: string) => void
  onStartTurnRun: (turnNumber: number) => void
  onStartReportRun: () => void
  onStopSimulation: () => void
  openingHandRunError: string | null
  reportRunError: string | null
  resultsInfo: SimulationResultsInfo
  selectedActivityRunId: string | null
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
  const isReportRunning = resultsInfo.reportLlmRuns.some((run) =>
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
    isStartingOpeningHandRun ||
    isStartingTurnRun ||
    isStartingReportRun ||
    isStoppingSimulation
  const isSimulationActionBlocked =
    isStartingSimulationRun ||
    isOpeningHandRunning ||
    isTurnRunning ||
    isReportRunning ||
    simulation.activeLlmRunCount > 0
  const canStartReportRun =
    !isSimulationActionBlocked && resultsInfo.reportLlmRuns.length === 0
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

  const actionError = openingHandRunError ?? turnRunError ?? reportRunError
  const runs = [
    ...resultsInfo.openingHandLlmRuns.map((run) => ({
      ...run,
      canRerun: canStartOpeningHandRun && !isOpeningHandRunning,
      isActive: isActiveLlmRunStatus(run.status),
      resultKind: "opening_hand" as const,
      resultLabel: `Opening hand attempt ${run.attemptNumber}`,
      resultEntries: getSimulationResultEntries(run.chunks),
      activeToolCallName: getSimulationRunActiveToolCallName(run.chunks),
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
      hasFinalParsedOutputChunk: hasSimulationRunFinalParsedOutputChunk(
        run.chunks
      ),
    })),
    ...resultsInfo.reportLlmRuns.map((run) => ({
      ...run,
      canRerun: !isSimulationActionBlocked,
      isActive: isActiveLlmRunStatus(run.status),
      resultKind: "report" as const,
      resultLabel: `Report attempt ${run.attemptNumber}`,
      resultEntries: getSimulationResultEntries(run.chunks),
      activeToolCallName: getSimulationRunActiveToolCallName(run.chunks),
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
        const shouldShowFinishedThinkingStatus =
          !run.isActive && getSimulationRunFinishedTimeMs(run) !== null
        const finishedThinkingStatus = shouldShowFinishedThinkingStatus ? (
          <SimulationResultThinkingStatus
            activeToolCallName={null}
            canStopSimulation={false}
            finishedDurationText={finishedDurationText}
            isFinishedSuccessfully={run.status === "completed"}
            isFinished={true}
            isActivitySelected={selectedActivityRunId === run.llmRunId}
            isStoppingSimulation={false}
            onViewActivity={() => onSelectActivityRun(run.llmRunId)}
            onStopSimulation={onStopSimulation}
            runStartTimeMs={null}
            stopSimulationError={null}
          />
        ) : null
        const runMetadata = [
          run.status,
          run.model,
          run.estimatedPriceCents ? `${run.estimatedPriceCents} cents` : null,
          finishedDurationText ? `took ${finishedDurationText}` : null,
          run.outdated ? "outdated" : null,
        ].filter(Boolean)
        const hasLiveReport =
          run.resultKind === "report" &&
          !run.hasFinalParsedOutputChunk &&
          getReportTextFromChunks(run.chunks) !== null

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
                      : run.resultKind === "report"
                        ? "Rerun report"
                        : `Rerun turn ${run.turnNumber}`
                  }
                  title={
                    run.resultKind === "opening_hand"
                      ? "Rerun opening hand"
                      : run.resultKind === "report"
                        ? "Rerun report"
                        : `Rerun turn ${run.turnNumber}`
                  }
                  onClick={() => {
                    if (run.resultKind === "opening_hand") {
                      onStartOpeningHandRun()
                      return
                    }

                    if (run.resultKind === "report") {
                      onStartReportRun()
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

            {run.resultEntries.length > 0 ||
            finishedThinkingStatus ||
            hasLiveReport ? (
              <SimulationResultChunkCards
                run={run}
                entries={run.resultEntries}
                finishedThinkingStatus={finishedThinkingStatus}
              />
            ) : null}

            {run.isActive && !run.hasFinalParsedOutputChunk ? (
              <SimulationResultThinkingStatus
                activeToolCallName={run.activeToolCallName}
                canStopSimulation={run.status !== "cancel_requested"}
                finishedDurationText={null}
                isFinishedSuccessfully={false}
                isFinished={false}
                isActivitySelected={selectedActivityRunId === run.llmRunId}
                isStoppingSimulation={isStoppingSimulation}
                onViewActivity={() => onSelectActivityRun(run.llmRunId)}
                onStopSimulation={onStopSimulation}
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

      <div className="flex min-h-8 flex-wrap justify-center gap-2">
        {renderedSimulationAction ? (
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
        ) : null}
        {canStartReportRun ? (
          <Button
            className="w-fit bg-background/35 text-foreground hover:bg-muted/45"
            variant="outline"
            type="button"
            disabled={isStartingSimulationRun}
            onClick={() => {
              onKeepResultsScrolledToBottom()
              onStartReportRun()
            }}
          >
            <FileText data-icon="inline-start" />
            Generate report
          </Button>
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
  finishedThinkingStatus,
  run,
}: {
  entries: SimulationResultEntry[]
  finishedThinkingStatus: ReactNode | null
  run: SimulationDebugLlmRun
}) {
  const finalParsedOutputEntryIndex = entries.findIndex(
    (entry) =>
      entry.type === "chunk" && entry.chunk.kind === "final_parsed_output"
  )
  const finishedThinkingStatusIndex =
    finishedThinkingStatus === null
      ? -1
      : finalParsedOutputEntryIndex === -1
        ? entries.length > 0
          ? entries.length - 1
          : -1
        : finalParsedOutputEntryIndex
  const shouldAppendFinishedThinkingStatus =
    finishedThinkingStatus !== null && finishedThinkingStatusIndex === -1
  const liveReport =
    run.phase === "report" && finalParsedOutputEntryIndex === -1
      ? getReportTextFromChunks(run.chunks)
      : null

  function renderEntry(entry: SimulationResultEntry) {
    if (entry.type === "turn_action_log") {
      return (
        <SimulationResultLoggedTurnActionEvent
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
            finalOutput={finalOutput}
            cardMentions={chunk.cardMentions}
          />
        )
      }
    }

    return <SimulationResultEvent chunk={chunk} />
  }

  return (
    <div className="grid gap-2">
      {liveReport ? (
        <div
          className={`grid gap-3 p-3 ${simulationResultChunkSurfaceClassName}`}
        >
          <SimulationReportMarkdown report={liveReport} />
        </div>
      ) : null}
      {entries.map((entry, index) => (
        <Fragment key={entry.id}>
          {index === finishedThinkingStatusIndex
            ? finishedThinkingStatus
            : null}
          {renderEntry(entry)}
        </Fragment>
      ))}
      {shouldAppendFinishedThinkingStatus ? finishedThinkingStatus : null}
    </div>
  )
}

function getReportTextFromChunks(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const report = [...chunks]
    .sort(
      (firstChunk, secondChunk) => firstChunk.sequence - secondChunk.sequence
    )
    .map((chunk) =>
      chunk.kind === "message_delta" ? (chunk.outputDelta ?? "") : ""
    )
    .join("")
    .trim()

  return report.length > 0 ? report : null
}

function SimulationResultThinkingStatus({
  activeToolCallName,
  canStopSimulation,
  finishedDurationText,
  isFinished,
  isFinishedSuccessfully,
  isActivitySelected,
  isStoppingSimulation,
  onViewActivity,
  onStopSimulation,
  runStartTimeMs,
  stopSimulationError,
}: {
  activeToolCallName: string | null
  canStopSimulation: boolean
  finishedDurationText: string | null
  isFinished: boolean
  isFinishedSuccessfully: boolean
  isActivitySelected: boolean
  isStoppingSimulation: boolean
  onViewActivity: () => void
  onStopSimulation: () => void
  runStartTimeMs: number | null
  stopSimulationError: string | null
}) {
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now())

  useEffect(() => {
    if (isFinished) {
      return
    }

    const intervalId = window.setInterval(() => {
      setCurrentTimeMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [isFinished])

  const activeToolCallLabel =
    activeToolCallName === null
      ? null
      : getKnownSimulationResultToolLabel({
          mcpFunctionName: activeToolCallName,
          state: "active",
        })
  const activeElapsedText =
    runStartTimeMs === null || isFinished
      ? null
      : formatMinutesSeconds(currentTimeMs - runStartTimeMs)
  const statusLabel = isFinished
    ? finishedDurationText
      ? `Thought for ${finishedDurationText}`
      : "Thought"
    : activeToolCallName
      ? (activeToolCallLabel ?? `Calling tool: ${activeToolCallName}`)
      : "Thinking"

  return (
    <div className="grid gap-2 py-1 select-none">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <button
          className="group inline-flex max-w-full min-w-0 flex-1 items-center gap-2 rounded-sm px-0.5 py-1 text-left text-sm font-medium text-sky-200 transition-colors hover:text-sky-100 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none"
          type="button"
          aria-pressed={isActivitySelected}
          title={
            isActivitySelected
              ? "Close thinking activity"
              : "View thinking activity"
          }
          onClick={onViewActivity}
        >
          {isFinished ? (
            isFinishedSuccessfully ? (
              <Check className="size-4 shrink-0 text-emerald-300" />
            ) : (
              <X className="size-4 shrink-0 text-destructive" />
            )
          ) : (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-sky-300" />
          )}
          <span className="min-w-0 truncate">{statusLabel}</span>
          {activeElapsedText ? (
            <span className="shrink-0 text-xs font-normal text-sky-100/65 tabular-nums">
              {activeElapsedText}
            </span>
          ) : null}
          <ChevronRight
            className="size-4 shrink-0 text-sky-300/70 transition-transform group-hover:translate-x-0.5 group-hover:text-sky-100"
            aria-hidden="true"
          />
        </button>
        {canStopSimulation ? (
          <Button
            className="size-8 rounded-full border border-border/80 bg-background/20 text-muted-foreground hover:border-sky-300/50 hover:text-foreground"
            type="button"
            variant="ghost"
            size="icon"
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
      {stopSimulationError ? (
        <p
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          role="alert"
        >
          {stopSimulationError}
        </p>
      ) : null}
    </div>
  )
}

function SimulationRunActivityPanel({
  deckId,
  isOpen,
  onClose,
  onExited,
  run,
  simulationId,
}: {
  deckId: string
  isOpen: boolean
  onClose: () => void
  onExited: () => void
  run: SimulationDebugLlmRun
  simulationId: string
}) {
  const activityScrollRef = useRef<HTMLDivElement | null>(null)
  const keepActivityScrolledDownRef = useRef(true)
  const isProgrammaticActivityScrollRef = useRef(false)
  const previousActivityScrollTopRef = useRef(0)
  const exitTimeoutRef = useRef<number | null>(null)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const hasOpenedRef = useRef(false)
  const [currentTimeMs, setCurrentTimeMs] = useState(() => Date.now())
  const [copiedState, setCopiedState] = useState<{
    llmRunId: string
    mode: "run_text" | "with_prompt"
  } | null>(null)
  const [isCopyingWithPrompt, setIsCopyingWithPrompt] = useState(false)
  const activityBlocks = useMemo(
    () => getSimulationRunActivityBlocks(run.chunks),
    [run.chunks]
  )
  const activityTimelineItems = useMemo(
    () => getSimulationRunActivityTimelineItems(activityBlocks),
    [activityBlocks]
  )
  const runClipboardText = useMemo(
    () => formatSimulationRunClipboardText(run),
    [run]
  )
  const copiedMode =
    copiedState?.llmRunId === run.llmRunId ? copiedState.mode : null
  const runStartTimeMs = getSimulationRunStartTimeMs(run)
  const runFinishedTimeMs = getSimulationRunFinishedTimeMs(run)
  const durationText =
    runStartTimeMs === null
      ? null
      : formatMinutesSeconds(
          (runFinishedTimeMs ?? currentTimeMs) - runStartTimeMs
        )
  const terminalActivityStatus = useMemo(
    () => getSimulationRunTerminalActivityStatus(run.status, durationText),
    [durationText, run.status]
  )

  const clearExitTimeout = useCallback(() => {
    if (exitTimeoutRef.current === null) {
      return
    }

    window.clearTimeout(exitTimeoutRef.current)
    exitTimeoutRef.current = null
  }, [])

  const clearCopyResetTimeout = useCallback(() => {
    if (copyResetTimeoutRef.current === null) {
      return
    }

    window.clearTimeout(copyResetTimeoutRef.current)
    copyResetTimeoutRef.current = null
  }, [])

  const finishExit = useCallback(() => {
    if (isOpen) {
      return
    }

    clearExitTimeout()
    onExited()
  }, [clearExitTimeout, isOpen, onExited])

  const scrollActivityToBottom = useCallback(() => {
    const activityScrollElement = activityScrollRef.current

    if (!activityScrollElement) {
      return
    }

    isProgrammaticActivityScrollRef.current = true
    activityScrollElement.scrollTo({
      top: activityScrollElement.scrollHeight,
    })

    window.requestAnimationFrame(() => {
      previousActivityScrollTopRef.current = activityScrollElement.scrollTop
      isProgrammaticActivityScrollRef.current = false
    })
  }, [])

  useEffect(() => {
    if (isOpen) {
      hasOpenedRef.current = true
      clearExitTimeout()
      return
    }

    if (!hasOpenedRef.current) {
      return
    }

    exitTimeoutRef.current = window.setTimeout(
      finishExit,
      ACTIVITY_PANEL_EXIT_FALLBACK_MS
    )

    return clearExitTimeout
  }, [clearExitTimeout, finishExit, isOpen])

  useEffect(() => clearCopyResetTimeout, [clearCopyResetTimeout, run.llmRunId])

  useEffect(() => {
    keepActivityScrolledDownRef.current = true
    previousActivityScrollTopRef.current = 0
    scrollActivityToBottom()
  }, [run.llmRunId, scrollActivityToBottom])

  useEffect(() => {
    if (runFinishedTimeMs !== null) {
      return
    }

    const intervalId = window.setInterval(() => {
      setCurrentTimeMs(Date.now())
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [run.llmRunId, runFinishedTimeMs])

  useLayoutEffect(() => {
    if (keepActivityScrolledDownRef.current) {
      scrollActivityToBottom()
    }
  }, [activityTimelineItems, scrollActivityToBottom, terminalActivityStatus])

  useEffect(() => {
    const activityScrollElement = activityScrollRef.current

    if (!activityScrollElement) {
      return
    }

    const resizeObserver = new ResizeObserver(() => {
      if (keepActivityScrolledDownRef.current) {
        scrollActivityToBottom()
      }
    })

    resizeObserver.observe(activityScrollElement)

    return () => {
      resizeObserver.disconnect()
    }
  }, [scrollActivityToBottom])

  function handleActivityScroll(event: UIEvent<HTMLDivElement>) {
    const activityScrollElement = event.currentTarget
    const distanceFromBottom =
      activityScrollElement.scrollHeight -
      activityScrollElement.clientHeight -
      activityScrollElement.scrollTop

    if (distanceFromBottom <= 4) {
      keepActivityScrolledDownRef.current = true
    } else if (
      !isProgrammaticActivityScrollRef.current &&
      activityScrollElement.scrollTop < previousActivityScrollTopRef.current
    ) {
      keepActivityScrolledDownRef.current = false
    }

    previousActivityScrollTopRef.current = activityScrollElement.scrollTop
  }

  async function handleCopyRunText(mode: "run_text" | "with_prompt") {
    try {
      let text = runClipboardText

      if (mode === "with_prompt") {
        setIsCopyingWithPrompt(true)
        const fullPrompt = await loadLlmRunFullPrompt({
          deckId,
          llmRunId: run.llmRunId,
          simulationId,
        })

        text = formatSimulationRunClipboardText(run, { fullPrompt })
      }

      await writePlainTextToClipboard(text)
      setCopiedState({
        llmRunId: run.llmRunId,
        mode,
      })
      clearCopyResetTimeout()
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedState(null)
        copyResetTimeoutRef.current = null
      }, 1400)
    } catch (error) {
      console.error("Failed to copy LLM run text:", error)
    } finally {
      if (mode === "with_prompt") {
        setIsCopyingWithPrompt(false)
      }
    }
  }

  function handlePanelTransitionEnd(event: TransitionEvent<HTMLDivElement>) {
    if (
      event.target !== event.currentTarget ||
      event.propertyName !== "width"
    ) {
      return
    }

    finishExit()
  }

  return (
    <div
      className={`h-full min-h-0 shrink-0 overflow-hidden transition-[width] duration-300 ease-out motion-reduce:transition-none ${
        isOpen ? "w-[clamp(18rem,30vw,24rem)]" : "w-0"
      }`}
      onTransitionEnd={handlePanelTransitionEnd}
    >
      <aside
        className="flex h-full min-h-0 w-[clamp(18rem,30vw,24rem)] flex-col border-l border-border bg-background/80"
        aria-label="Simulation activity"
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">
            {durationText ? `Activity • ${durationText}` : "Activity"}
          </h3>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              className={
                copiedMode === "with_prompt"
                  ? "text-emerald-300 hover:text-emerald-200"
                  : "text-muted-foreground hover:text-foreground"
              }
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy activity with prompt"
              title="Copy activity with prompt"
              disabled={isCopyingWithPrompt}
              onClick={() => void handleCopyRunText("with_prompt")}
            >
              {isCopyingWithPrompt ? (
                <LoaderCircle className="animate-spin" />
              ) : copiedMode === "with_prompt" ? (
                <ClipboardCheck />
              ) : (
                <BookCopy />
              )}
            </Button>
            <Button
              className={
                copiedMode === "run_text"
                  ? "text-emerald-300 hover:text-emerald-200"
                  : "text-muted-foreground hover:text-foreground"
              }
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Copy activity text"
              title="Copy activity text"
              disabled={runClipboardText.length === 0}
              onClick={() => void handleCopyRunText("run_text")}
            >
              {copiedMode === "run_text" ? (
                <ClipboardCheck />
              ) : (
                <ClipboardCopy />
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Close activity"
              title="Close activity"
              onClick={onClose}
            >
              <X />
            </Button>
          </div>
        </header>

        <div
          ref={activityScrollRef}
          className="simulation-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-5"
          onScroll={handleActivityScroll}
        >
          <div className="grid gap-4">
            {activityTimelineItems.length > 0 ? (
              <>
                <p className="text-base font-semibold text-sky-100">Thinking</p>
                <div className="grid gap-5">
                  {activityTimelineItems.map((item) => (
                    <SimulationRunActivityTimelineItemView
                      key={item.id}
                      item={item}
                    />
                  ))}
                  {terminalActivityStatus ? (
                    <SimulationRunActivityTerminalStatus
                      status={terminalActivityStatus}
                    />
                  ) : null}
                </div>
              </>
            ) : (
              <div className="grid gap-5">
                <p className="text-sm text-muted-foreground">
                  No activity recorded yet.
                </p>
                {terminalActivityStatus ? (
                  <SimulationRunActivityTerminalStatus
                    status={terminalActivityStatus}
                  />
                ) : null}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

type SimulationRunTerminalActivityStatus = {
  detail: string
  title: string
  tone: "error" | "muted" | "success"
}

function getSimulationRunTerminalActivityStatus(
  runStatus: string,
  durationText: string | null
): SimulationRunTerminalActivityStatus | null {
  const title = durationText ? `Thought for ${durationText}` : "Thought"

  if (runStatus === "completed") {
    return {
      detail: "Done",
      title,
      tone: "success",
    }
  }

  if (runStatus === "failed") {
    return {
      detail: "Error",
      title,
      tone: "error",
    }
  }

  if (runStatus === "cancelled") {
    return {
      detail: "Canceled",
      title,
      tone: "muted",
    }
  }

  return null
}

function SimulationRunActivityTerminalStatus({
  status,
}: {
  status: SimulationRunTerminalActivityStatus
}) {
  return (
    <SimulationRunActivityTimelineRow marker={status.tone}>
      <div className="grid gap-0.5 text-sm leading-6">
        <p className="font-medium text-foreground/95">{status.title}</p>
        <p
          className={
            status.tone === "error"
              ? "text-destructive"
              : "text-muted-foreground"
          }
        >
          {status.detail}
        </p>
      </div>
    </SimulationRunActivityTimelineRow>
  )
}

type SimulationRunActivityTimelineItem =
  | {
      id: string
      type: "reasoning"
      block: Extract<SimulationRunActivityBlock, { type: "reasoning" }>
    }
  | {
      id: string
      type: "tool_call_group"
      blocks: Extract<SimulationRunActivityBlock, { type: "tool_call" }>[]
    }

function getSimulationRunActivityTimelineItems(
  blocks: readonly SimulationRunActivityBlock[]
): SimulationRunActivityTimelineItem[] {
  const timelineItems: SimulationRunActivityTimelineItem[] = []
  let pendingToolCallBlocks: Extract<
    SimulationRunActivityBlock,
    { type: "tool_call" }
  >[] = []

  function flushPendingToolCalls() {
    if (pendingToolCallBlocks.length === 0) {
      return
    }

    const firstBlock = pendingToolCallBlocks[0]
    const lastBlock = pendingToolCallBlocks[pendingToolCallBlocks.length - 1]

    timelineItems.push({
      id:
        firstBlock === lastBlock
          ? `tool-group-${firstBlock.id}`
          : `tool-group-${firstBlock.id}-${lastBlock.id}`,
      type: "tool_call_group",
      blocks: pendingToolCallBlocks,
    })
    pendingToolCallBlocks = []
  }

  for (const block of blocks) {
    if (block.type === "tool_call") {
      pendingToolCallBlocks.push(block)
      continue
    }

    flushPendingToolCalls()
    timelineItems.push({
      id: block.id,
      type: "reasoning",
      block,
    })
  }

  flushPendingToolCalls()

  return timelineItems
}

function SimulationRunActivityTimelineItemView({
  item,
}: {
  item: SimulationRunActivityTimelineItem
}) {
  if (item.type === "tool_call_group") {
    return (
      <SimulationRunActivityTimelineRow marker="tool">
        <div className="flex min-w-0 flex-wrap gap-1.5 pt-0.5">
          {item.blocks.map((block) => (
            <span
              key={block.id}
              className="inline-flex max-w-full items-center gap-1 rounded-full bg-muted/55 px-2.5 py-1 text-xs leading-4 font-medium text-foreground/90"
              title={block.toolName}
            >
              <span className="text-sky-300" aria-hidden="true">
                •
              </span>
              <span className="truncate">{block.toolName}</span>
            </span>
          ))}
        </div>
      </SimulationRunActivityTimelineRow>
    )
  }

  return (
    <SimulationRunActivityTimelineRow marker="reasoning">
      <div className={simulationActivityMarkdownClassName}>
        <ReactMarkdown>{item.block.text}</ReactMarkdown>
      </div>
    </SimulationRunActivityTimelineRow>
  )
}

function SimulationRunActivityTimelineRow({
  children,
  marker,
}: {
  children: ReactNode
  marker: "error" | "muted" | "reasoning" | "success" | "tool"
}) {
  const markerClassName =
    marker === "tool"
      ? "bg-sky-300"
      : marker === "success"
        ? "border border-emerald-300 text-emerald-300"
        : marker === "error"
          ? "border border-destructive text-destructive"
          : marker === "muted"
            ? "border border-muted-foreground text-muted-foreground"
            : "bg-muted-foreground"
  const markerSizeClassName =
    marker === "success" || marker === "error" || marker === "muted"
      ? "size-3"
      : "size-1.5"

  return (
    <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2">
      <div className="relative flex justify-center">
        <span
          className={`mt-2 flex items-center justify-center rounded-full ${markerSizeClassName} ${markerClassName}`}
          aria-hidden="true"
        >
          {marker === "success" ? (
            <Check className="size-2" strokeWidth={3} />
          ) : marker === "error" ? (
            <X className="size-2" strokeWidth={3} />
          ) : null}
        </span>
        <span
          className="absolute top-5 bottom-[-1.25rem] w-px bg-border"
          aria-hidden="true"
        />
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

const simulationActivityMarkdownClassName =
  "min-w-0 space-y-2 text-sm leading-6 break-words text-foreground/95 [&_a]:text-sky-300 [&_a]:underline [&_code]:rounded-sm [&_code]:bg-muted/45 [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-sky-100 [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-black/30 [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_strong]:text-foreground [&_ul]:list-disc [&_ul]:pl-5"

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
      {finalOutput.type === "report" ? null : (
        <p className="text-sm leading-6 text-muted-foreground">
          {finalOutput.summary}
        </p>
      )}

      {finalOutput.type === "opening_hand" ? (
        <SimulationOpeningHandCardsBlock
          label="Kept hand"
          mentions={getOpeningHandFinalOutputCardMentions(
            finalOutput.keptHand,
            cardMentions
          )}
        />
      ) : finalOutput.type === "turn" ? (
        <details className={simulationResultChunkSurfaceClassName}>
          <summary className={simulationResultChunkSummaryClassName}>
            Game state
          </summary>
          <p className={simulationResultChunkTextClassName}>
            {finalOutput.gameState}
          </p>
        </details>
      ) : (
        <SimulationReportMarkdown report={finalOutput.report} />
      )}
    </div>
  )
}

function SimulationReportMarkdown({ report }: { report: string }) {
  return (
    <div className={simulationActivityMarkdownClassName}>
      <ReactMarkdown>{report}</ReactMarkdown>
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
      <SimulationResultToolLabelEvent
        icon={getMcpCallCompleteIcon(chunk)}
        title={getMcpCallCompleteTitle(chunk)}
      />
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

function isCountedReportRun(
  run: SimulationResultsInfo["reportLlmRuns"][number]
) {
  return (
    run.outdated !== true &&
    (isActiveLlmRunStatus(run.status) ||
      run.status === "failed" ||
      run.status === "cancelled" ||
      (run.status === "completed" && Boolean(run.report?.trim())))
  )
}

function SimulationResultToolLabelEvent({
  icon,
  title,
}: {
  icon?: ReactNode
  title: string
}) {
  return (
    <div
      className={`${simulationResultChunkSurfaceClassName} flex min-w-0 items-center gap-2 px-3 py-2 text-sm text-muted-foreground`}
    >
      {icon ? (
        <span className="shrink-0 text-sky-300" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{title}</span>
    </div>
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

  return (
    <div className="grid grid-cols-7 gap-2 sm:gap-3">
      {cardImageMentions.map((mention, index) => (
        <a
          key={`${mention.requestedName}-image-${index}`}
          className="block min-w-0 overflow-hidden rounded-sm bg-black/40 focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:outline-none"
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

function getMcpCallCompleteIcon(chunk: SimulationDebugLlmRunChunk) {
  if (chunk.mcpFunctionName === "shuffle_library" && !isMcpCallFailure(chunk)) {
    return <Shuffle className="size-4" />
  }

  return null
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
        <div className="rounded-md border border-border bg-background/35 p-3">
          <dt className="text-muted-foreground">Report LLM runs</dt>
          <dd className="mt-1 font-medium text-foreground">
            {debugInfo.reportLlmRunCount}
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
      <SimulationDebugRunGroup
        deckId={deckId}
        heading="Report runs"
        runs={debugInfo.reportLlmRuns}
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

            {run.report ? (
              <details className="rounded-md border border-emerald-500/35 bg-emerald-950/20 shadow-sm shadow-emerald-950/20">
                <summary className="cursor-pointer border-b border-emerald-500/20 px-3 py-2 text-sm font-medium text-emerald-200 transition-colors hover:text-emerald-100">
                  Report
                </summary>
                <div className="p-3">
                  <SimulationReportMarkdown report={run.report} />
                </div>
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

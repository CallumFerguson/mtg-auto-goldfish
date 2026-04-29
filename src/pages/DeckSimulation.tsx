import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  Bug,
  Dices,
  MoreVertical,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type {
  CreateOpeningHandLlmRunResponse,
  CreateSimulationResponse,
  CreateStartingHandResponse,
  CreateTurnLlmRunResponse,
  DeckCard,
  Simulation,
  SimulationDebugInfo,
  SimulationDebugLlmRunChunk,
  SimulationResultsInfo,
  SimulationResultsResponse,
  SimulationsResponse,
  SimulationDebugResponse,
  StartingHand,
  StartingHandsResponse,
  StopSimulationResponse,
} from "@/lib/deck-types"
import { getDeckSimulationPath, navigateTo } from "@/lib/navigation"

type OpeningHandCardOption = {
  id: string
  deckCardId: number
  name: string
}

function getSimulationLabel(simulation: Simulation) {
  return simulation.id.slice(0, 8)
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
  const [simulationLoadError, setSimulationLoadError] = useState<string | null>(
    null
  )
  const [isNewSimulationSelected, setIsNewSimulationSelected] = useState(true)
  const [selectedSimulationId, setSelectedSimulationId] = useState("")
  const [simulationSeed, setSimulationSeed] = useState("")
  const [useRandomSeed, setUseRandomSeed] = useState(true)
  const [turnsToSimulate, setTurnsToSimulate] = useState("5")
  const [openingHandMode, setOpeningHandMode] = useState<
    "simulate" | "provide"
  >("simulate")
  const [selectedOpeningHandId, setSelectedOpeningHandId] = useState("")
  const [isCreateHandModalOpen, setIsCreateHandModalOpen] = useState(false)
  const [createSimulationError, setCreateSimulationError] = useState<
    string | null
  >(null)
  const [isCreatingSimulation, setIsCreatingSimulation] = useState(false)
  const [openSimulationMenuId, setOpenSimulationMenuId] = useState<
    string | null
  >(null)
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
  const selectedSimulation = useMemo(
    () =>
      simulations.find(
        (simulation) => simulation.id === selectedSimulationId
      ) ?? null,
    [selectedSimulationId, simulations]
  )
  const selectedSimulationStartingHand = useMemo(
    () =>
      startingHands.find(
        (hand) => hand.id === selectedSimulation?.startingHandId
      ) ?? null,
    [selectedSimulation?.startingHandId, startingHands]
  )
  const trimmedSimulationSeed = simulationSeed.trim()
  const canStartSimulation =
    (useRandomSeed || trimmedSimulationSeed.length > 0) &&
    turnsToSimulate.length > 0 &&
    (openingHandMode !== "provide" || Boolean(selectedOpeningHand))

  const loadSimulations = useCallback(async () => {
    setIsLoadingSimulations(true)
    setSimulationLoadError(null)

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
      setIsLoadingSimulations(false)
    }
  }, [deckId])

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

  useEffect(() => {
    void loadSimulations()
  }, [loadSimulations])

  useEffect(() => {
    void loadStartingHands()
  }, [loadStartingHands])

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

  function handleRandomSeedChange(isChecked: boolean) {
    setUseRandomSeed(isChecked)

    if (isChecked) {
      setSimulationSeed("")
    }
  }

  function resetCreateSimulationForm() {
    setSimulationSeed("")
    setUseRandomSeed(true)
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
            seed: useRandomSeed
              ? createRandomSimulationSeed()
              : trimmedSimulationSeed,
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
      <div className="grid h-full min-h-0 grid-rows-[minmax(11rem,16rem)_minmax(0,1fr)] overflow-hidden lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-1">
        <aside className="simulation-sidebar-surface min-h-0 min-w-0 border-b border-border lg:border-r lg:border-b-0">
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
                    <div className="grid gap-3">
                      <label
                        className="text-sm font-medium text-foreground"
                        htmlFor="simulation-seed"
                      >
                        Simulation seed
                      </label>
                      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                        <input
                          id="simulation-seed"
                          className="h-9 rounded-md border border-input bg-background/60 px-3 text-sm text-foreground transition-colors outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                          type="text"
                          value={simulationSeed}
                          placeholder="Seed"
                          disabled={useRandomSeed}
                          onChange={(event) =>
                            setSimulationSeed(event.target.value)
                          }
                        />
                        <label className="flex items-center gap-2 text-sm text-muted-foreground">
                          <input
                            className="size-4 accent-sky-300"
                            type="checkbox"
                            checked={useRandomSeed}
                            onChange={(event) =>
                              handleRandomSeedChange(event.target.checked)
                            }
                          />
                          Use random seed
                        </label>
                      </div>
                    </div>

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
              simulation={selectedSimulation}
              startingHand={selectedSimulationStartingHand}
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

function SimulationDetails({
  deckId,
  simulation,
  startingHand,
}: {
  deckId: string
  simulation: Simulation
  startingHand: StartingHand | null
}) {
  const [isStartingOpeningHandRun, setIsStartingOpeningHandRun] =
    useState(false)
  const [openingHandRunError, setOpeningHandRunError] = useState<string | null>(
    null
  )
  const [openingHandRun, setOpeningHandRun] =
    useState<CreateOpeningHandLlmRunResponse | null>(null)
  const [selectedTurnNumber, setSelectedTurnNumber] = useState("1")
  const [isStartingTurnRun, setIsStartingTurnRun] = useState(false)
  const [turnRunError, setTurnRunError] = useState<string | null>(null)
  const [turnRun, setTurnRun] = useState<CreateTurnLlmRunResponse | null>(null)
  const [isStoppingSimulation, setIsStoppingSimulation] = useState(false)
  const [stopSimulationError, setStopSimulationError] = useState<string | null>(
    null
  )
  const [stopSimulationResult, setStopSimulationResult] =
    useState<StopSimulationResponse | null>(null)
  const [isLoadingDebugInfo, setIsLoadingDebugInfo] = useState(false)
  const [debugInfoError, setDebugInfoError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<SimulationDebugInfo | null>(null)
  const [isDebugModalOpen, setIsDebugModalOpen] = useState(false)
  const isLoadingDebugInfoRef = useRef(false)
  const [isLoadingResults, setIsLoadingResults] = useState(false)
  const [resultsError, setResultsError] = useState<string | null>(null)
  const [resultsInfo, setResultsInfo] = useState<SimulationResultsInfo | null>(
    null
  )
  const isLoadingResultsRef = useRef(false)
  const resultsAbortControllerRef = useRef<AbortController | null>(null)
  const shouldSimulateOpeningHand = simulation.startingHandId === null

  useEffect(() => {
    setIsStartingOpeningHandRun(false)
    setOpeningHandRunError(null)
    setOpeningHandRun(null)
    setSelectedTurnNumber("1")
    setIsStartingTurnRun(false)
    setTurnRunError(null)
    setTurnRun(null)
    setIsStoppingSimulation(false)
    setStopSimulationError(null)
    setStopSimulationResult(null)
    isLoadingDebugInfoRef.current = false
    setIsLoadingDebugInfo(false)
    setDebugInfoError(null)
    setDebugInfo(null)
    setIsDebugModalOpen(false)
    resultsAbortControllerRef.current?.abort()
    resultsAbortControllerRef.current = null
    isLoadingResultsRef.current = false
    setIsLoadingResults(false)
    setResultsError(null)
    setResultsInfo(null)
  }, [simulation.id])

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
    setStopSimulationResult(null)

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

      const data = (await response.json()) as CreateOpeningHandLlmRunResponse
      setOpeningHandRun(data)
    } catch {
      setOpeningHandRunError(
        "Opening hand run could not be sent to the server."
      )
    } finally {
      setIsStartingOpeningHandRun(false)
    }
  }

  async function handleStartTurnRun() {
    if (isStartingTurnRun || isStartingOpeningHandRun || isStoppingSimulation) {
      return
    }

    const turnNumber = Number(selectedTurnNumber)

    if (!Number.isInteger(turnNumber) || turnNumber < 1) {
      setTurnRunError("Turn number must be a positive integer.")
      return
    }

    setIsStartingTurnRun(true)
    setTurnRunError(null)
    setTurnRun(null)
    setStopSimulationResult(null)

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

      const data = (await response.json()) as CreateTurnLlmRunResponse
      setTurnRun(data)
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
      setStopSimulationResult(data)
      setOpeningHandRun(null)
      setTurnRun(null)
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

  const handleReloadResults = useCallback(async () => {
    if (isLoadingResultsRef.current) {
      return
    }

    const abortController = new AbortController()
    resultsAbortControllerRef.current = abortController
    isLoadingResultsRef.current = true
    setIsLoadingResults(true)
    setResultsError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/results`,
        {
          signal: abortController.signal,
        }
      )

      if (!response.ok) {
        setResultsError(
          await readApiError(
            response,
            "Simulation results could not be loaded."
          )
        )
        return
      }

      const data = (await response.json()) as SimulationResultsResponse
      setResultsInfo(data.results)
    } catch {
      if (abortController.signal.aborted) {
        return
      }

      setResultsError("Simulation results could not be loaded.")
    } finally {
      if (resultsAbortControllerRef.current === abortController) {
        resultsAbortControllerRef.current = null
        isLoadingResultsRef.current = false
        setIsLoadingResults(false)
      }
    }
  }, [deckId, simulation.id])

  useEffect(() => {
    void handleReloadResults()

    const intervalId = window.setInterval(() => {
      void handleReloadResults()
    }, 1000)

    return () => {
      window.clearInterval(intervalId)
      resultsAbortControllerRef.current?.abort()
      resultsAbortControllerRef.current = null
      isLoadingResultsRef.current = false
    }
  }, [handleReloadResults])

  useEffect(() => {
    if (!isDebugModalOpen) {
      return
    }

    void handleRefreshDebugInfo()
  }, [handleRefreshDebugInfo, isDebugModalOpen])

  return (
    <div className="flex flex-1 flex-col px-5 py-6">
      <header className="grid gap-4 border-b border-border pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-sky-300">Simulation {simulation.id}</p>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h3 className="text-xl font-semibold">Simulation setup</h3>
              <Button
                type="button"
                variant="outline"
                onClick={() => setIsDebugModalOpen(true)}
              >
                <Bug data-icon="inline-start" />
                View debug info
              </Button>
            </div>
          </div>
          <span className="rounded-md border border-border bg-background/45 px-3 py-1 text-sm text-muted-foreground">
            {simulation.status}
          </span>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-md border border-border bg-background/35 p-3">
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
            <dt className="text-muted-foreground">Simulate opening hand</dt>
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
      </header>

      <section className="grid gap-3 border-b border-border py-5">
        <div className="grid gap-3 rounded-md border border-border bg-background/35 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-base font-semibold text-foreground">
                LLM simulations
              </h4>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={
                isStoppingSimulation ||
                isStartingOpeningHandRun ||
                isStartingTurnRun
              }
              onClick={() => void handleStopSimulation()}
            >
              <X data-icon="inline-start" />
              {isStoppingSimulation ? "Stopping..." : "Stop simulation"}
            </Button>
          </div>

          {shouldSimulateOpeningHand ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Opening hand simulation
                </p>
                {openingHandRun ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    Run {openingHandRun.llmRunId.slice(0, 8)} started.
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                disabled={
                  isStartingOpeningHandRun ||
                  isStartingTurnRun ||
                  isStoppingSimulation
                }
                onClick={() => void handleStartOpeningHandRun()}
              >
                <Sparkles data-icon="inline-start" />
                {isStartingOpeningHandRun
                  ? "Starting..."
                  : "Start opening hand run"}
              </Button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
            <div className="grid gap-2">
              <label
                className="text-sm font-medium text-foreground"
                htmlFor="turn-run-number"
              >
                Turn simulation
              </label>
              <select
                id="turn-run-number"
                className="h-9 w-28 rounded-md border border-input bg-background px-3 text-sm text-foreground transition-colors outline-none focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                value={selectedTurnNumber}
                disabled={
                  isStartingTurnRun ||
                  isStartingOpeningHandRun ||
                  isStoppingSimulation
                }
                onChange={(event) => {
                  setSelectedTurnNumber(event.target.value)
                  setTurnRunError(null)
                }}
              >
                {Array.from({ length: 10 }, (_, turnIndex) => {
                  const turnNumber = turnIndex + 1

                  return (
                    <option key={turnNumber} value={turnNumber}>
                      Turn {turnNumber}
                    </option>
                  )
                })}
              </select>
            </div>

            <Button
              type="button"
              disabled={
                isStartingTurnRun ||
                isStartingOpeningHandRun ||
                isStoppingSimulation
              }
              onClick={() => void handleStartTurnRun()}
            >
              <Dices data-icon="inline-start" />
              {isStartingTurnRun ? "Starting..." : "Start turn run"}
            </Button>
          </div>

          {turnRun ? (
            <p className="text-sm text-muted-foreground">
              Turn {turnRun.turnNumber} run {turnRun.llmRunId.slice(0, 8)}{" "}
              started.
            </p>
          ) : null}

          {turnRunError ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {turnRunError}
            </p>
          ) : null}

          {openingHandRunError ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {openingHandRunError}
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

          {stopSimulationResult ? (
            <p className="text-sm text-muted-foreground">
              Stop requested for{" "}
              {stopSimulationResult.stoppedLlmRunIds.length +
                stopSimulationResult.cancelRequestedLlmRunIds.length}{" "}
              LLM run(s).
            </p>
          ) : null}
        </div>
      </section>

      <section className="grid gap-4 pt-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h4 className="text-base font-semibold text-foreground">
              Simulation results
            </h4>
            <p className="mt-1 text-sm text-muted-foreground">
              User-facing output rebuilt from persisted LLM chunks.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            disabled={isLoadingResults}
            onClick={() => void handleReloadResults()}
          >
            <RefreshCw data-icon="inline-start" />
            {isLoadingResults ? "Reloading..." : "Reload results"}
          </Button>
        </div>

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
          <SimulationResultsPanel resultsInfo={resultsInfo} />
        ) : !isLoadingResults && !resultsError ? (
          <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
            Reload results to view the saved simulation output.
          </p>
        ) : null}
      </section>

      {isDebugModalOpen ? (
        <SimulationDebugModal
          debugInfo={debugInfo}
          error={debugInfoError}
          isLoading={isLoadingDebugInfo}
          onClose={() => setIsDebugModalOpen(false)}
          onRefresh={() => void handleRefreshDebugInfo()}
          simulationId={simulation.id}
        />
      ) : null}
    </div>
  )
}

function SimulationDebugModal({
  debugInfo,
  error,
  isLoading,
  onClose,
  onRefresh,
  simulationId,
}: {
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
              <SimulationDebugPanel debugInfo={debugInfo} />
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
  resultsInfo,
}: {
  resultsInfo: SimulationResultsInfo
}) {
  const runs = [
    ...resultsInfo.openingHandLlmRuns.map((run) => ({
      ...run,
      resultLabel: `Opening hand attempt ${run.attemptNumber}`,
      resultChunks: getSimulationResultChunks(run.chunks),
    })),
    ...resultsInfo.turnLlmRuns.map((run) => ({
      ...run,
      resultLabel: `Turn ${run.turnNumber ?? "?"} attempt ${run.attemptNumber}`,
      resultChunks: getSimulationResultChunks(run.chunks),
    })),
  ]
  const runsWithResults = runs.filter(
    (run) => run.resultChunks.length > 0 || run.gameState
  )

  if (runsWithResults.length === 0) {
    return (
      <p className="rounded-md border border-border bg-background/35 px-3 py-2 text-sm text-muted-foreground">
        No user-facing result chunks have been saved for this simulation yet.
      </p>
    )
  }

  return (
    <div className="grid gap-3">
      {runsWithResults.map((run) => (
        <section
          key={run.llmRunId}
          className="grid gap-3 rounded-md border border-border bg-background/35 p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h5 className="text-sm font-medium text-foreground">
                {run.resultLabel}
              </h5>
              <p className="mt-1 text-xs text-muted-foreground">
                {run.status} / {run.model}
                {run.estimatedPriceCents
                  ? ` / ${run.estimatedPriceCents} cents`
                  : ""}
                {run.outdated ? " / outdated" : ""}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">
              {run.resultChunks.length} chunk
              {run.resultChunks.length === 1 ? "" : "s"}
            </p>
          </div>

          {run.gameState ? (
            <details className="rounded-md border border-emerald-500/30 bg-emerald-950/20">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-emerald-100 transition-colors hover:text-emerald-50">
                Game state
              </summary>
              <p className="border-t border-emerald-500/20 p-3 text-sm leading-6 whitespace-pre-wrap text-emerald-50/90">
                {run.gameState}
              </p>
            </details>
          ) : null}

          {run.resultChunks.length > 0 ? (
            <SimulationResultChunkCards chunks={run.resultChunks} />
          ) : null}
        </section>
      ))}
    </div>
  )
}

function SimulationResultChunkCards({
  chunks,
}: {
  chunks: SimulationDebugLlmRunChunk[]
}) {
  const blocks = formatDebugChunkBlocks(chunks)

  return (
    <div className="grid gap-2">
      {blocks.map((block) => {
        if (block.type === "reasoning") {
          return (
            <details
              key={block.id}
              className="rounded-md border border-border bg-black/20"
            >
              <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
                Reasoning summary
              </summary>
              <p className="border-t border-border p-3 text-sm leading-6 whitespace-pre-wrap text-muted-foreground">
                {block.text}
              </p>
            </details>
          )
        }

        if (block.type === "output") {
          return (
            <div
              key={block.id}
              className="rounded-md border border-sky-500/30 bg-sky-950/20 p-3"
            >
              <p className="text-sm leading-6 whitespace-pre-wrap text-sky-50/90">
                {block.text}
              </p>
            </div>
          )
        }

        if (block.type === "event") {
          return <SimulationResultEvent key={block.id} chunk={block.chunk} />
        }

        return null
      })}
    </div>
  )
}

function getSimulationResultChunks(
  chunks: readonly SimulationDebugLlmRunChunk[]
) {
  const visibleChunks = chunks.filter(
    (chunk, index) => !isRedundantMcpCallFailedEvent(chunk, chunks[index + 1])
  )

  return visibleChunks.filter((chunk, index) => {
    const nextChunk = visibleChunks[index + 1]

    return !(
      chunk.kind === "mcp_call_start" &&
      nextChunk?.kind === "mcp_call_complete" &&
      chunk.mcpFunctionName !== null &&
      chunk.mcpFunctionName === nextChunk.mcpFunctionName
    )
  })
}

function isRedundantMcpCallFailedEvent(
  chunk: SimulationDebugLlmRunChunk,
  nextChunk: SimulationDebugLlmRunChunk | undefined
) {
  return (
    chunk.kind === "error" &&
    chunk.providerEventType === "response.mcp_call.failed" &&
    nextChunk?.kind === "mcp_call_complete" &&
    getPayloadString(chunk.payload, "item_id") !== null &&
    getPayloadString(chunk.payload, "item_id") === getMcpCallItemId(nextChunk)
  )
}

function SimulationResultEvent({
  chunk,
}: {
  chunk: SimulationDebugLlmRunChunk
}) {
  if (chunk.kind === "mcp_call_start") {
    return (
      <div className="rounded-md border border-amber-500/25 bg-amber-950/15 px-3 py-2 text-sm text-amber-100/85">
        Tool started: {chunk.mcpFunctionName ?? "unknown tool"}
      </div>
    )
  }

  if (chunk.kind === "mcp_call_complete") {
    const isToolFailure = isMcpCallFailure(chunk)

    return (
      <details
        className={
          isToolFailure
            ? "rounded-md border border-destructive/35 bg-destructive/10"
            : "rounded-md border border-emerald-500/25 bg-emerald-950/15"
        }
      >
        <summary
          className={
            isToolFailure
              ? "cursor-pointer px-3 py-2 text-sm text-destructive transition-colors hover:text-destructive/90"
              : "cursor-pointer px-3 py-2 text-sm text-emerald-100/85 transition-colors hover:text-emerald-50"
          }
        >
          {getMcpCallCompleteTitle(chunk)}
        </summary>
        <pre
          className={
            isToolFailure
              ? "debug-scrollbar-neutral max-h-64 max-w-full overflow-y-auto border-t border-destructive/20 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-destructive"
              : "debug-scrollbar-neutral max-h-64 max-w-full overflow-y-auto border-t border-emerald-500/20 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-emerald-50/80"
          }
        >
          {formatResultEventPayload(getMcpCallResultPayload(chunk))}
        </pre>
      </details>
    )
  }

  if (chunk.kind === "error") {
    return (
      <details className="rounded-md border border-destructive/35 bg-destructive/10">
        <summary className="cursor-pointer px-3 py-2 text-sm text-destructive transition-colors hover:text-destructive/90">
          Simulation event failed
        </summary>
        <pre className="debug-scrollbar-neutral max-h-64 max-w-full overflow-y-auto border-t border-destructive/20 p-3 text-xs leading-5 break-words whitespace-pre-wrap text-destructive">
          {formatResultEventPayload(chunk.payload)}
        </pre>
      </details>
    )
  }

  if (chunk.kind === "cancelled") {
    return (
      <div className="rounded-md border border-slate-500/25 bg-slate-900/25 px-3 py-2 text-sm text-slate-200/85">
        Simulation cancelled: {getPayloadMessage(chunk.payload)}
      </div>
    )
  }

  return (
    <details className="rounded-md border border-border bg-black/20">
      <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
        {getDebugChunkEventLabel(chunk)}
      </summary>
      <pre className="debug-scrollbar-neutral max-h-64 max-w-full overflow-y-auto border-t border-border p-3 text-xs leading-5 break-words whitespace-pre-wrap text-muted-foreground">
        {JSON.stringify(chunk, null, 2)}
      </pre>
    </details>
  )
}

function formatResultEventPayload(payload: unknown) {
  if (typeof payload === "string") {
    return payload
  }

  return JSON.stringify(payload, null, 2)
}

function getMcpCallCompleteTitle(chunk: SimulationDebugLlmRunChunk) {
  const toolName = chunk.mcpFunctionName ?? "unknown tool"

  if (isMcpCallFailure(chunk)) {
    return `Tool failed: ${toolName}`
  }

  if (chunk.mcpFunctionName === "log_turn_action") {
    const lastLoggedAction = getLastLoggedTurnAction(chunk.mcpFunctionOutput)

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

function getMcpCallItemId(chunk: SimulationDebugLlmRunChunk) {
  return getPayloadString(asPayloadRecord(chunk.payload).item, "id")
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

function getLastLoggedTurnAction(payload: unknown) {
  const resolvedPayload = parseJsonObjectPayload(payload)
  const loggedActions = resolvedPayload?.data?.loggedActions

  if (!Array.isArray(loggedActions)) {
    return null
  }

  const lastLoggedAction = loggedActions.at(-1)

  return typeof lastLoggedAction === "string" && lastLoggedAction.trim()
    ? lastLoggedAction
    : null
}

function parseJsonObjectPayload(payload: unknown) {
  if (typeof payload === "object" && payload !== null) {
    return payload as {
      data?: {
        loggedActions?: unknown
      }
    }
  }

  if (typeof payload !== "string") {
    return null
  }

  try {
    const parsedPayload = JSON.parse(payload) as unknown

    return typeof parsedPayload === "object" && parsedPayload !== null
      ? (parsedPayload as {
          data?: {
            loggedActions?: unknown
          }
        })
      : null
  } catch {
    return null
  }
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
  debugInfo,
}: {
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
        heading="Opening hand runs"
        runs={debugInfo.openingHandLlmRuns}
      />
      <SimulationDebugRunGroup
        heading="Turn runs"
        runs={debugInfo.turnLlmRuns}
      />
    </div>
  )
}

function SimulationDebugRunGroup({
  heading,
  runs,
}: {
  heading: string
  runs: SimulationDebugInfo["openingHandLlmRuns"]
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
                <span className="text-foreground">{run.reasoningEffort}</span>
              </p>
              <p className="break-all text-muted-foreground">
                Runtime key:{" "}
                <span className="text-foreground">
                  {run.runtimeStreamKey ?? "none"}
                </span>
              </p>
            </div>

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

type FormattedDebugChunkBlock =
  | {
      id: string
      type: "reasoning" | "output"
      text: string
      chunks: SimulationDebugLlmRunChunk[]
    }
  | {
      id: string
      type: "event"
      chunk: SimulationDebugLlmRunChunk
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
            className="rounded-md border border-border bg-black/20 p-3"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
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
          </section>
        )
      )}
    </div>
  )
}

function formatDebugChunkBlocks(
  chunks: readonly SimulationDebugLlmRunChunk[]
): FormattedDebugChunkBlock[] {
  const blocks: FormattedDebugChunkBlock[] = []

  for (const chunk of chunks) {
    const deltaType = getDebugChunkDeltaType(chunk)

    if (!deltaType) {
      blocks.push({
        id: `event-${chunk.id}`,
        type: "event",
        chunk,
      })
      continue
    }

    const deltaText = getDebugChunkDeltaText(chunk, deltaType)
    const previousBlock = blocks[blocks.length - 1]

    if (previousBlock?.type === deltaType) {
      previousBlock.text += deltaText
      previousBlock.chunks.push(chunk)
      continue
    }

    blocks.push({
      id: `${deltaType}-${chunk.id}`,
      type: deltaType,
      text: deltaText,
      chunks: [chunk],
    })
  }

  return blocks
}

function getDebugChunkDeltaType(chunk: SimulationDebugLlmRunChunk) {
  if (chunk.kind === "reasoning_delta") {
    return "reasoning" as const
  }

  if (chunk.kind === "message_delta") {
    return "output" as const
  }

  return null
}

function getDebugChunkDeltaText(
  chunk: SimulationDebugLlmRunChunk,
  deltaType: "reasoning" | "output"
) {
  if (deltaType === "reasoning") {
    return chunk.reasoningDelta ?? ""
  }

  return chunk.outputDelta ?? ""
}

function getDebugChunkEventLabel(chunk: SimulationDebugLlmRunChunk) {
  if (chunk.mcpFunctionName) {
    return `${chunk.providerEventType ?? chunk.kind}: ${chunk.mcpFunctionName}`
  }

  return chunk.providerEventType ?? chunk.kind
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

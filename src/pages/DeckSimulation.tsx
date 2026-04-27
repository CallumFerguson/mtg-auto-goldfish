import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
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
import type {
  CreateOpeningHandLlmRunResponse,
  CreateSimulationResponse,
  CreateStartingHandResponse,
  DeckCard,
  Simulation,
  SimulationDebugInfo,
  SimulationDebugLlmRunChunk,
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
      simulations.find((simulation) => simulation.id === selectedSimulationId) ??
      null,
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
        throw new Error(`Simulation request failed with ${response.status}`)
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
        throw new Error(`Starting hand request failed with ${response.status}`)
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
        setCreateSimulationError(await readSimulationError(response))
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
        throw new Error(`Simulation delete failed with ${response.status}`)
      }

      setSimulations((currentSimulations) =>
        currentSimulations.filter((simulation) => simulation.id !== simulationId)
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
      <div className="grid min-h-[34rem] overflow-hidden rounded-lg border border-border bg-card/70 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <aside className="border-b border-border bg-background/35 lg:border-r lg:border-b-0">
          <nav className="grid gap-1 p-2" aria-label="Simulations">
            <button
              className={`flex w-full items-center gap-2 rounded-md px-3 py-3 text-left text-sm font-medium transition-colors ${
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
              <Plus data-icon="inline-start" />
              New simulation
            </button>

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
                      className={`w-full rounded-md py-3 pr-11 pl-3 text-left text-sm font-medium transition-colors ${
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
                        navigateTo(getDeckSimulationPath(deckId, simulation.id))
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
          </nav>
        </aside>

        <section className="flex min-h-[28rem] flex-col">
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
                      {isCreatingSimulation ? "Creating..." : "Start simulation"}
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
  const [isStoppingSimulation, setIsStoppingSimulation] = useState(false)
  const [stopSimulationError, setStopSimulationError] = useState<string | null>(
    null
  )
  const [stopSimulationResult, setStopSimulationResult] =
    useState<StopSimulationResponse | null>(null)
  const [isLoadingDebugInfo, setIsLoadingDebugInfo] = useState(false)
  const [debugInfoError, setDebugInfoError] = useState<string | null>(null)
  const [debugInfo, setDebugInfo] = useState<SimulationDebugInfo | null>(null)
  const shouldSimulateOpeningHand = simulation.startingHandId === null

  useEffect(() => {
    setIsStartingOpeningHandRun(false)
    setOpeningHandRunError(null)
    setOpeningHandRun(null)
    setIsStoppingSimulation(false)
    setStopSimulationError(null)
    setStopSimulationResult(null)
    setIsLoadingDebugInfo(false)
    setDebugInfoError(null)
    setDebugInfo(null)
  }, [simulation.id])

  async function handleStartOpeningHandRun() {
    if (!shouldSimulateOpeningHand || isStartingOpeningHandRun) {
      return
    }

    setIsStartingOpeningHandRun(true)
    setOpeningHandRunError(null)
    setStopSimulationResult(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/opening-hand-llm-runs`,
        {
          method: "POST",
        }
      )

      if (!response.ok) {
        setOpeningHandRunError(await readOpeningHandRunError(response))
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

  async function handleStopSimulation() {
    if (isStoppingSimulation) {
      return
    }

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
        setStopSimulationError(await readStopSimulationError(response))
        return
      }

      const data = (await response.json()) as StopSimulationResponse
      setStopSimulationResult(data)
      setOpeningHandRun(null)
    } catch {
      setStopSimulationError("Simulation stop could not be sent to the server.")
    } finally {
      setIsStoppingSimulation(false)
    }
  }

  async function handleRefreshDebugInfo() {
    if (isLoadingDebugInfo) {
      return
    }

    setIsLoadingDebugInfo(true)
    setDebugInfoError(null)

    try {
      const response = await fetch(
        `${API_BASE_URL}/decks/${deckId}/simulations/${simulation.id}/debug`
      )

      if (!response.ok) {
        setDebugInfoError(await readSimulationDebugError(response))
        return
      }

      const data = (await response.json()) as SimulationDebugResponse
      setDebugInfo(data.debug)
    } catch {
      setDebugInfoError("Simulation debug info could not be loaded.")
    } finally {
      setIsLoadingDebugInfo(false)
    }
  }

  return (
    <div className="flex flex-1 flex-col px-5 py-6">
      <header className="grid gap-4 border-b border-border pb-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm text-sky-300">
              Simulation {simulation.id}
            </p>
            <h3 className="text-xl font-semibold">Simulation setup</h3>
          </div>
          <span className="rounded-md border border-border bg-background/45 px-3 py-1 text-sm text-muted-foreground">
            {simulation.status}
          </span>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="rounded-md border border-border bg-background/35 p-3">
            <dt className="text-muted-foreground">Seed</dt>
            <dd className="mt-1 break-all font-medium text-foreground">
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
        ) : (
          <div className="grid gap-3 rounded-md border border-border bg-background/35 p-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
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
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  disabled={
                    isStartingOpeningHandRun ||
                    isStoppingSimulation ||
                    Boolean(openingHandRun)
                  }
                  onClick={() => void handleStartOpeningHandRun()}
                >
                  <Sparkles data-icon="inline-start" />
                  {openingHandRun
                    ? "Run started"
                    : isStartingOpeningHandRun
                      ? "Starting..."
                      : "Start opening hand run"}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isStoppingSimulation || isStartingOpeningHandRun}
                  onClick={() => void handleStopSimulation()}
                >
                  <X data-icon="inline-start" />
                  {isStoppingSimulation ? "Stopping..." : "Stop simulation"}
                </Button>
              </div>
            </div>

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
                {stopSimulationResult.stoppedOpeningHandLlmRunIds.length +
                  stopSimulationResult.cancelRequestedOpeningHandLlmRunIds
                    .length}{" "}
                opening hand run(s).
              </p>
            ) : null}
          </div>
        )}
      </header>

      <div className="grid flex-1 place-items-center py-10 text-center">
        <div className="grid w-full max-w-4xl gap-4 text-left">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h4 className="text-sm font-medium text-foreground">
                Simulation debug
              </h4>
              <p className="mt-1 text-sm text-muted-foreground">
                Refresh to load run counts and saved LLM chunks.
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={isLoadingDebugInfo}
              onClick={() => void handleRefreshDebugInfo()}
            >
              <RefreshCw data-icon="inline-start" />
              {isLoadingDebugInfo ? "Refreshing..." : "Refresh debug"}
            </Button>
          </div>

          {debugInfoError ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {debugInfoError}
            </p>
          ) : null}

          {debugInfo ? <SimulationDebugPanel debugInfo={debugInfo} /> : null}
        </div>
      </div>
    </div>
  )
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
              {run.turnNumber ? (
                <p className="text-muted-foreground">
                  Turn:{" "}
                  <span className="text-foreground">{run.turnNumber}</span>
                </p>
              ) : null}
              <p className="text-muted-foreground">
                Model: <span className="text-foreground">{run.model}</span>
              </p>
              <p className="break-all text-muted-foreground">
                Runtime key:{" "}
                <span className="text-foreground">
                  {run.runtimeStreamKey ?? "none"}
                </span>
              </p>
            </div>

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
                    <pre className="debug-scrollbar max-h-96 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words p-3 text-xs leading-5 text-sky-50/80">
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
            <pre className="debug-scrollbar-neutral max-h-80 min-w-0 max-w-full overflow-y-auto whitespace-pre-wrap break-words border-t border-border p-3 text-xs leading-5 text-muted-foreground">
              {JSON.stringify(block.chunk, null, 2)}
            </pre>
          </details>
        ) : (
          <section
            key={block.id}
            className="rounded-md border border-border bg-black/20 p-3"
          >
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-medium uppercase tracking-wide text-sky-300">
                {block.type === "reasoning" ? "Reasoning" : "Output"}
              </p>
              <p className="text-xs text-muted-foreground">
                {block.chunks.length} chunk
                {block.chunks.length === 1 ? "" : "s"}
              </p>
            </div>
            <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
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
    return chunk.reasoningDelta ?? chunk.content ?? ""
  }

  return chunk.outputDelta ?? chunk.content ?? ""
}

function getDebugChunkEventLabel(chunk: SimulationDebugLlmRunChunk) {
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
        setError(await readStartingHandError(response))
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

async function readStartingHandError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Starting hand could not be saved. Server responded with ${response.status}.`
}

async function readSimulationError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Simulation could not be saved. Server responded with ${response.status}.`
}

async function readOpeningHandRunError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Opening hand run could not be started. Server responded with ${response.status}.`
}

async function readStopSimulationError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Simulation could not be stopped. Server responded with ${response.status}.`
}

async function readSimulationDebugError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Simulation debug info could not be loaded. Server responded with ${response.status}.`
}

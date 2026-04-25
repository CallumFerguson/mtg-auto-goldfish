import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react"
import { Dices, Plus, RefreshCw, Save, Sparkles, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import type {
  CreateStartingHandResponse,
  DeckCard,
  Simulation,
  SimulationsResponse,
  StartingHand,
  StartingHandsResponse,
} from "@/lib/deck-types"

type OpeningHandCardOption = {
  id: string
  deckCardId: number
  name: string
}

function getSimulationLabel(simulation: Simulation) {
  return simulation.id.slice(0, 8)
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
}: {
  cards: DeckCard[]
  deckId: string
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
  const [simulationSeed, setSimulationSeed] = useState("")
  const [useRandomSeed, setUseRandomSeed] = useState(true)
  const [turnsToSimulate, setTurnsToSimulate] = useState("5")
  const [openingHandMode, setOpeningHandMode] = useState<
    "simulate" | "provide"
  >("simulate")
  const [selectedOpeningHandId, setSelectedOpeningHandId] = useState("")
  const [isCreateHandModalOpen, setIsCreateHandModalOpen] = useState(false)
  const openingHandCardOptions = useMemo(
    () => getOpeningHandCardOptions(cards),
    [cards]
  )
  const selectedOpeningHand = useMemo(
    () =>
      startingHands.find((hand) => hand.id === selectedOpeningHandId) ?? null,
    [startingHands, selectedOpeningHandId]
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
    } catch {
      setSimulationLoadError("Simulations could not be loaded.")
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
              onClick={() => setIsNewSimulationSelected(true)}
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
                  <li
                    key={simulation.id}
                    className="rounded-md px-3 py-3 text-sm text-foreground"
                  >
                    {getSimulationLabel(simulation)}
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
                      disabled={!canStartSimulation}
                    >
                      <Dices data-icon="inline-start" />
                      Start simulation
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="grid flex-1 place-items-center px-5 py-10 text-center">
              <div className="max-w-md space-y-3">
                <Sparkles className="mx-auto size-8 text-sky-300" />
                <h3 className="text-lg font-semibold">Simulation workspace</h3>
                <p className="text-sm leading-6 text-muted-foreground">
                  Select a simulation to view its run details here.
                </p>
              </div>
            </div>
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

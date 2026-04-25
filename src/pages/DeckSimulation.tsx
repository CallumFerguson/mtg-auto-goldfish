import { useCallback, useEffect, useMemo, useState } from "react"
import { Dices, Plus, RefreshCw, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import type {
  DeckCard,
  Simulation,
  SimulationsResponse,
} from "@/lib/deck-types"

type OpeningHandCardOption = {
  id: string
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
        id: `${card.oracleId}-${copyIndex}`,
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
  deckName,
}: {
  cards: DeckCard[]
  deckId: string
  deckName: string
}) {
  const [simulations, setSimulations] = useState<Simulation[]>([])
  const [isLoadingSimulations, setIsLoadingSimulations] = useState(true)
  const [simulationLoadError, setSimulationLoadError] = useState<string | null>(
    null
  )
  const [isNewSimulationSelected, setIsNewSimulationSelected] = useState(true)
  const [simulationSeed, setSimulationSeed] = useState("")
  const [useRandomSeed, setUseRandomSeed] = useState(true)
  const [turnsToSimulate, setTurnsToSimulate] = useState(10)
  const [openingHandMode, setOpeningHandMode] = useState<
    "simulate" | "provide"
  >("simulate")
  const [selectedOpeningHandCardIds, setSelectedOpeningHandCardIds] = useState<
    string[]
  >([])
  const openingHandCardOptions = useMemo(
    () => getOpeningHandCardOptions(cards),
    [cards]
  )
  const selectedOpeningHandCardIdSet = useMemo(
    () => new Set(selectedOpeningHandCardIds),
    [selectedOpeningHandCardIds]
  )
  const hasExactlySevenOpeningHandCards =
    selectedOpeningHandCardIds.length === 7

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

  useEffect(() => {
    void loadSimulations()
  }, [loadSimulations])

  function toggleOpeningHandCard(cardId: string) {
    setSelectedOpeningHandCardIds((currentCardIds) => {
      if (currentCardIds.includes(cardId)) {
        return currentCardIds.filter((currentCardId) => currentCardId !== cardId)
      }

      if (currentCardIds.length >= 7) {
        return currentCardIds
      }

      return [...currentCardIds, cardId]
    })
  }

  return (
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
              <p className="text-sm text-destructive">{simulationLoadError}</p>
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
        <header className="border-b border-border px-5 py-4">
          <p className="text-sm font-medium tracking-[0.16em] text-sky-300 uppercase">
            Simulation
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{deckName}</h2>
        </header>

        {isNewSimulationSelected ? (
          <div className="flex flex-1 flex-col gap-6 px-5 py-6">
            <div className="space-y-1">
              <h3 className="text-lg font-semibold">Create simulation</h3>
              <p className="text-sm leading-6 text-muted-foreground">
                Configure the starting conditions for the next run.
              </p>
            </div>

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
                    className="h-9 rounded-md border border-input bg-background/60 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50"
                    type="text"
                    value={simulationSeed}
                    placeholder="Seed"
                    disabled={useRandomSeed}
                    onChange={(event) => setSimulationSeed(event.target.value)}
                  />
                  <label className="flex items-center gap-2 text-sm text-muted-foreground">
                    <input
                      className="size-4 accent-sky-300"
                      type="checkbox"
                      checked={useRandomSeed}
                      onChange={(event) =>
                        setUseRandomSeed(event.target.checked)
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
                <input
                  id="turns-to-simulate"
                  className="no-number-spinner h-9 w-full rounded-md border border-input bg-background/60 px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/30 sm:max-w-36"
                  type="number"
                  min={0}
                  step={1}
                  value={turnsToSimulate}
                  onChange={(event) =>
                    setTurnsToSimulate(event.target.valueAsNumber || 0)
                  }
                />
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
                  <div className="grid gap-3">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <p
                        className={
                          hasExactlySevenOpeningHandCards
                            ? "text-sky-300"
                            : "text-muted-foreground"
                        }
                      >
                        {selectedOpeningHandCardIds.length} of 7 selected
                      </p>
                      {!hasExactlySevenOpeningHandCards ? (
                        <p className="text-muted-foreground">
                          Select exactly 7 cards.
                        </p>
                      ) : null}
                    </div>

                    <div className="max-h-72 overflow-y-auto rounded-md border border-border bg-background/35 p-2">
                      <ul className="grid gap-1">
                        {openingHandCardOptions.map((card) => {
                          const isSelected =
                            selectedOpeningHandCardIdSet.has(card.id)
                          const isDisabled =
                            !isSelected && selectedOpeningHandCardIds.length >= 7

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
                                  onChange={() => toggleOpeningHandCard(card.id)}
                                />
                                <span>{card.name}</span>
                              </label>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  </div>
                ) : null}
              </fieldset>
            </div>

            <div>
              <Button
                type="button"
                disabled={
                  openingHandMode === "provide" &&
                  !hasExactlySevenOpeningHandCards
                }
              >
                <Dices data-icon="inline-start" />
                Start simulation
              </Button>
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
  )
}

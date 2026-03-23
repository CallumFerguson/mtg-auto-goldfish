import { useEffect, useMemo, useState } from "react"
import type { ComponentProps } from "react"

import { DeckIntakeForm } from "@/features/deck-intake/components/deck-intake-form"
import { GoldfishSimulationPanel } from "@/features/deck-intake/components/goldfish-simulation-panel"
import { HeroSection } from "@/features/deck-intake/components/hero-section"
import { ProcessedCardsPanel } from "@/features/deck-intake/components/processed-cards-panel"
import { ResetDeckModal } from "@/features/deck-intake/components/reset-deck-modal"
import {
  clearCardOverride,
  clearCardOverrides,
  getCardOverride,
  saveAcceptedFuzzyMatch,
  saveManualCardText,
} from "@/features/deck-intake/lib/card-overrides"
import { parseCommanderInput, parseDecklist } from "@/features/deck-intake/lib/deck-parser"
import {
  DEFAULT_DECK_INPUT,
  loadStoredDeckInput,
  saveStoredDeckInput,
} from "@/features/deck-intake/lib/deck-storage"
import {
  areCardsAvailableInCache,
  fetchCardsByName,
  toResolvedCard,
} from "@/features/deck-intake/lib/scryfall"
import type {
  FuzzyMatch,
  MissingCard,
  ResolvedCard,
} from "@/features/deck-intake/types"

const MIN_PROCESSING_DURATION_MS = 250
const GOLDFISH_SERVER_URL =
  import.meta.env.VITE_GOLDFISH_SERVER_URL ?? "http://127.0.0.1:3001"

type GameCardPayload = {
  name: string
  cardText: string
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function toGameplayCardText(card: ResolvedCard) {
  const sections = [
    card.manaCost ? `Mana Cost: ${card.manaCost}` : "",
    card.typeLine ? `Type: ${card.typeLine}` : "",
    card.oracleText ? `Text: ${card.oracleText}` : "",
    card.power && card.toughness
      ? `Power/Toughness: ${card.power}/${card.toughness}`
      : "",
    card.loyalty ? `Loyalty: ${card.loyalty}` : "",
  ].filter(Boolean)

  return sections.join("\n")
}

function expandResolvedCard(card: ResolvedCard) {
  return Array.from({ length: card.quantity }, () => ({
    name: card.name,
    cardText: toGameplayCardText(card),
  }))
}

export function App() {
  const [storedDeckInput] = useState(() => loadStoredDeckInput())
  const [commanderOneName, setCommanderOneName] = useState(
    storedDeckInput.commanderOneName
  )
  const [commanderTwoName, setCommanderTwoName] = useState(
    storedDeckInput.commanderTwoName
  )
  const [decklistText, setDecklistText] = useState(storedDeckInput.decklistText)
  const [resolvedCards, setResolvedCards] = useState<ResolvedCard[]>([])
  const [fuzzyMatches, setFuzzyMatches] = useState<FuzzyMatch[]>([])
  const [missingCards, setMissingCards] = useState<MissingCard[]>([])
  const [lookupError, setLookupError] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [isResetModalOpen, setIsResetModalOpen] = useState(false)
  const [isStartingSimulation, setIsStartingSimulation] = useState(false)
  const [simulationError, setSimulationError] = useState("")
  const [gameId, setGameId] = useState("")

  const parsedDeck = useMemo(() => parseDecklist(decklistText), [decklistText])
  const totalCards = parsedDeck.reduce(
    (runningTotal, entry) => runningTotal + entry.quantity,
    0
  )
  const commanderOneInput = useMemo(
    () => parseCommanderInput(commanderOneName),
    [commanderOneName]
  )
  const commanderTwoInput = useMemo(
    () => parseCommanderInput(commanderTwoName),
    [commanderTwoName]
  )
  const commanderOne = commanderOneInput.name
  const commanderTwo = commanderTwoInput.name
  const commanders = [commanderOne, commanderTwo].filter(Boolean)
  const commanderCount = commanders.length
  const expectedDecklistCount = 100 - commanderCount
  const deckCountDelta = totalCards - expectedDecklistCount
  const hasCommanderTwoWithoutCommanderOne = Boolean(
    commanderTwo && !commanderOne
  )
  const hasTooManyCommanderCopies =
    commanderOneInput.quantity > 1 || commanderTwoInput.quantity > 1
  const hasDuplicateCommanders =
    Boolean(commanderOne) &&
    Boolean(commanderTwo) &&
    commanderOne.toLowerCase() === commanderTwo.toLowerCase()
  const hasValidCommanderSetup =
    Boolean(commanderOne) &&
    !hasCommanderTwoWithoutCommanderOne &&
    !hasTooManyCommanderCopies &&
    !hasDuplicateCommanders
  const hasValidDeckCount =
    (commanderCount === 1 && totalCards === 99) ||
    (commanderCount === 2 && totalCards === 98)
  const validationMessage = hasCommanderTwoWithoutCommanderOne
    ? "Commander 2 is filled in, but Commander 1 is empty. Add the first commander before adding a second."
    : commanderOneInput.quantity > 1
      ? `Commander 1 has ${commanderOneInput.quantity} copies entered. A commander slot can only contain 1 card.`
      : commanderTwoInput.quantity > 1
        ? `Commander 2 has ${commanderTwoInput.quantity} copies entered. A commander slot can only contain 1 card.`
        : hasDuplicateCommanders
          ? "Commander 1 and Commander 2 are the same card. Use two different commanders or leave Commander 2 empty."
          : !commanderCount
            ? "Add at least one commander before processing the deck."
            : !hasValidDeckCount
              ? commanderCount === 1
                ? `Your main deck has ${totalCards} cards. With 1 commander, it must have exactly 99 cards.`
                : `Your main deck has ${totalCards} cards. With 2 commanders, it must have exactly 98 cards.`
              : ""
  const canProcess =
    hasValidCommanderSetup && hasValidDeckCount && !isProcessing

  const completedCards = useMemo(
    () => {
      const commanderLookup = new Set(
        commanders.map((name) => name.trim().toLowerCase())
      )
      const manualCards: ResolvedCard[] = missingCards
        .filter((card) => card.isAccepted && card.manualText.trim())
        .map((card) => ({
          requestedName: card.name,
          name: card.name,
          quantity: card.quantity,
          manaCost: "",
          typeLine: "",
          oracleText: card.manualText.trim(),
          source: "manual" as const,
          isCommander: commanderLookup.has(card.name.trim().toLowerCase()),
        }))

      return [...resolvedCards, ...manualCards]
    },
    [commanders, missingCards, resolvedCards]
  )
  const fuzzyMatchCount = fuzzyMatches.length
  const missingCardCount = missingCards.filter((card) => !card.isAccepted).length
  const isSampleDeckActive =
    commanderOneName === DEFAULT_DECK_INPUT.commanderOneName &&
    commanderTwoName === DEFAULT_DECK_INPUT.commanderTwoName &&
    decklistText === DEFAULT_DECK_INPUT.decklistText

  const commanderCards = useMemo(
    () => completedCards.filter((card) => card.isCommander),
    [completedCards]
  )
  const deckCards = useMemo(
    () => completedCards.filter((card) => !card.isCommander),
    [completedCards]
  )
  const completedCardQuantity = useMemo(
    () => completedCards.reduce((total, card) => total + card.quantity, 0),
    [completedCards]
  )
  const commanderQuantity = useMemo(
    () => commanderCards.reduce((total, card) => total + card.quantity, 0),
    [commanderCards]
  )
  const deckQuantity = useMemo(
    () => deckCards.reduce((total, card) => total + card.quantity, 0),
    [deckCards]
  )
  const isDeckReady =
    hasValidCommanderSetup &&
    hasValidDeckCount &&
    !isProcessing &&
    fuzzyMatchCount === 0 &&
    missingCardCount === 0 &&
    commanderQuantity === commanderCount &&
    deckQuantity === totalCards &&
    completedCardQuantity === commanderCount + totalCards

  const simulationPayload = useMemo(() => {
    if (!isDeckReady) {
      return null
    }

    return {
      commanders: commanderCards.flatMap(expandResolvedCard),
      deck: deckCards.flatMap(expandResolvedCard),
    }
  }, [commanderCards, deckCards, isDeckReady])

  const handleSubmit: NonNullable<ComponentProps<"form">["onSubmit"]> = async (
    event
  ) => {
    event.preventDefault()
    await processDeck()
  }

  async function processDeck(options?: { skipMinProcessingDuration?: boolean }) {
    const cleanedCommanders = [commanderOneInput, commanderTwoInput]
      .map((commander) => commander.name)
      .filter(Boolean)
    const entries = parseDecklist(decklistText)

    if (hasCommanderTwoWithoutCommanderOne) {
      setLookupError(
        "Commander 2 is filled in, but Commander 1 is empty. Add the first commander before adding a second."
      )
      return
    }

    if (commanderOneInput.quantity > 1) {
      setLookupError(
        `Commander 1 has ${commanderOneInput.quantity} copies entered. A commander slot can only contain 1 card.`
      )
      return
    }

    if (commanderTwoInput.quantity > 1) {
      setLookupError(
        `Commander 2 has ${commanderTwoInput.quantity} copies entered. A commander slot can only contain 1 card.`
      )
      return
    }

    if (hasDuplicateCommanders) {
      setLookupError(
        "Commander 1 and Commander 2 are the same card. Use two different commanders or leave Commander 2 empty."
      )
      return
    }

    if (!cleanedCommanders.length) {
      setLookupError("Add at least one commander before processing the deck.")
      return
    }

    if (!entries.length) {
      setLookupError("Paste your main deck cards before processing.")
      return
    }

    if (cleanedCommanders.length === 1 && totalCards !== 99) {
      setLookupError(
        `Your main deck has ${totalCards} cards. With 1 commander, it must have exactly 99 cards.`
      )
      return
    }

    if (cleanedCommanders.length === 2 && totalCards !== 98) {
      setLookupError(
        `Your main deck has ${totalCards} cards. With 2 commanders, it must have exactly 98 cards.`
      )
      return
    }

    setIsProcessing(true)
    setLookupError("")
    setResolvedCards([])
    setFuzzyMatches([])
    setMissingCards([])

    try {
      const commanderEntries = cleanedCommanders.map((name) => ({
        name,
        quantity: 1,
      }))
      const allEntries = [...commanderEntries, ...entries]
      const lookupPromise = fetchCardsByName(allEntries.map((entry) => entry.name))
      const [lookupResponse] = options?.skipMinProcessingDuration
        ? [await lookupPromise]
        : await Promise.all([lookupPromise, delay(MIN_PROCESSING_DURATION_MS)])
      const { results, fuzzyMatches, notFound } = lookupResponse
      const commanderLookup = new Set(
        cleanedCommanders.map((name) => name.trim().toLowerCase())
      )

      const nextResolvedCards: ResolvedCard[] = []
      const nextFuzzyMatches: FuzzyMatch[] = []
      const nextMissingCards: MissingCard[] = []

      for (const entry of allEntries) {
        const lookupKey = entry.name.toLowerCase()
        const savedOverride = getCardOverride(entry.name)

        if (savedOverride?.kind === "fuzzy") {
          nextResolvedCards.push(
            {
              ...toResolvedCard(entry, savedOverride.card, "fuzzy"),
              isCommander: commanderLookup.has(lookupKey),
            }
          )
          continue
        }

        if (savedOverride?.kind === "manual") {
          nextMissingCards.push({
            name: entry.name,
            quantity: entry.quantity,
            manualText: savedOverride.manualText,
            isAccepted: true,
          })
          continue
        }

        const card = results.get(lookupKey)

        if (card) {
          nextResolvedCards.push({
            ...toResolvedCard(entry, card),
            isCommander: commanderLookup.has(lookupKey),
          })
          continue
        }

        const fuzzyMatch = fuzzyMatches.get(lookupKey)

        if (fuzzyMatch) {
          nextFuzzyMatches.push({
            name: entry.name,
            quantity: entry.quantity,
            suggestedCard: fuzzyMatch,
          })
          continue
        }

        if (notFound.has(lookupKey) || !card) {
          nextMissingCards.push({
            name: entry.name,
            quantity: entry.quantity,
            manualText: "",
            isAccepted: false,
          })
        }
      }

      setResolvedCards(nextResolvedCards)
      setFuzzyMatches(nextFuzzyMatches)
      setMissingCards(nextMissingCards)
    } catch (error) {
      setLookupError(
        error instanceof Error
          ? error.message
          : "Something went wrong while processing the deck."
      )
    } finally {
      setIsProcessing(false)
    }
  }

  async function startSimulation() {
    if (!simulationPayload) {
      return
    }

    setIsStartingSimulation(true)
    setSimulationError("")

    try {
      const response = await fetch(`${GOLDFISH_SERVER_URL}/games`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(simulationPayload satisfies {
          commanders: GameCardPayload[]
          deck: GameCardPayload[]
        }),
      })

      const payload = (await response.json()) as
        | { gameId?: string; error?: string }
        | { details?: Array<{ message?: string }> }

      if (!response.ok) {
        const detailMessage =
          "details" in payload && Array.isArray(payload.details)
            ? payload.details.map((detail) => detail.message).filter(Boolean).join(" ")
            : ""
        throw new Error(
          detailMessage ||
            ("error" in payload && payload.error) ||
            "Failed to create a game."
        )
      }

      if (!("gameId" in payload) || !payload.gameId) {
        throw new Error("The server response did not include a game ID.")
      }

      setGameId(payload.gameId)
    } catch (error) {
      setSimulationError(
        error instanceof Error
          ? error.message
          : "Failed to create a game."
      )
    } finally {
      setIsStartingSimulation(false)
    }
  }

  useEffect(() => {
    saveStoredDeckInput({
      commanderOneName,
      commanderTwoName,
      decklistText,
    })
  }, [commanderOneName, commanderTwoName, decklistText])

  useEffect(() => {
    if (!canProcess) {
      return
    }

    const cleanedCommanders = [commanderOneInput, commanderTwoInput]
      .map((commander) => commander.name)
      .filter(Boolean)
    const entries = parseDecklist(decklistText)
    const allNames = cleanedCommanders.concat(entries.map((entry) => entry.name))

    if (!allNames.length || !areCardsAvailableInCache(allNames)) {
      return
    }

    void processDeck({ skipMinProcessingDuration: true })
  }, [])

  useEffect(() => {
    setGameId("")
    setSimulationError("")
  }, [commanderOneName, commanderTwoName, decklistText])

  function requestResetToSampleDeck() {
    if (isSampleDeckActive) {
      return
    }

    setIsResetModalOpen(true)
  }

  function resetToSampleDeck() {
    setCommanderOneName(DEFAULT_DECK_INPUT.commanderOneName)
    setCommanderTwoName(DEFAULT_DECK_INPUT.commanderTwoName)
    setDecklistText(DEFAULT_DECK_INPUT.decklistText)
    setResolvedCards([])
    setFuzzyMatches([])
    setMissingCards([])
    setLookupError("")
    setIsProcessing(false)
    setIsResetModalOpen(false)
    setGameId("")
    setSimulationError("")
  }

  function updateManualText(name: string, manualText: string) {
    setMissingCards((currentCards) =>
      currentCards.map((card) =>
        card.name === name ? { ...card, manualText } : card
      )
    )
  }

  function acceptManualCard(name: string) {
    setMissingCards((currentCards) =>
      currentCards.map((card) => {
        if (card.name !== name) {
          return card
        }

        const manualText = card.manualText.trim()

        if (!manualText) {
          return card
        }

        saveManualCardText(name, manualText)

        return {
          ...card,
          manualText,
          isAccepted: true,
        }
      })
    )
  }

  function acceptFuzzyMatch(match: FuzzyMatch) {
    saveAcceptedFuzzyMatch(match.name, match.suggestedCard)

    setResolvedCards((currentCards) => [
      ...currentCards,
      {
        ...toResolvedCard(
          { name: match.name, quantity: match.quantity },
          match.suggestedCard,
          "fuzzy"
        ),
        isCommander: commanders.some(
          (commander) =>
            commander.trim().toLowerCase() === match.name.trim().toLowerCase()
        ),
      },
    ])
    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
  }

  function rejectFuzzyMatch(match: FuzzyMatch) {
    clearCardOverride(match.name)

    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
    setMissingCards((currentCards) => [
      ...currentCards,
      {
        name: match.name,
        quantity: match.quantity,
        manualText: "",
        isAccepted: false,
        rejectedSuggestion: match.suggestedCard,
      },
    ])
  }

  function cancelAcceptedFuzzyMatch(card: ResolvedCard) {
    if (card.source !== "fuzzy" || !card.matchedCard) {
      return
    }

    const matchedCard = card.matchedCard

    clearCardOverride(card.requestedName)

    setResolvedCards((currentCards) =>
      currentCards.filter(
        (currentCard) =>
          !(
            currentCard.source === "fuzzy" &&
            currentCard.requestedName === card.requestedName
          )
      )
    )
    setFuzzyMatches((currentMatches) => [
      ...currentMatches.filter(
        (currentMatch) => currentMatch.name !== card.requestedName
      ),
      {
        name: card.requestedName,
        quantity: card.quantity,
        suggestedCard: matchedCard,
      },
    ])
  }

  function editManualCard(name: string) {
    clearCardOverride(name)

    setMissingCards((currentCards) =>
      currentCards.map((card) =>
        card.name === name ? { ...card, isAccepted: false } : card
      )
    )
  }

  function clearCurrentOverrides() {
    const currentOverrideNames = [
      ...resolvedCards
        .filter((card) => card.source === "fuzzy")
        .map((card) => card.requestedName),
      ...missingCards
        .filter((card) => card.isAccepted || card.rejectedSuggestion)
        .map((card) => card.name),
    ]

    clearCardOverrides(currentOverrideNames)

    setResolvedCards((currentCards) =>
      currentCards.filter((card) => card.source !== "fuzzy")
    )
    setFuzzyMatches((currentMatches) => [
      ...currentMatches,
      ...resolvedCards
        .filter((card) => card.source === "fuzzy" && card.matchedCard)
        .map((card) => ({
          name: card.requestedName,
          quantity: card.quantity,
          suggestedCard: card.matchedCard!,
        })),
      ...missingCards
        .filter((card) => card.rejectedSuggestion)
        .map((card) => ({
          name: card.name,
          quantity: card.quantity,
          suggestedCard: card.rejectedSuggestion!,
        })),
    ])
    setMissingCards((currentCards) =>
      currentCards.flatMap((card) => {
        if (card.rejectedSuggestion) {
          return []
        }

        if (card.isAccepted) {
          return [
            {
              ...card,
              isAccepted: false,
            },
          ]
        }

        return [card]
      })
    )
  }

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.2),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(120,53,15,0.3),transparent_30%),linear-gradient(180deg,#09090b_0%,#111217_50%,#18181b_100%)] text-stone-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <HeroSection
          totalCards={totalCards}
          expectedDecklistCount={expectedDecklistCount}
          commanderCount={commanderCount}
          deckCountDelta={deckCountDelta}
          fuzzyMatchCount={fuzzyMatches.length}
        />

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <DeckIntakeForm
            commanderOneName={commanderOneName}
            commanderTwoName={commanderTwoName}
            decklistText={decklistText}
            expectedDecklistCount={expectedDecklistCount}
            canProcess={canProcess}
            isProcessing={isProcessing}
            isResetDisabled={isSampleDeckActive}
            validationMessage={validationMessage}
            lookupError={lookupError}
            onCommanderOneChange={setCommanderOneName}
            onCommanderTwoChange={setCommanderTwoName}
            onDecklistChange={setDecklistText}
            onResetToSampleDeck={requestResetToSampleDeck}
            onSubmit={handleSubmit}
          />

          <section className="grid gap-6">
            <ProcessedCardsPanel
              commanderOneName={commanderOne}
              commanderTwoName={commanderTwo}
              completedCards={completedCards}
              fuzzyMatches={fuzzyMatches}
              missingCards={missingCards}
              fuzzyMatchCount={fuzzyMatchCount}
              missingCardCount={missingCardCount}
              isProcessing={isProcessing}
              onAcceptFuzzyMatch={acceptFuzzyMatch}
              onAcceptManualCard={acceptManualCard}
              onCancelFuzzyMatch={cancelAcceptedFuzzyMatch}
              onClearOverrides={clearCurrentOverrides}
              onEditManualCard={editManualCard}
              onRejectFuzzyMatch={rejectFuzzyMatch}
              onManualTextChange={updateManualText}
            />
          </section>
        </div>

        <GoldfishSimulationPanel
          canStart={isDeckReady}
          isStarting={isStartingSimulation}
          gameId={gameId}
          errorMessage={simulationError}
          onStart={startSimulation}
        />
      </div>

      <ResetDeckModal
        isOpen={isResetModalOpen}
        onCancel={() => setIsResetModalOpen(false)}
        onConfirm={resetToSampleDeck}
      />
    </main>
  )
}

export default App

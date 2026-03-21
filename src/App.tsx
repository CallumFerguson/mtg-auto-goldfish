import { useMemo, useState } from "react"
import type { ComponentProps } from "react"

import {
  DEFAULT_COMMANDER_ONE,
  DEFAULT_DECKLIST,
} from "@/features/deck-intake/constants"
import { DeckIntakeForm } from "@/features/deck-intake/components/deck-intake-form"
import { FuzzyMatchesPanel } from "@/features/deck-intake/components/fuzzy-matches-panel"
import { HeroSection } from "@/features/deck-intake/components/hero-section"
import { MissingCardsPanel } from "@/features/deck-intake/components/missing-cards-panel"
import { ProcessedCardsPanel } from "@/features/deck-intake/components/processed-cards-panel"
import { parseCommanderInput, parseDecklist } from "@/features/deck-intake/lib/deck-parser"
import {
  fetchCardsByName,
  toResolvedCard,
} from "@/features/deck-intake/lib/scryfall"
import type {
  FuzzyMatch,
  MissingCard,
  ResolvedCard,
} from "@/features/deck-intake/types"

export function App() {
  const [commanderOneName, setCommanderOneName] =
    useState(DEFAULT_COMMANDER_ONE)
  const [commanderTwoName, setCommanderTwoName] = useState("")
  const [decklistText, setDecklistText] = useState(DEFAULT_DECKLIST)
  const [resolvedCards, setResolvedCards] = useState<ResolvedCard[]>([])
  const [fuzzyMatches, setFuzzyMatches] = useState<FuzzyMatch[]>([])
  const [missingCards, setMissingCards] = useState<MissingCard[]>([])
  const [lookupError, setLookupError] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)

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
    () =>
      resolvedCards.concat(
        missingCards
          .filter((card) => card.manualText.trim())
          .map((card) => ({
            name: card.name,
            quantity: card.quantity,
            manaCost: "",
            typeLine: "Manual entry",
            oracleText: card.manualText.trim(),
            source: "manual" as const,
          }))
      ),
    [missingCards, resolvedCards]
  )
  const fuzzyMatchCount = fuzzyMatches.length
  const missingCardCount = missingCards.filter(
    (card) => !card.manualText.trim()
  ).length

  const handleSubmit: NonNullable<ComponentProps<"form">["onSubmit"]> = async (
    event
  ) => {
    event.preventDefault()

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
      const { results, fuzzyMatches, notFound } = await fetchCardsByName(
        allEntries.map((entry) => entry.name)
      )

      const nextResolvedCards: ResolvedCard[] = []
      const nextFuzzyMatches: FuzzyMatch[] = []
      const nextMissingCards: MissingCard[] = []

      for (const entry of allEntries) {
        const lookupKey = entry.name.toLowerCase()
        const card = results.get(lookupKey)

        if (card) {
          nextResolvedCards.push(toResolvedCard(entry, card))
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

  function updateManualText(name: string, manualText: string) {
    setMissingCards((currentCards) =>
      currentCards.map((card) =>
        card.name === name ? { ...card, manualText } : card
      )
    )
  }

  function acceptFuzzyMatch(match: FuzzyMatch) {
    setResolvedCards((currentCards) => [
      ...currentCards,
      toResolvedCard(
        { name: match.name, quantity: match.quantity },
        match.suggestedCard,
        "fuzzy"
      ),
    ])
    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
  }

  function rejectFuzzyMatch(match: FuzzyMatch) {
    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
    setMissingCards((currentCards) => [
      ...currentCards,
      {
        name: match.name,
        quantity: match.quantity,
        manualText: "",
      },
    ])
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
            validationMessage={validationMessage}
            lookupError={lookupError}
            onCommanderOneChange={setCommanderOneName}
            onCommanderTwoChange={setCommanderTwoName}
            onDecklistChange={setDecklistText}
            onSubmit={handleSubmit}
          />

          <section className="grid gap-6">
            <ProcessedCardsPanel
              completedCards={completedCards}
              fuzzyMatchCount={fuzzyMatchCount}
              missingCardCount={missingCardCount}
            />
            <FuzzyMatchesPanel
              fuzzyMatches={fuzzyMatches}
              onAcceptMatch={acceptFuzzyMatch}
              onRejectMatch={rejectFuzzyMatch}
            />
            <MissingCardsPanel
              missingCards={missingCards}
              onManualTextChange={updateManualText}
            />
          </section>
        </div>
      </div>
    </main>
  )
}

export default App

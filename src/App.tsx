import { useEffect, useMemo, useRef, useState } from "react"
import type { ComponentProps, Dispatch, SetStateAction } from "react"

import { DeckIntakeForm } from "@/features/deck-intake/components/deck-intake-form"
import { CustomPromptTestModal } from "@/features/deck-intake/components/custom-prompt-test-modal"
import { GoldfishSimulationPanel } from "@/features/deck-intake/components/goldfish-simulation-panel"
import { HeroSection } from "@/features/deck-intake/components/hero-section"
import { ProcessedCardsPanel } from "@/features/deck-intake/components/processed-cards-panel"
import { PromptStreamModal } from "@/features/deck-intake/components/prompt-stream-modal"
import { ResetDeckModal } from "@/features/deck-intake/components/reset-deck-modal"
import {
  clearCardOverride,
  clearCardOverrides,
  getCardOverride,
  saveAcceptedFuzzyMatch,
  saveManualCardText,
} from "@/features/deck-intake/lib/card-overrides"
import {
  parseCommanderInput,
  parseDecklist,
} from "@/features/deck-intake/lib/deck-parser"
import {
  DEFAULT_DECK_INPUT,
  loadStoredDeckInput,
  saveStoredDeckInput,
} from "@/features/deck-intake/lib/deck-storage"
import {
  clearStoredSimulationSession,
  loadStoredSimulationSession,
  saveStoredSimulationSession,
} from "@/features/deck-intake/lib/simulation-session-storage"
import {
  cancelPromptRun,
  createPromptRun,
  createStartingHandValidationRun,
  getKeepHandCardsFromEvent,
  getToolGameId,
  markPromptRunError,
  recordPromptStreamEvent,
  restorePromptRuns,
  type GameCardPayload,
  type PromptStreamEvent,
  type SimulationPayload,
  type SimulationPromptRun,
  type StartingHandValidation,
} from "@/features/deck-intake/lib/simulation-session"
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
const SIMULATION_CANCELED_MESSAGE = "Simulation cancelled."
const GOLDFISH_SERVER_URL =
  import.meta.env.VITE_GOLDFISH_SERVER_URL ?? "http://127.0.0.1:3001"

type CreateGameResponse = {
  gameId: string
  seed: number
}

type ResetGameStateResponse =
  | {
      ok: true
      target: "initial" | "opening_hand_snapshot"
      cardsRemaining: number
    }
  | {
      ok: false
      error?: string
    }

type ToolUiDataResponse = {
  structuredContent?: Record<string, unknown>
  uiMetadata?: Record<string, unknown>
}

type OpeningHandSnapshotStatusResponse =
  | {
      ok: true
      hasSnapshot: boolean
      snapshot?: {
        validation: {
          isValid: boolean
          message: string
        }
      }
    }
  | {
      ok: false
      error?: string
    }

type SimulationPromptRunFlow = "main"

type StoredSimulationSessionState = {
  simulationPayload: SimulationPayload | null
  gameId: string
  currentSimulationSeed: number | null
  simulationError: string
  promptRuns: SimulationPromptRun[]
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

function createCancellationError() {
  return new DOMException(SIMULATION_CANCELED_MESSAGE, "AbortError")
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function cancelPromptRuns(
  currentRuns: SimulationPromptRun[]
): SimulationPromptRun[] {
  return currentRuns.map((run) => cancelPromptRun(run))
}

function markPromptRunFailed(
  currentRuns: SimulationPromptRun[],
  runId: string,
  message: string
): SimulationPromptRun[] {
  return currentRuns.map((run) =>
    run.id === runId ? markPromptRunError(run, message) : run
  )
}

async function hydrateToolEvent(
  event: PromptStreamEvent,
  signal?: AbortSignal
): Promise<PromptStreamEvent> {
  if (
    event.type !== "tool" ||
    event.event !== "tool_call.success" ||
    !event.tool ||
    event.structuredContent ||
    event.uiMetadata
  ) {
    return event
  }

  const gameId = getToolGameId(event)

  if (!gameId) {
    return event
  }

  try {
    const response = await fetch(`${GOLDFISH_SERVER_URL}/tool-ui-data`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        toolName: event.tool,
        gameId,
      }),
    })

    if (!response.ok) {
      return event
    }

    const toolUiData = (await response.json()) as ToolUiDataResponse

    return {
      ...event,
      structuredContent: toolUiData.structuredContent ?? event.structuredContent,
      uiMetadata: toolUiData.uiMetadata ?? event.uiMetadata,
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error
    }

    return event
  }
}

function getToolCardsRemaining(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  const cardsRemaining = event.structuredContent?.cardsRemaining

  return typeof cardsRemaining === "number" ? cardsRemaining : undefined
}

function handlePromptStreamEvent(
  event: PromptStreamEvent,
  setPromptRuns: Dispatch<SetStateAction<SimulationPromptRun[]>>,
  runId: string
) {
  setPromptRuns((currentRuns) =>
    currentRuns.map((run) =>
      run.id === runId ? recordPromptStreamEvent(run, event) : run
    )
  )
}

async function readPromptStream(
  response: Response,
  setPromptRuns: Dispatch<SetStateAction<SimulationPromptRun[]>>,
  runId: string,
  signal?: AbortSignal
) {
  if (!response.body) {
    throw new Error("The server response did not include a stream body.")
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let finalResult = ""
  let keptHandCards: string[] = []
  let cardsRemaining: number | null = null

  if (signal?.aborted) {
    throw createCancellationError()
  }

  while (true) {
    const { done, value } = await reader.read()

    if (signal?.aborted) {
      throw createCancellationError()
    }

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() ?? ""

    for (const line of lines) {
      const trimmedLine = line.trim()

      if (!trimmedLine) {
        continue
      }

      const parsedEvent = JSON.parse(trimmedLine) as PromptStreamEvent
      const event = await hydrateToolEvent(parsedEvent, signal)
      handlePromptStreamEvent(event, setPromptRuns, runId)

      if (event.type === "message") {
        finalResult += event.delta
      }

      if (event.type === "tool") {
        keptHandCards = getKeepHandCardsFromEvent(event) ?? keptHandCards
        cardsRemaining = getToolCardsRemaining(event) ?? cardsRemaining
      }

      if (event.type === "error") {
        throw new Error(event.error)
      }

      if (event.type === "done") {
        finalResult = event.result
      }
    }
  }

  const trailing = `${buffer}${decoder.decode()}`.trim()

  if (trailing) {
    const parsedEvent = JSON.parse(trailing) as PromptStreamEvent
    const event = await hydrateToolEvent(parsedEvent, signal)
    handlePromptStreamEvent(event, setPromptRuns, runId)

    if (event.type === "message") {
      finalResult += event.delta
    }

    if (event.type === "tool") {
      keptHandCards = getKeepHandCardsFromEvent(event) ?? keptHandCards
      cardsRemaining = getToolCardsRemaining(event) ?? cardsRemaining
    }

    if (event.type === "error") {
      throw new Error(event.error)
    }

    if (event.type === "done") {
      finalResult = event.result
    }
  }

  return {
    finalResult,
    keptHandCards,
    cardsRemaining,
  }
}

export function App() {
  const [storedDeckInput] = useState(() => loadStoredDeckInput())
  const [storedSimulationSession] = useState<StoredSimulationSessionState>(() => {
    const session = loadStoredSimulationSession()

    return {
      simulationPayload: session.simulationPayload,
      gameId: session.gameId,
      currentSimulationSeed: session.currentSimulationSeed,
      simulationError: session.simulationError,
      promptRuns: restorePromptRuns(session.promptRuns),
    }
  })
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
  const [isPromptStreamModalOpen, setIsPromptStreamModalOpen] = useState(false)
  const [isCustomPromptTestModalOpen, setIsCustomPromptTestModalOpen] =
    useState(false)
  const [isStartingSimulation, setIsStartingSimulation] = useState(false)
  const [isCreatingDevGame, setIsCreatingDevGame] = useState(false)
  const [simulationError, setSimulationError] = useState(
    storedSimulationSession.simulationError
  )
  const [gameId, setGameId] = useState(storedSimulationSession.gameId)
  const [simulationSeedInput, setSimulationSeedInput] = useState(
    storedDeckInput.simulationSeedInput
  )
  const [currentSimulationSeed, setCurrentSimulationSeed] = useState<number | null>(
    storedSimulationSession.currentSimulationSeed
  )
  const [promptRuns, setPromptRuns] = useState<SimulationPromptRun[]>(
    storedSimulationSession.promptRuns
  )
  const [savedSimulationPayload, setSavedSimulationPayload] =
    useState<SimulationPayload | null>(storedSimulationSession.simulationPayload)
  const simulationAbortControllerRef = useRef<AbortController | null>(null)
  const pendingRerunRunIdRef = useRef<string | null>(null)
  const previousDeckInputRef = useRef({
    commanderOneName: storedDeckInput.commanderOneName,
    commanderTwoName: storedDeckInput.commanderTwoName,
    decklistText: storedDeckInput.decklistText,
  })

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

  const completedCards = useMemo(() => {
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
  }, [commanders, missingCards, resolvedCards])
  const fuzzyMatchCount = fuzzyMatches.length
  const missingCardCount = missingCards.filter(
    (card) => !card.isAccepted
  ).length
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

  function getRequestedSimulationSeed() {
    const trimmedValue = simulationSeedInput.trim()

    if (!trimmedValue) {
      return undefined
    }

    if (!/^\d+$/.test(trimmedValue)) {
      throw new Error("Simulation seed must be a whole number.")
    }

    const seed = Number(trimmedValue)

    if (!Number.isSafeInteger(seed) || seed < 0) {
      throw new Error("Simulation seed must be a non-negative whole number.")
    }

    return seed
  }

  async function createGame(
    signal?: AbortSignal,
    seedOverride?: number,
    payloadOverride?: SimulationPayload | null
  ) {
    const resolvedSimulationPayload = payloadOverride ?? simulationPayload

    if (!resolvedSimulationPayload) {
      throw new Error("The deck is not ready for simulation yet.")
    }

    const requestedSeed = seedOverride ?? getRequestedSimulationSeed()

    const response = await fetch(`${GOLDFISH_SERVER_URL}/games`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify(
        {
          ...resolvedSimulationPayload,
          ...(requestedSeed !== undefined ? { seed: requestedSeed } : {}),
        } satisfies {
          commanders: GameCardPayload[]
          deck: GameCardPayload[]
          seed?: number
        }
      ),
    })

    const payload = (await response.json()) as
      | Partial<CreateGameResponse & { error?: string }>
      | { details?: Array<{ message?: string }> }

    if (!response.ok) {
      const detailMessage =
        "details" in payload && Array.isArray(payload.details)
          ? payload.details
            .map((detail) => detail.message)
            .filter(Boolean)
            .join(" ")
          : ""
      throw new Error(
        detailMessage ||
        ("error" in payload && payload.error) ||
        "Failed to create a game."
      )
    }

    if (
      !("gameId" in payload) ||
      !payload.gameId ||
      !("seed" in payload) ||
      typeof payload.seed !== "number"
    ) {
      throw new Error("The server response did not include the game ID and seed.")
    }

    return {
      gameId: payload.gameId,
      seed: payload.seed,
    }
  }

  const handleSubmit: NonNullable<ComponentProps<"form">["onSubmit"]> = async (
    event
  ) => {
    event.preventDefault()
    await processDeck()
  }

  async function processDeck(options?: {
    skipMinProcessingDuration?: boolean
  }) {
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
      const lookupPromise = fetchCardsByName(
        allEntries.map((entry) => entry.name)
      )
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
          nextResolvedCards.push({
            ...toResolvedCard(entry, savedOverride.card, "fuzzy"),
            isCommander: commanderLookup.has(lookupKey),
          })
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

    setSavedSimulationPayload(simulationPayload)
    const abortController = new AbortController()
    simulationAbortControllerRef.current = abortController

    setIsStartingSimulation(true)
    setSimulationError("")
    setGameId("")
    setCurrentSimulationSeed(null)
    setPromptRuns([])

    try {
      const { gameId: nextGameId, seed } = await createGame(
        abortController.signal,
        undefined,
        simulationPayload
      )

      setGameId(nextGameId)
      setCurrentSimulationSeed(seed)

      const openingHandRun = await runOpeningHandSimulation(
        nextGameId,
        "Opening hand simulation",
        abortController.signal,
        {
          flow: "main",
          seed,
        }
      )

      const startingHandValidation = await getStartingHandSnapshotValidation(
        nextGameId,
        abortController.signal
      )

      setPromptRuns((currentRuns) => [
        ...currentRuns,
        createStartingHandValidationRun(
          startingHandValidation,
          openingHandRun.keptHandCards,
          {
            flow: "main",
            gameId: nextGameId,
            seed,
          }
        ),
      ])

      if (!startingHandValidation.isValid) {
        throw new Error(startingHandValidation.message)
      }

      await runTurnSimulation(
        nextGameId,
        "First play decision",
        abortController.signal,
        {
          flow: "main",
          seed,
        }
      )
    } catch (error) {
      if (isAbortError(error)) {
        if (!pendingRerunRunIdRef.current) {
          setPromptRuns((currentRuns) => cancelPromptRuns(currentRuns))
          setSimulationError(SIMULATION_CANCELED_MESSAGE)
        }
      } else {
        setSimulationError(
          error instanceof Error ? error.message : "Failed to create a game."
        )
      }
    } finally {
      if (simulationAbortControllerRef.current === abortController) {
        simulationAbortControllerRef.current = null
      }

      setIsStartingSimulation(false)
    }
  }

  async function getStartingHandSnapshotValidation(
    currentGameId: string,
    signal?: AbortSignal
  ): Promise<StartingHandValidation> {
    const response = await fetch(
      `${GOLDFISH_SERVER_URL}/opening-hand-snapshot-status`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          gameId: currentGameId,
        }),
      }
    )

    const payload = (await response.json()) as OpeningHandSnapshotStatusResponse

    if (!response.ok || !payload.ok) {
      throw new Error(
        ("error" in payload && payload.error) ||
          "Failed to load opening-hand snapshot status."
      )
    }

    if (!payload.hasSnapshot || !payload.snapshot) {
      throw new Error(
        "The opening-hand simulation did not save a starting-hand snapshot."
      )
    }

    return payload.snapshot.validation
  }

  async function resetGameState(
    currentGameId: string,
    target: "initial" | "opening_hand_snapshot",
    signal?: AbortSignal
  ) {
    const response = await fetch(`${GOLDFISH_SERVER_URL}/reset-game-state`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify({
        gameId: currentGameId,
        target,
      }),
    })

    const payload = (await response.json()) as ResetGameStateResponse

    if (!response.ok || !payload.ok) {
      throw new Error(
        ("error" in payload && payload.error) ||
          "Failed to reset the game state."
      )
    }
  }

  async function runTurnSimulation(
    currentGameId: string,
    title: string,
    signal?: AbortSignal,
    options?: {
      flow?: SimulationPromptRunFlow
      seed?: number | null
    }
  ) {
    const turnRun = createPromptRun(title, {
      kind: "turn",
      flow: options?.flow ?? "main",
      gameId: currentGameId,
      seed: options?.seed ?? null,
    })
    setPromptRuns((currentRuns) => [...currentRuns, turnRun])

    try {
      const turnResponse = await fetch(`${GOLDFISH_SERVER_URL}/simulate-turn`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal,
        body: JSON.stringify({
          gameId: currentGameId,
        }),
      })

      if (!turnResponse.ok) {
        const promptPayload = (await turnResponse.json()) as
          | { result?: string; error?: string }
          | { details?: Array<{ message?: string }> }
        const detailMessage =
          "details" in promptPayload && Array.isArray(promptPayload.details)
            ? promptPayload.details
              .map((detail) => detail.message)
              .filter(Boolean)
              .join(" ")
            : ""
        throw new Error(
          detailMessage ||
            ("error" in promptPayload && promptPayload.error) ||
            "Failed to simulate the turn."
        )
      }

      return await readPromptStream(turnResponse, setPromptRuns, turnRun.id, signal)
    } catch (error) {
      if (!isAbortError(error)) {
        const message =
          error instanceof Error ? error.message : "Failed to simulate the turn."
        setPromptRuns((currentRuns) =>
          markPromptRunFailed(currentRuns, turnRun.id, message)
        )
      }

      throw error
    }
  }

  async function runOpeningHandSimulation(
    currentGameId: string,
    title: string,
    signal?: AbortSignal,
    options?: {
      flow?: SimulationPromptRunFlow
      seed?: number | null
    }
  ) {
    const openingHandRun = createPromptRun(title, {
      kind: "opening_hand",
      flow: options?.flow ?? "main",
      gameId: currentGameId,
      seed: options?.seed ?? null,
    })
    setPromptRuns((currentRuns) => [...currentRuns, openingHandRun])

    try {
      const openingHandResponse = await fetch(
        `${GOLDFISH_SERVER_URL}/simulate-drawing-starting-hand`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal,
          body: JSON.stringify({
            gameId: currentGameId,
          }),
        }
      )

      if (!openingHandResponse.ok) {
        const promptPayload = (await openingHandResponse.json()) as
          | { result?: string; error?: string }
          | { details?: Array<{ message?: string }> }
        const detailMessage =
          "details" in promptPayload && Array.isArray(promptPayload.details)
            ? promptPayload.details
              .map((detail) => detail.message)
              .filter(Boolean)
              .join(" ")
            : ""
        throw new Error(
          detailMessage ||
            ("error" in promptPayload && promptPayload.error) ||
            "Failed to simulate drawing the starting hand."
        )
      }

      return await readPromptStream(
        openingHandResponse,
        setPromptRuns,
        openingHandRun.id,
        signal
      )
    } catch (error) {
      if (!isAbortError(error)) {
        const message =
          error instanceof Error
            ? error.message
            : "Failed to simulate drawing the starting hand."
        setPromptRuns((currentRuns) =>
          markPromptRunFailed(currentRuns, openingHandRun.id, message)
        )
      }

      throw error
    }
  }

  function cancelSimulation(runId?: string) {
    if (runId) {
      const matchingRun = promptRuns.find((run) => run.id === runId)

      if (!matchingRun || matchingRun.status !== "running") {
        return
      }
    }

    const controller = simulationAbortControllerRef.current

    if (!controller) {
      return
    }

    controller.abort()
    simulationAbortControllerRef.current = null
    setIsStartingSimulation(false)
    setSimulationError(SIMULATION_CANCELED_MESSAGE)
    setPromptRuns((currentRuns) => cancelPromptRuns(currentRuns))
  }

  async function rerunPromptRun(runId: string) {
    const runIndex = promptRuns.findIndex((run) => run.id === runId)

    if (runIndex === -1) {
      return
    }

    const run = promptRuns[runIndex]

    if (
      !run.rerunnable ||
      (run.status !== "done" &&
        run.status !== "cancelled" &&
        run.status !== "error")
    ) {
      return
    }

    if (isStartingSimulation) {
      pendingRerunRunIdRef.current = runId
      simulationAbortControllerRef.current?.abort()
      return
    }

    const abortController = new AbortController()
    simulationAbortControllerRef.current = abortController

    setIsStartingSimulation(true)
    setSimulationError("")

    try {
      if (run.kind === "opening_hand") {
        await rerunMainSimulationFromOpeningHand(
          runIndex,
          run,
          abortController.signal
        )
      } else if (run.kind === "turn") {
        await rerunMainTurnSimulation(runIndex, run, abortController.signal)
      }
    } catch (error) {
      if (isAbortError(error)) {
        if (!pendingRerunRunIdRef.current) {
          setPromptRuns((currentRuns) => cancelPromptRuns(currentRuns))
          setSimulationError(SIMULATION_CANCELED_MESSAGE)
        }
      } else {
        setSimulationError(
          error instanceof Error ? error.message : "Failed to rerun the simulation."
        )
      }
    } finally {
      if (simulationAbortControllerRef.current === abortController) {
        simulationAbortControllerRef.current = null
      }

      setIsStartingSimulation(false)
    }
  }

  async function rerunMainSimulationFromOpeningHand(
    runIndex: number,
    run: SimulationPromptRun,
    signal?: AbortSignal
  ) {
    const replaySeed = run.seed ?? currentSimulationSeed ?? undefined
    const replayPayload = savedSimulationPayload ?? simulationPayload

    setPromptRuns((currentRuns) => currentRuns.slice(0, runIndex))

    const { gameId: nextGameId, seed } = await createGame(
      signal,
      replaySeed,
      replayPayload
    )
    setGameId(nextGameId)
    setCurrentSimulationSeed(seed)

    const openingHandRun = await runOpeningHandSimulation(
      nextGameId,
      "Opening hand simulation",
      signal,
      {
        flow: "main",
        seed,
      }
    )

    const startingHandValidation = await getStartingHandSnapshotValidation(
      nextGameId,
      signal
    )

    setPromptRuns((currentRuns) => [
      ...currentRuns,
      createStartingHandValidationRun(startingHandValidation, openingHandRun.keptHandCards, {
        flow: "main",
        gameId: nextGameId,
        seed,
      }),
    ])

    if (!startingHandValidation.isValid) {
      throw new Error(startingHandValidation.message)
    }

    await runTurnSimulation(nextGameId, "First play decision", signal, {
      flow: "main",
      seed,
    })
  }

  async function rerunMainTurnSimulation(
    runIndex: number,
    run: SimulationPromptRun,
    signal?: AbortSignal
  ) {
    setPromptRuns((currentRuns) => currentRuns.slice(0, runIndex))
    await resetGameState(run.gameId, "opening_hand_snapshot", signal)
    setGameId(run.gameId)
    setCurrentSimulationSeed(run.seed)

    await runTurnSimulation(run.gameId, "First play decision", signal, {
      flow: "main",
      seed: run.seed,
    })
  }

  async function createDevGame() {
    if (!simulationPayload) {
      return
    }

    setSavedSimulationPayload(simulationPayload)
    setIsCreatingDevGame(true)
    setSimulationError("")
    setCurrentSimulationSeed(null)
    setPromptRuns([])

    try {
      const { gameId: nextGameId, seed } = await createGame(
        undefined,
        undefined,
        simulationPayload
      )

      setGameId(nextGameId)
      setCurrentSimulationSeed(seed)
      await navigator.clipboard.writeText(nextGameId)
    } catch (error) {
      setSimulationError(
        error instanceof Error ? error.message : "Failed to create a game."
      )
    } finally {
      setIsCreatingDevGame(false)
    }
  }

  useEffect(() => {
    saveStoredDeckInput({
      commanderOneName,
      commanderTwoName,
      decklistText,
      simulationSeedInput,
    })
  }, [commanderOneName, commanderTwoName, decklistText, simulationSeedInput])

  useEffect(() => {
    if (
      !savedSimulationPayload &&
      !gameId &&
      currentSimulationSeed === null &&
      !simulationError &&
      !promptRuns.length
    ) {
      clearStoredSimulationSession()
      return
    }

    saveStoredSimulationSession({
      version: 1,
      simulationPayload: savedSimulationPayload,
      gameId,
      currentSimulationSeed,
      simulationError,
      promptRuns,
    })
  }, [
    currentSimulationSeed,
    gameId,
    promptRuns,
    savedSimulationPayload,
    simulationError,
  ])

  useEffect(() => {
    return () => {
      simulationAbortControllerRef.current?.abort()
    }
  }, [])

  useEffect(() => {
    if (!canProcess) {
      return
    }

    const cleanedCommanders = [commanderOneInput, commanderTwoInput]
      .map((commander) => commander.name)
      .filter(Boolean)
    const entries = parseDecklist(decklistText)
    const allNames = cleanedCommanders.concat(
      entries.map((entry) => entry.name)
    )

    if (!allNames.length || !areCardsAvailableInCache(allNames)) {
      return
    }

    void processDeck({ skipMinProcessingDuration: true })
  }, [])

  useEffect(() => {
    if (isStartingSimulation) {
      return
    }

    const pendingRunId = pendingRerunRunIdRef.current

    if (!pendingRunId) {
      return
    }

    pendingRerunRunIdRef.current = null
    setSimulationError("")
    void rerunPromptRun(pendingRunId)
  }, [isStartingSimulation, promptRuns])

  useEffect(() => {
    const previousDeckInput = previousDeckInputRef.current
    const hasDeckInputChanged =
      previousDeckInput.commanderOneName !== commanderOneName ||
      previousDeckInput.commanderTwoName !== commanderTwoName ||
      previousDeckInput.decklistText !== decklistText

    if (!hasDeckInputChanged) {
      return
    }

    previousDeckInputRef.current = {
      commanderOneName,
      commanderTwoName,
      decklistText,
    }

    simulationAbortControllerRef.current?.abort()
    simulationAbortControllerRef.current = null
    pendingRerunRunIdRef.current = null
    setIsStartingSimulation(false)
    setSavedSimulationPayload(null)
    setGameId("")
    setCurrentSimulationSeed(null)
    setSimulationError("")
    setPromptRuns([])
    setIsPromptStreamModalOpen(false)
    clearStoredSimulationSession()
  }, [commanderOneName, commanderTwoName, decklistText])

  function requestResetToSampleDeck() {
    if (isSampleDeckActive) {
      return
    }

    setIsResetModalOpen(true)
  }

  function resetToSampleDeck() {
    simulationAbortControllerRef.current?.abort()
    simulationAbortControllerRef.current = null
    setCommanderOneName(DEFAULT_DECK_INPUT.commanderOneName)
    setCommanderTwoName(DEFAULT_DECK_INPUT.commanderTwoName)
    setDecklistText(DEFAULT_DECK_INPUT.decklistText)
    setResolvedCards([])
    setFuzzyMatches([])
    setMissingCards([])
    setLookupError("")
    setIsProcessing(false)
    setIsResetModalOpen(false)
    setSavedSimulationPayload(null)
    setGameId("")
    setSimulationSeedInput(DEFAULT_DECK_INPUT.simulationSeedInput)
    setCurrentSimulationSeed(null)
    setSimulationError("")
    setPromptRuns([])
    setIsPromptStreamModalOpen(false)
    clearStoredSimulationSession()
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
          isCreatingDevGame={isCreatingDevGame}
          gameId={gameId}
          simulationSeedInput={simulationSeedInput}
          currentSimulationSeed={currentSimulationSeed}
          promptRuns={promptRuns}
          errorMessage={simulationError}
          onSimulationSeedInputChange={setSimulationSeedInput}
          onCancelPromptRun={cancelSimulation}
          onRerunPromptRun={rerunPromptRun}
          onOpenPromptStream={() => setIsPromptStreamModalOpen(true)}
          onOpenCustomPromptTest={() => setIsCustomPromptTestModalOpen(true)}
          onCreateDevGame={createDevGame}
          onStart={startSimulation}
        />
      </div>

      <ResetDeckModal
        isOpen={isResetModalOpen}
        onCancel={() => setIsResetModalOpen(false)}
        onConfirm={resetToSampleDeck}
      />

      <PromptStreamModal
        isOpen={isPromptStreamModalOpen}
        promptRuns={promptRuns}
        isStarting={isStartingSimulation}
        onClose={() => setIsPromptStreamModalOpen(false)}
      />

      <CustomPromptTestModal
        isOpen={isCustomPromptTestModalOpen}
        serverUrl={GOLDFISH_SERVER_URL}
        onClose={() => setIsCustomPromptTestModalOpen(false)}
      />
    </main>
  )
}

export default App






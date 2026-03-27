import { useEffect, useMemo, useRef, useState } from "react"
import type { ComponentProps, Dispatch, SetStateAction } from "react"

import { DeckIntakeForm } from "@/features/deck-intake/components/deck-intake-form"
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

type GameCardPayload = {
  name: string
  cardText: string
}

type ToolUiDataResponse = {
  structuredContent?: Record<string, unknown>
  uiMetadata?: Record<string, unknown>
}

type PromptStreamEvent =
  | {
    type: "start"
    model: {
      displayName: string
      key: string
    }
  }
  | {
    type: "status"
    event: string
    progress?: number
    modelInstanceId?: string
  }
  | {
    type: "reasoning"
    delta: string
  }
  | {
    type: "message"
    delta: string
  }
  | {
    type: "tool"
    event: string
    tool?: string
    provider?: string
    argumentsText?: string
    output?: string
    structuredContent?: Record<string, unknown>
    uiMetadata?: Record<string, unknown>
    error?: string
  }
  | {
    type: "error"
    error: string
  }
  | {
    type: "done"
    result: string
    reasoning: string
  }

type SimulationActivity = {
  id: string
  kind: "thinking" | "tool"
  title: string
  detail?: string
  status: "active" | "done" | "error"
}

type FinalAnswerStatus = "idle" | "streaming" | "done"

type SimulationPromptRun = {
  id: string
  title: string
  activities: SimulationActivity[]
  result: string
  finalAnswerStatus: FinalAnswerStatus
  rawPromptStream: string
  keptHandCards: string[]
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

function createActivityId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createThinkingActivity(): SimulationActivity {
  return {
    id: createActivityId(),
    kind: "thinking",
    title: "Thinking",
    status: "active",
  }
}

function createPromptRun(title: string): SimulationPromptRun {
  return {
    id: createActivityId(),
    title,
    activities: [],
    result: "",
    finalAnswerStatus: "idle",
    rawPromptStream: "",
    keptHandCards: [],
  }
}

function createCancellationError() {
  return new DOMException(SIMULATION_CANCELED_MESSAGE, "AbortError")
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError"
}

function cancelPromptRuns(currentRuns: SimulationPromptRun[]) {
  return currentRuns.map((run) => ({
    ...run,
    rawPromptStream: run.rawPromptStream.includes("[cancelled]")
      ? run.rawPromptStream
      : appendRawPromptStream(run.rawPromptStream, "\n[cancelled]\n"),
    activities: completeActiveActivity(run.activities, "error"),
  }))
}

function createToolActivity(toolName: string | undefined): SimulationActivity {
  return {
    id: createActivityId(),
    kind: "tool",
    title: toolName ? `Calling ${toolName}` : "Calling tool",
    status: "active",
  }
}

function appendRawPromptStream(currentStream: string, chunk: string) {
  return `${currentStream}${chunk}`
}

function completeActiveActivity(
  currentActivities: SimulationActivity[],
  status: SimulationActivity["status"] = "done"
) {
  const nextActivities = [...currentActivities]

  for (let index = nextActivities.length - 1; index >= 0; index -= 1) {
    if (nextActivities[index].status === "active") {
      nextActivities[index] = {
        ...nextActivities[index],
        status,
      }
      break
    }
  }

  return nextActivities
}

function completeActiveThinkingActivity(
  currentActivities: SimulationActivity[],
  status: SimulationActivity["status"] = "done"
) {
  const nextActivities = [...currentActivities]

  for (let index = nextActivities.length - 1; index >= 0; index -= 1) {
    if (
      nextActivities[index].kind === "thinking" &&
      nextActivities[index].status === "active"
    ) {
      nextActivities[index] = {
        ...nextActivities[index],
        status,
      }
      break
    }
  }

  return nextActivities
}

function ensureThinkingActivity(currentActivities: SimulationActivity[]) {
  const lastActivity = currentActivities.at(-1)

  if (lastActivity?.kind === "thinking" && lastActivity.status === "active") {
    return currentActivities
  }

  return [
    ...completeActiveActivity(currentActivities),
    createThinkingActivity(),
  ]
}

function updateLatestToolActivity(
  currentActivities: SimulationActivity[],
  changes: Partial<SimulationActivity>
) {
  const nextActivities = [...currentActivities]

  for (let index = nextActivities.length - 1; index >= 0; index -= 1) {
    if (nextActivities[index].kind === "tool") {
      nextActivities[index] = {
        ...nextActivities[index],
        ...changes,
      }
      break
    }
  }

  return nextActivities
}

function getToolActivityTitle(toolName: string | undefined) {
  return toolName ? `Calling ${toolName}` : "Calling tool"
}

function tryParseJsonObject(value: string | undefined) {
  if (!value) {
    return null
  }

  try {
    const parsed = JSON.parse(value)
    return parsed !== null && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

function getToolGameId(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  const parsedArguments = tryParseJsonObject(event.argumentsText)
  const gameId =
    parsedArguments !== null &&
      "gameId" in parsedArguments &&
      typeof parsedArguments.gameId === "string"
      ? parsedArguments.gameId.trim()
      : ""

  return gameId || undefined
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

function getStructuredToolCards(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  if (!Array.isArray(event.structuredContent?.cards)) {
    return undefined
  }

  const cards = event.structuredContent.cards
    .filter((card): card is string => typeof card === "string")
    .map((card) => card.trim())
    .filter(Boolean)

  return cards.length ? cards : undefined
}

function getMulliganReason(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  if (event.tool !== "mulligan") {
    return undefined
  }

  const parsedArguments = tryParseJsonObject(event.argumentsText)
  const reason =
    parsedArguments !== null &&
      "reason" in parsedArguments &&
      typeof parsedArguments.reason === "string"
      ? parsedArguments.reason.trim()
      : ""

  return reason || undefined
}

function getMulliganDetail(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  if (event.tool !== "mulligan") {
    return undefined
  }

  const reason = getMulliganReason(event)
  const cards = getStructuredToolCards(event)

  if (!reason && !cards?.length) {
    return undefined
  }

  const parts: string[] = []

  if (reason) {
    parts.push(`Reason: ${reason}`)
  }

  if (cards?.length) {
    parts.push(`New hand: ${cards.join(", ")}`)
  }

  return parts.join(". ")
}

function getKeepHandCards(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  if (event.tool !== "keep_hand") {
    return undefined
  }

  const parsedArguments = tryParseJsonObject(event.argumentsText)

  if (
    parsedArguments === null ||
    !("cards" in parsedArguments) ||
    !Array.isArray(parsedArguments.cards)
  ) {
    return undefined
  }

  const cards = parsedArguments.cards
    .filter((card: unknown): card is string => typeof card === "string")
    .map((card: string) => card.trim())
    .filter(Boolean)

  return cards.length ? cards : undefined
}

function getDrawStartingHandDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  if (event.tool !== "draw_starting_hand") {
    return undefined
  }

  const cards = getStructuredToolCards(event)

  return cards?.length ? `Cards: ${cards.join(", ")}` : undefined
}

function getToolActivityDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  const mulliganDetail = getMulliganDetail(event)

  if (mulliganDetail) {
    return mulliganDetail
  }

  const keepHandCards = getKeepHandCards(event)

  if (keepHandCards) {
    return keepHandCards.join(", ")
  }

  const drawStartingHandDetail = getDrawStartingHandDetail(event)

  if (drawStartingHandDetail) {
    return drawStartingHandDetail
  }

  return undefined
}

function handlePromptStreamEvent(
  event: PromptStreamEvent,
  setPromptRuns: Dispatch<SetStateAction<SimulationPromptRun[]>>,
  runId: string
) {
  switch (event.type) {
    case "start":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === runId
            ? {
              ...run,
              rawPromptStream: appendRawPromptStream(
                run.rawPromptStream,
                `[model] ${event.model.displayName} (${event.model.key})\n\n`
              ),
              activities: [createThinkingActivity()],
            }
            : run
        )
      )
      return
    case "status":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) => {
          if (run.id !== runId) {
            return run
          }

          let nextActivities = run.activities

          if (event.event === "reasoning.start") {
            nextActivities = ensureThinkingActivity(nextActivities)
          } else if (event.event === "message.start") {
            nextActivities = completeActiveThinkingActivity(nextActivities)
          }

          return {
            ...run,
            rawPromptStream: appendRawPromptStream(
              run.rawPromptStream,
              `[${event.event}${typeof event.progress === "number" ? ` ${Math.round(event.progress * 100)}%` : ""}]\n`
            ),
            activities: nextActivities,
          }
        })
      )
      return
    case "reasoning":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === runId
            ? {
              ...run,
              rawPromptStream: appendRawPromptStream(
                run.rawPromptStream,
                event.delta
              ),
            }
            : run
        )
      )
      return
    case "message":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === runId
            ? {
              ...run,
              rawPromptStream: appendRawPromptStream(
                run.rawPromptStream,
                event.delta
              ),
              finalAnswerStatus: "streaming",
              result: `${run.result}${event.delta}`,
            }
            : run
        )
      )
      return
    case "tool":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) => {
          if (run.id !== runId) {
            return run
          }

          let nextActivities = run.activities

          if (event.event === "tool_call.start") {
            nextActivities = [
              ...completeActiveActivity(nextActivities),
              createToolActivity(event.tool),
            ]
          } else if (event.event === "tool_call.arguments") {
            nextActivities = updateLatestToolActivity(nextActivities, {
              title: getToolActivityTitle(event.tool),
              detail: getToolActivityDetail(event),
            })
          } else if (event.event === "tool_call.success") {
            nextActivities = updateLatestToolActivity(nextActivities, {
              status: "done",
              title: getToolActivityTitle(event.tool),
              detail: getToolActivityDetail(event),
            })
          } else if (event.event === "tool_call.failure") {
            nextActivities = updateLatestToolActivity(nextActivities, {
              status: "error",
              title: getToolActivityTitle(event.tool),
              detail: getToolActivityDetail(event),
            })
          }

          return {
            ...run,
            rawPromptStream: appendRawPromptStream(
              run.rawPromptStream,
              `${JSON.stringify(event, null, 2)}\n\n`
            ),
            activities: nextActivities,
          }
        })
      )
      return
    case "error":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === runId
            ? {
              ...run,
              rawPromptStream: appendRawPromptStream(
                run.rawPromptStream,
                `[error] ${event.error}\n`
              ),
              activities: completeActiveActivity(run.activities, "error"),
            }
            : run
        )
      )
      return
    case "done":
      setPromptRuns((currentRuns) =>
        currentRuns.map((run) =>
          run.id === runId
            ? {
              ...run,
              rawPromptStream: appendRawPromptStream(
                run.rawPromptStream,
                "\n[chat.end]\n"
              ),
              activities: completeActiveActivity(run.activities),
              finalAnswerStatus: "done",
              result: event.result,
            }
            : run
        )
      )
      return
  }
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
        keptHandCards = getKeepHandCards(event) ?? keptHandCards
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
      keptHandCards = getKeepHandCards(event) ?? keptHandCards
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
  }
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
  const [isPromptStreamModalOpen, setIsPromptStreamModalOpen] = useState(false)
  const [isStartingSimulation, setIsStartingSimulation] = useState(false)
  const [isCreatingDevGame, setIsCreatingDevGame] = useState(false)
  const [simulationError, setSimulationError] = useState("")
  const [gameId, setGameId] = useState("")
  const [promptRuns, setPromptRuns] = useState<SimulationPromptRun[]>([])
  const simulationAbortControllerRef = useRef<AbortController | null>(null)

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

  async function createGame(signal?: AbortSignal) {
    if (!simulationPayload) {
      throw new Error("The deck is not ready for simulation yet.")
    }

    const response = await fetch(`${GOLDFISH_SERVER_URL}/games`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      signal,
      body: JSON.stringify(
        simulationPayload satisfies {
          commanders: GameCardPayload[]
          deck: GameCardPayload[]
        }
      ),
    })

    const payload = (await response.json()) as
      | { gameId?: string; error?: string }
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

    if (!("gameId" in payload) || !payload.gameId) {
      throw new Error("The server response did not include a game ID.")
    }

    return payload.gameId
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

    const abortController = new AbortController()
    simulationAbortControllerRef.current = abortController

    setIsStartingSimulation(true)
    setSimulationError("")
    setGameId("")
    setPromptRuns([])

    try {
      const nextGameId = await createGame(abortController.signal)

      setGameId(nextGameId)

      const { keptHandCards } = await runOpeningHandSimulation(
        nextGameId,
        "Opening hand simulation",
        abortController.signal
      )

      if (!keptHandCards.length) {
        throw new Error(
          "The opening-hand simulation did not report a final kept hand through keep_hand."
        )
      }

      const nextPlayRun = createPromptRun("First play decision")
      setPromptRuns((currentRuns) => [...currentRuns, nextPlayRun])

      const followUpResponse = await fetch(
        `${GOLDFISH_SERVER_URL}/process-prompt`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          signal: abortController.signal,
          body: JSON.stringify({
            prompt: `Given this starting hand:\n\n${keptHandCards.join("\n")}\n\nWhat card do you want to play first given the starting hand?`,
          }),
        }
      )

      if (!followUpResponse.ok) {
        const promptPayload = (await followUpResponse.json()) as
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
          "Failed to decide the first card to play."
        )
      }

      await readPromptStream(
        followUpResponse,
        setPromptRuns,
        nextPlayRun.id,
        abortController.signal
      )
    } catch (error) {
      if (isAbortError(error)) {
        setPromptRuns((currentRuns) => cancelPromptRuns(currentRuns))
        setSimulationError(SIMULATION_CANCELED_MESSAGE)
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

  async function runOpeningHandSimulation(
    currentGameId: string,
    title: string,
    signal?: AbortSignal
  ) {
    const openingHandRun = createPromptRun(title)
    setPromptRuns((currentRuns) => [...currentRuns, openingHandRun])

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

    return readPromptStream(
      openingHandResponse,
      setPromptRuns,
      openingHandRun.id,
      signal
    )
  }

  async function startOpeningHandBatchTest() {
    if (!simulationPayload) {
      return
    }

    const abortController = new AbortController()
    simulationAbortControllerRef.current = abortController

    setIsStartingSimulation(true)
    setSimulationError("")
    setGameId("")
    setPromptRuns([])

    try {
      for (let runNumber = 1; runNumber <= 10; runNumber += 1) {
        if (abortController.signal.aborted) {
          throw createCancellationError()
        }

        const nextGameId = await createGame(abortController.signal)
        setGameId(nextGameId)

        await runOpeningHandSimulation(
          nextGameId,
          `Opening hand simulation ${runNumber}/10`,
          abortController.signal
        )
      }
    } catch (error) {
      if (isAbortError(error)) {
        setPromptRuns((currentRuns) => cancelPromptRuns(currentRuns))
        setSimulationError(SIMULATION_CANCELED_MESSAGE)
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

  function cancelSimulation() {
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

  async function createDevGame() {
    if (!simulationPayload) {
      return
    }

    setIsCreatingDevGame(true)
    setSimulationError("")
    setPromptRuns([])

    try {
      const nextGameId = await createGame()

      setGameId(nextGameId)
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
    })
  }, [commanderOneName, commanderTwoName, decklistText])

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
    simulationAbortControllerRef.current?.abort()
    simulationAbortControllerRef.current = null
    setIsStartingSimulation(false)
    setGameId("")
    setSimulationError("")
    setPromptRuns([])
    setIsPromptStreamModalOpen(false)
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
    setGameId("")
    setSimulationError("")
    setPromptRuns([])
    setIsPromptStreamModalOpen(false)
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

  const combinedPromptStream = useMemo(
    () =>
      promptRuns
        .map(
          (run) =>
            `=== ${run.title} ===\n${run.rawPromptStream.trim() || "No prompt stream yet."}`
        )
        .join("\n\n"),
    [promptRuns]
  )

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
          promptRuns={promptRuns}
          errorMessage={simulationError}
          onOpenPromptStream={() => setIsPromptStreamModalOpen(true)}
          onCreateDevGame={createDevGame}
          onStart={startSimulation}
          onStartOpeningHandBatchTest={startOpeningHandBatchTest}
        />
      </div>

      <ResetDeckModal
        isOpen={isResetModalOpen}
        onCancel={() => setIsResetModalOpen(false)}
        onConfirm={resetToSampleDeck}
      />

      <PromptStreamModal
        isOpen={isPromptStreamModalOpen}
        streamText={combinedPromptStream}
        isStarting={isStartingSimulation}
        onCancel={cancelSimulation}
        onClose={() => setIsPromptStreamModalOpen(false)}
      />
    </main>
  )
}

export default App







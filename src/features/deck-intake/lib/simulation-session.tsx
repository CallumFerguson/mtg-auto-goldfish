import { ToolCardList } from "@/features/deck-intake/components/tool-card-elements"

export type GameCardPayload = {
  name: string
  cardText: string
}

export type SimulationPayload = {
  commanders: GameCardPayload[]
  deck: GameCardPayload[]
}

export type StartingHandValidation = {
  isValid: boolean
  message: string
}

export type PromptStreamEvent =
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

export type SimulationActivityDetail =
  | {
      kind: "text"
      text: string
    }
  | {
      kind: "preformatted_text"
      text: string
    }
  | {
      kind: "card_list"
      cards: string[]
      label?: string
    }
  | {
      kind: "stack"
      items: SimulationActivityDetail[]
    }

export type SimulationActivity = {
  id: string
  kind: "thinking" | "tool"
  title: string
  detail?: SimulationActivityDetail
  status: "active" | "done" | "error"
  transient?: boolean
}

export type FinalAnswerStatus = "idle" | "streaming" | "done"
export type SimulationPromptRunStatus = "running" | "done" | "error" | "cancelled"
export type SimulationPromptRunKind =
  | "opening_hand"
  | "starting_hand_validation"
  | "turn"
export type SimulationPromptRunFlow = "main"

export type PromptRunEventRecord =
  | {
      type: "prompt_stream_event"
      event: PromptStreamEvent
    }
  | {
      type: "starting_hand_validation"
      validation: StartingHandValidation
      keptHandCards: string[]
    }
  | {
      type: "local_error"
      message: string
    }
  | {
      type: "cancelled"
    }

export type SimulationPromptRun = {
  id: string
  title: string
  kind: SimulationPromptRunKind
  flow: SimulationPromptRunFlow
  gameId: string
  seed: number | null
  rerunnable: boolean
  eventLog: PromptRunEventRecord[]
  activities: SimulationActivity[]
  result: string
  finalAnswerStatus: FinalAnswerStatus
  status: SimulationPromptRunStatus
  rawPromptStream: string
  keptHandCards: string[]
}

export function createActivityId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function createPromptRun(
  title: string,
  options: {
    kind: SimulationPromptRunKind
    flow: SimulationPromptRunFlow
    gameId: string
    seed: number | null
    rerunnable?: boolean
  }
): SimulationPromptRun {
  return {
    id: createActivityId(),
    title,
    kind: options.kind,
    flow: options.flow,
    gameId: options.gameId,
    seed: options.seed,
    rerunnable: options.rerunnable ?? true,
    eventLog: [],
    activities: [],
    result: "",
    finalAnswerStatus: "idle",
    status: "running",
    rawPromptStream: "",
    keptHandCards: [],
  }
}

export function createStartingHandValidationRun(
  validation: StartingHandValidation,
  keptHandCards: string[],
  options: {
    flow: SimulationPromptRunFlow
    gameId: string
    seed: number | null
  }
): SimulationPromptRun {
  return recomputePromptRun({
    id: createActivityId(),
    title: "Starting hand validation",
    kind: "starting_hand_validation",
    flow: options.flow,
    gameId: options.gameId,
    seed: options.seed,
    rerunnable: false,
    eventLog: [
      {
        type: "starting_hand_validation",
        validation,
        keptHandCards,
      },
    ],
    activities: [],
    result: "",
    finalAnswerStatus: "idle",
    status: validation.isValid ? "done" : "error",
    rawPromptStream: "",
    keptHandCards: [],
  })
}

export function recordPromptStreamEvent(
  run: SimulationPromptRun,
  event: PromptStreamEvent
) {
  return recomputePromptRun({
    ...run,
    eventLog: [...run.eventLog, { type: "prompt_stream_event", event }],
  })
}

export function markPromptRunError(run: SimulationPromptRun, message: string) {
  return recomputePromptRun({
    ...run,
    eventLog: [...run.eventLog, { type: "local_error", message }],
  })
}

export function cancelPromptRun(run: SimulationPromptRun) {
  if (run.eventLog.some((eventRecord) => eventRecord.type === "cancelled")) {
    return run
  }

  return recomputePromptRun({
    ...run,
    eventLog: [...run.eventLog, { type: "cancelled" }],
  })
}

export function restorePromptRuns(promptRuns: SimulationPromptRun[]) {
  return promptRuns.map((run) => {
    const recomputedRun = recomputePromptRun(run)

    if (recomputedRun.status !== "running") {
      return recomputedRun
    }

    return cancelPromptRun(recomputedRun)
  })
}

export function renderSimulationActivityDetail(
  detail: SimulationActivityDetail | undefined
): React.ReactNode {
  if (!detail) {
    return null
  }

  switch (detail.kind) {
    case "text":
      return <p className="text-xs leading-5 text-stone-400">{detail.text}</p>
    case "preformatted_text":
      return (
        <pre className="overflow-x-auto rounded-2xl border border-white/10 bg-black/20 p-3 text-xs leading-5 whitespace-pre-wrap text-stone-300">
          {detail.text}
        </pre>
      )
    case "card_list":
      return <ToolCardList cards={detail.cards} label={detail.label} />
    case "stack":
      return (
        <div className="space-y-2">
          {detail.items.map((item, index) => (
            <div key={index}>{renderSimulationActivityDetail(item)}</div>
          ))}
        </div>
      )
  }
}

export function getKeepHandCardsFromEvent(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
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

export function getToolGameId(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  const parsedArguments = tryParseJsonObject(event.argumentsText)
  const gameId =
    parsedArguments !== null &&
    "gameId" in parsedArguments &&
    typeof parsedArguments.gameId === "string"
      ? parsedArguments.gameId.trim()
      : ""

  return gameId || undefined
}

function recomputePromptRun(run: SimulationPromptRun): SimulationPromptRun {
  let nextRun: SimulationPromptRun = {
    ...run,
    activities: [],
    result: "",
    finalAnswerStatus: "idle",
    status: run.kind === "starting_hand_validation" ? "done" : "running",
    rawPromptStream: "",
    keptHandCards: [],
  }

  for (const [eventIndex, eventRecord] of run.eventLog.entries()) {
    const activityIdBase = `${run.id}-activity-${eventIndex}`

    switch (eventRecord.type) {
      case "prompt_stream_event":
        nextRun = applyPromptStreamEvent(nextRun, eventRecord.event, activityIdBase)
        break
      case "starting_hand_validation":
        nextRun = applyStartingHandValidation(
          nextRun,
          eventRecord.validation,
          eventRecord.keptHandCards,
          `${activityIdBase}-validation`
        )
        break
      case "local_error":
        nextRun = applyLocalError(nextRun, eventRecord.message)
        break
      case "cancelled":
        nextRun = applyCancelled(nextRun)
        break
    }
  }

  return nextRun
}

function applyPromptStreamEvent(
  run: SimulationPromptRun,
  event: PromptStreamEvent,
  activityIdBase: string
): SimulationPromptRun {
  switch (event.type) {
    case "start":
      return {
        ...run,
        rawPromptStream: appendRawPromptStream(
          run.rawPromptStream,
          `[model] ${event.model.displayName} (${event.model.key})\n\n`
        ),
        activities: [createThinkingActivity(`${activityIdBase}-thinking`)],
      }
    case "status": {
      let nextActivities = run.activities

      if (event.event === "reasoning.start") {
        nextActivities = ensureThinkingActivity(
          nextActivities,
          `${activityIdBase}-thinking`
        )
      }

      return {
        ...run,
        rawPromptStream: appendRawPromptStream(
          run.rawPromptStream,
          `[${event.event}${typeof event.progress === "number" ? ` ${Math.round(event.progress * 100)}%` : ""}]\n`
        ),
        activities: nextActivities,
      }
    }
    case "reasoning":
      return {
        ...run,
        rawPromptStream: appendRawPromptStream(run.rawPromptStream, event.delta),
      }
    case "message":
      return {
        ...run,
        activities: resolveActiveThinkingActivity(run.activities),
        rawPromptStream: appendRawPromptStream(run.rawPromptStream, event.delta),
        finalAnswerStatus: "streaming",
        result: `${run.result}${event.delta}`,
      }
    case "tool": {
      let nextActivities = run.activities

      if (event.event === "tool_call.start") {
        nextActivities = replaceTransientActivity(
          nextActivities,
          createToolActivity(event.tool, `${activityIdBase}-tool`)
        )
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

      if (
        event.event === "tool_call.success" ||
        event.event === "tool_call.failure"
      ) {
        nextActivities = ensureProcessingActivity(
          nextActivities,
          `${activityIdBase}-processing`
        )
      }

      return {
        ...run,
        rawPromptStream: appendRawPromptStream(
          run.rawPromptStream,
          `${JSON.stringify(event, null, 2)}\n\n`
        ),
        activities: nextActivities,
        keptHandCards:
          getKeepHandCardsFromEvent(event as Extract<PromptStreamEvent, { type: "tool" }>) ??
          run.keptHandCards,
      }
    }
    case "error":
      return {
        ...run,
        status: "error",
        rawPromptStream: appendRawPromptStream(
          run.rawPromptStream,
          `[error] ${event.error}\n`
        ),
        activities: completeActiveActivity(run.activities, "error"),
      }
    case "done":
      return {
        ...run,
        status: "done",
        rawPromptStream: appendRawPromptStream(run.rawPromptStream, "\n[chat.end]\n"),
        activities: completeActiveActivity(
          removeActiveThinkingActivity(run.activities)
        ),
        finalAnswerStatus: "done",
        result: event.result,
      }
  }
}

function applyStartingHandValidation(
  run: SimulationPromptRun,
  validation: StartingHandValidation,
  keptHandCards: string[],
  activityId: string
): SimulationPromptRun {
  return {
    ...run,
    activities: [
      {
        id: activityId,
        kind: "tool",
        title: validation.isValid
          ? "Starting hand is valid"
          : "Starting hand is invalid",
        detail: {
          kind: "stack",
          items: [
            { kind: "text", text: validation.message },
            ...(keptHandCards.length
              ? [
                  {
                    kind: "card_list" as const,
                    cards: keptHandCards,
                    label: validation.isValid ? "Kept hand:" : "Rejected hand:",
                  },
                ]
              : []),
          ],
        },
        status: validation.isValid ? "done" : "error",
      },
    ],
    result: "",
    finalAnswerStatus: "idle",
    status: validation.isValid ? "done" : "error",
    rawPromptStream: `[starting-hand-validation] ${validation.message}\n`,
    keptHandCards,
  }
}

function applyLocalError(run: SimulationPromptRun, message: string): SimulationPromptRun {
  return {
    ...run,
    status: "error",
    rawPromptStream: appendRawPromptStream(run.rawPromptStream, `[error] ${message}\n`),
    activities: completeActiveActivity(run.activities, "error"),
  }
}

function applyCancelled(run: SimulationPromptRun): SimulationPromptRun {
  if (run.status === "done" || run.status === "error") {
    return run
  }

  return {
    ...run,
    status: "cancelled",
    rawPromptStream: appendRawPromptStream(run.rawPromptStream, "\n[cancelled]\n"),
    activities: completeActiveActivity(run.activities, "error"),
  }
}

function createThinkingActivity(activityId: string): SimulationActivity {
  return {
    id: activityId,
    kind: "thinking",
    title: "Thinking",
    status: "active",
  }
}

function createProcessingActivity(activityId: string): SimulationActivity {
  return {
    id: activityId,
    kind: "thinking",
    title: "Thinking",
    status: "active",
    transient: true,
  }
}

function createToolActivity(
  toolName: string | undefined,
  activityId: string
): SimulationActivity {
  return {
    id: activityId,
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

function removeActiveThinkingActivity(currentActivities: SimulationActivity[]) {
  const nextActivities = [...currentActivities]

  for (let index = nextActivities.length - 1; index >= 0; index -= 1) {
    if (
      nextActivities[index].kind === "thinking" &&
      nextActivities[index].status === "active"
    ) {
      nextActivities.splice(index, 1)
      break
    }
  }

  return nextActivities
}

function ensureThinkingActivity(
  currentActivities: SimulationActivity[],
  activityId: string
) {
  const lastActivity = currentActivities.at(-1)

  if (lastActivity?.kind === "thinking" && lastActivity.status === "active") {
    if (lastActivity.transient || lastActivity.title !== "Thinking") {
      return [
        ...currentActivities.slice(0, -1),
        {
          ...lastActivity,
          title: "Thinking",
          transient: false,
        },
      ]
    }

    return currentActivities
  }

  return [
    ...completeActiveActivity(currentActivities),
    createThinkingActivity(activityId),
  ]
}

function ensureProcessingActivity(
  currentActivities: SimulationActivity[],
  activityId: string
) {
  const lastActivity = currentActivities.at(-1)

  if (lastActivity?.status === "active") {
    return currentActivities
  }

  return [...currentActivities, createProcessingActivity(activityId)]
}

function replaceTransientActivity(
  currentActivities: SimulationActivity[],
  activity: SimulationActivity
) {
  const lastActivity = currentActivities.at(-1)

  if (lastActivity?.status === "active" && lastActivity.transient) {
    return [...currentActivities.slice(0, -1), activity]
  }

  if (lastActivity?.kind === "thinking" && lastActivity.status === "active") {
    return [...currentActivities.slice(0, -1), activity]
  }

  return [...completeActiveActivity(currentActivities), activity]
}

function resolveActiveThinkingActivity(currentActivities: SimulationActivity[]) {
  const lastActivity = currentActivities.at(-1)

  if (lastActivity?.kind !== "thinking" || lastActivity.status !== "active") {
    return currentActivities
  }

  return removeActiveThinkingActivity(currentActivities)
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

  return {
    kind: "stack" as const,
    items: [
      ...(reason ? [{ kind: "text" as const, text: `Reason: ${reason}` }] : []),
      ...(cards?.length
        ? [{ kind: "card_list" as const, cards, label: "New Hand:" }]
        : []),
    ],
  }
}

function getDrawStartingHandDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  if (event.tool !== "draw_starting_hand") {
    return undefined
  }

  const cards = getStructuredToolCards(event)

  return cards?.length ? { kind: "card_list" as const, cards } : undefined
}

function getDrawToolDetail(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  if (
    event.tool !== "draw_card_from_top" &&
    event.tool !== "draw_card_from_bottom"
  ) {
    return undefined
  }

  const cards = getStructuredToolCards(event)

  if (!cards?.length) {
    return undefined
  }

  return {
    kind: "card_list" as const,
    cards,
    label: event.tool === "draw_card_from_top" ? "Drawn from top:" : "Drawn from bottom:",
  }
}

function getReturnToolCards(event: Extract<PromptStreamEvent, { type: "tool" }>) {
  if (event.tool === "return_card_to_library") {
    const card = event.structuredContent?.card

    if (typeof card !== "string") {
      return undefined
    }

    const trimmedCard = card.trim()
    return trimmedCard ? [trimmedCard] : undefined
  }

  if (event.tool === "return_cards_to_library") {
    return getStructuredToolCards(event)
  }

  return undefined
}

function getReturnToolDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  const cards = getReturnToolCards(event)

  if (!cards?.length) {
    return undefined
  }

  const side =
    typeof event.structuredContent?.side === "string"
      ? event.structuredContent.side
      : undefined

  return {
    kind: "card_list" as const,
    cards,
    label: side ? `Returned to ${side}:` : "Returned cards:",
  }
}

function getTakeCardsFromLibraryDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  if (event.tool !== "take_cards_from_library") {
    return undefined
  }

  const matches = Array.isArray(event.structuredContent?.matches)
    ? event.structuredContent.matches.filter(
        (
          match
        ): match is {
          requestedCard: string
          foundCard: string | null
        } =>
          match !== null &&
          typeof match === "object" &&
          "requestedCard" in match &&
          typeof match.requestedCard === "string" &&
          "foundCard" in match &&
          (typeof match.foundCard === "string" || match.foundCard === null)
      )
    : []
  const foundCards = Array.isArray(event.structuredContent?.foundCards)
    ? event.structuredContent.foundCards
        .filter((card): card is string => typeof card === "string")
        .map((card) => card.trim())
        .filter(Boolean)
    : []

  if (!matches.length && !foundCards.length) {
    return undefined
  }

  const missedCards = matches
    .filter((match) => match.foundCard === null)
    .map((match) => match.requestedCard.trim())
    .filter(Boolean)
  const requestedCount = matches.length || foundCards.length
  const cardLabel = requestedCount === 1 ? "card" : "cards"

  return {
    kind: "stack" as const,
    items: [
      {
        kind: "text" as const,
        text: `Found ${foundCards.length}/${requestedCount} ${cardLabel}.${missedCards.length ? ` No close match for: ${missedCards.join(", ")}.` : ""}`,
      },
      ...(foundCards.length
        ? [
            {
              kind: "card_list" as const,
              cards: foundCards,
              label: "Taken from library:",
            },
          ]
        : []),
    ],
  }
}

function getUpdateGameStateDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  if (event.tool !== "update_game_state") {
    return undefined
  }

  const gameState = event.structuredContent?.gameState

  if (typeof gameState !== "string") {
    return undefined
  }

  const trimmedGameState = gameState.trim()

  if (!trimmedGameState) {
    return undefined
  }

  return {
    kind: "preformatted_text" as const,
    text: trimmedGameState,
  }
}

function getToolActivityDetail(
  event: Extract<PromptStreamEvent, { type: "tool" }>
) {
  const updateGameStateDetail = getUpdateGameStateDetail(event)

  if (updateGameStateDetail) {
    return updateGameStateDetail
  }

  const mulliganDetail = getMulliganDetail(event)

  if (mulliganDetail) {
    return mulliganDetail
  }

  const keepHandCards = getKeepHandCardsFromEvent(event)

  if (keepHandCards) {
    return {
      kind: "card_list" as const,
      cards: keepHandCards,
    }
  }

  const drawStartingHandDetail = getDrawStartingHandDetail(event)

  if (drawStartingHandDetail) {
    return drawStartingHandDetail
  }

  const drawToolDetail = getDrawToolDetail(event)

  if (drawToolDetail) {
    return drawToolDetail
  }

  const returnToolDetail = getReturnToolDetail(event)

  if (returnToolDetail) {
    return returnToolDetail
  }

  return getTakeCardsFromLibraryDetail(event)
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

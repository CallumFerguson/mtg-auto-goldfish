import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptProcessorOptions,
  PromptStreamEvent,
} from "./index.js"

export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234"
export const LM_STUDIO_PROMPT_TIMEOUT_MS = 10 * 60 * 1000
const STREAM_LOOP_SEQUENCE_LENGTH = 250
const STREAM_LOOP_LOOKBACK_LENGTH = 2500
const STREAM_LOOP_REPEAT_THRESHOLD = 3
const STREAM_LOOP_ERROR_MESSAGE = "The LLM got stuck in a loop."

type LmStudioModelsResponse = {
  models: Array<{
    type: "llm" | "embedding"

    key: string

    display_name: string

    size_bytes: number

    loaded_instances: Array<{
      id: string
    }>
  }>
}

type LmStudioOutputItem =
  | {
    type: "message"

    content: string
  }
  | {
    type: "reasoning"

    content: string
  }
  | {
    type: string

    content?: string
  }

type LmStudioChatResponse = {
  output?: LmStudioOutputItem[]
}

type LmStudioChatStreamEndEvent = {
  type: "chat.end"

  result?: LmStudioChatResponse
}

export function createLmStudioPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? LM_STUDIO_DEFAULT_BASE_URL
  )

  const apiToken = options.apiToken?.trim() || options.apiKey?.trim() || undefined
  const requestedModel = options.model?.trim() || undefined

  const fetchImpl = options.fetchImpl ?? fetch

  const mcpServerUrl = options.mcpServerUrl?.trim()

  const mcpServerLabel = options.mcpServerLabel?.trim() || "mtg-auto-goldfish"

  return {
    async processPrompt(prompt: string): Promise<PromptProcessingResult> {
      const loadedModels = await listLoadedTextModels({
        apiToken,

        baseUrl,

        fetchImpl,
      })

      const selectedModel = pickLoadedModel(loadedModels, requestedModel)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      const { signal, cleanup } = createTimeoutSignal(
        undefined,
        LM_STUDIO_PROMPT_TIMEOUT_MS
      )

      try {
        const chatResponse = await requestJson<LmStudioChatResponse>(
          fetchImpl,

          `${baseUrl}/api/v1/chat`,

          {
            method: "POST",

            headers: buildHeaders(apiToken),

            signal,

            body: JSON.stringify({
              model: selectedModel.key,

              input: prompt,

              integrations: buildIntegrations({
                mcpServerLabel,

                mcpServerUrl,
              }),


              stream: false,

              store: false,
            }),
          }
        )

        const result = extractMessageText(chatResponse)

        if (!result) {
          throw new Error(
            "LM Studio returned no message content for this prompt."
          )
        }

        return {
          result,

          model: selectedModel,
        }
      } catch (error) {
        throw normalizePromptAbortError(error)
      } finally {
        cleanup()
      }
    },

    async processPromptStream(
      prompt: string,

      onEvent: (event: PromptStreamEvent) => void,
      signal?: AbortSignal
    ): Promise<PromptProcessingResult> {
      const loadedModels = await listLoadedTextModels({
        apiToken,

        baseUrl,

        fetchImpl,
      })

      const selectedModel = pickLoadedModel(loadedModels, requestedModel)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      onEvent({
        type: "start",

        model: selectedModel,
      })

      const {
        signal: timeoutSignal,
        abort: abortPrompt,
        cleanup,
      } = createTimeoutSignal(signal, LM_STUDIO_PROMPT_TIMEOUT_MS)

      let finalResult = ""
      let finalReasoning = ""
      let streamedText = ""
      let pendingMessageStartPayload: Record<
        string,
        string | undefined
      > | null = null
      let hasFlushedMessageBlock = false

      try {
        const response = await fetchImpl(`${baseUrl}/api/v1/chat`, {
          method: "POST",

          headers: buildHeaders(apiToken),

          signal: timeoutSignal,

          body: JSON.stringify({
            model: selectedModel.key,

            input: prompt,

            integrations: buildIntegrations({
              mcpServerLabel,

              mcpServerUrl,
            }),


            stream: true,

            store: false,
          }),
        })

        if (!response.ok) {
          throw new Error(await buildErrorMessage(response))
        }

        if (!response.body) {
          throw new Error("LM Studio returned no stream body for this prompt.")
        }

        await consumeSseStream(response, (eventName, payload) => {
          switch (eventName) {
            case "chat.start":

            case "model_load.start":

            case "model_load.end":

            case "prompt_processing.start":

            case "prompt_processing.end":

            case "reasoning.start":

            case "reasoning.end":
              onEvent({
                type: "status",

                event: eventName,

                modelInstanceId: asStringRecord(payload).model_instance_id,
              })

              break

            case "message.start":
              pendingMessageStartPayload = asStringRecord(payload)
              hasFlushedMessageBlock = false
              break
            case "message.end":
              if (hasFlushedMessageBlock) {
                onEvent({
                  type: "status",
                  event: eventName,
                  modelInstanceId: asStringRecord(payload).model_instance_id,
                })
              }
              pendingMessageStartPayload = null
              hasFlushedMessageBlock = false
              break
            case "model_load.progress":

            case "prompt_processing.progress":
              onEvent({
                type: "status",

                event: eventName,

                progress: asNumberRecord(payload).progress,

                modelInstanceId: asStringRecord(payload).model_instance_id,
              })

              break

            case "reasoning.delta": {
              const content = asContentRecord(payload).content

              if (typeof content === "string") {
                streamedText = appendStreamTextOrThrow(
                  streamedText,
                  content,
                  abortPrompt
                )

                onEvent({
                  type: "reasoning",

                  delta: content,
                })
              }

              break
            }

            case "message.delta": {
              const content = asContentRecord(payload).content

              if (typeof content === "string") {
                let emittedContent = content

                if (!hasFlushedMessageBlock) {
                  const trimmedLeadingContent = content.replace(/^\s+/, "")

                  if (!trimmedLeadingContent) {
                    break
                  }

                  onEvent({
                    type: "status",
                    event: "message.start",
                    modelInstanceId:
                      pendingMessageStartPayload?.model_instance_id ??
                      asStringRecord(payload).model_instance_id,
                  })

                  hasFlushedMessageBlock = true
                  emittedContent = trimmedLeadingContent
                }

                streamedText = appendStreamTextOrThrow(
                  streamedText,
                  emittedContent,
                  abortPrompt
                )

                onEvent({
                  type: "message",
                  delta: emittedContent,
                })
              }
              break
            }
            case "tool_call.start":
              streamedText = appendStreamTextOrThrow(
                streamedText,
                `${eventName}:${extractToolName(payload) ?? ""}`,
                abortPrompt
              )
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),
              })

              break

            case "tool_call.arguments":
              streamedText = appendStreamTextOrThrow(
                streamedText,
                safeJsonStringify(asObjectRecord(payload).arguments),
                abortPrompt
              )
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),

                argumentsText: safeJsonStringify(
                  asObjectRecord(payload).arguments
                ),
              })

              break

            case "tool_call.success": {
              const payloadRecord = asObjectRecord(payload)

              streamedText = appendStreamTextOrThrow(
                streamedText,
                `${safeJsonStringify(payloadRecord.arguments) ?? ""}${asStringRecord(payload).output ?? ""}`,
                abortPrompt
              )
              onEvent({
                type: "tool",

                event: eventName,

                tool: extractToolName(payload),

                provider: extractProviderLabel(payload),

                argumentsText: safeJsonStringify(payloadRecord.arguments),

                output: asStringRecord(payload).output,
              })

              break
            }

            case "tool_call.failure":
              streamedText = appendStreamTextOrThrow(
                streamedText,
                asStringRecord(payload).reason ??
                asStringRecord(asObjectRecord(payload).error).message,
                abortPrompt
              )
              onEvent({
                type: "tool",

                event: eventName,

                error:
                  asStringRecord(payload).reason ??
                  asStringRecord(asObjectRecord(payload).error).message,
              })

              break

            case "error":
              streamedText = appendStreamTextOrThrow(
                streamedText,
                asStringRecord(asObjectRecord(payload).error).message,
                abortPrompt
              )
              onEvent({
                type: "error",

                error:
                  asStringRecord(asObjectRecord(payload).error).message ??
                  "LM Studio reported a streaming error.",
              })

              break

            case "chat.end": {
              const endPayload = payload as LmStudioChatStreamEndEvent

              finalResult = extractMessageText(endPayload.result ?? {})

              finalReasoning = extractReasoningText(endPayload.result ?? {})

              break
            }

            default:
              onEvent({
                type: "status",

                event: eventName,
              })

              break
          }
        }, timeoutSignal)
      } catch (error) {
        throw normalizePromptAbortError(error)
      } finally {
        cleanup()
      }

      if (!finalResult) {
        throw new Error(
          "LM Studio returned no message content for this prompt."
        )
      }

      const result = {
        result: finalResult,

        model: selectedModel,
      }

      onEvent({
        type: "done",

        result: finalResult,

        reasoning: finalReasoning,

        model: selectedModel,
      })

      return result
    },
  }
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "")
}

function buildHeaders(apiToken: string | undefined) {
  const headers = new Headers({
    "Content-Type": "application/json",
  })

  if (apiToken) {
    headers.set("Authorization", `Bearer ${apiToken}`)
  }

  return headers
}

function buildIntegrations(options: {
  mcpServerLabel: string

  mcpServerUrl?: string
}) {
  if (!options.mcpServerUrl) {
    return undefined
  }

  return [
    {
      type: "ephemeral_mcp" as const,

      server_label: options.mcpServerLabel,

      server_url: options.mcpServerUrl,
    },
  ]
}

async function listLoadedTextModels(options: {
  baseUrl: string

  apiToken?: string

  fetchImpl: typeof fetch
}): Promise<LoadedTextModel[]> {
  const response = await requestJson<LmStudioModelsResponse>(
    options.fetchImpl,

    `${options.baseUrl}/api/v1/models`,

    {
      method: "GET",

      headers: buildHeaders(options.apiToken),
    }
  )

  return response.models

    .filter(
      (model) => model.type === "llm" && model.loaded_instances.length > 0
    )

    .map((model) => ({
      key: model.key,

      displayName: model.display_name,

      sizeBytes: model.size_bytes,

      instanceIds: model.loaded_instances.map((instance) => instance.id),
    }))
}

function pickLoadedModel(models: LoadedTextModel[], requestedModel?: string) {
  if (!requestedModel) {
    return [...models].sort((left, right) => right.sizeBytes - left.sizeBytes)[0]
  }

  const normalizedRequestedModel = requestedModel.toLowerCase()
  const matchedModel = models.find(
    (model) =>
      model.key.toLowerCase() === normalizedRequestedModel ||
      model.displayName.toLowerCase() === normalizedRequestedModel
  )

  if (!matchedModel) {
    const availableModels = models
      .map((model) => model.key)
      .sort((left, right) => left.localeCompare(right))
      .join(", ")

    throw new Error(
      `LM Studio model ${JSON.stringify(requestedModel)} is not currently loaded. Loaded models: ${availableModels || "none"}.`
    )
  }

  return matchedModel
}

function extractMessageText(response: LmStudioChatResponse) {
  return (response.output ?? [])

    .filter(isMessageOutput)

    .map((item) => item.content.trim())

    .filter(Boolean)

    .join("\n\n")
}

function extractReasoningText(response: LmStudioChatResponse) {
  return (response.output ?? [])

    .filter(isReasoningOutput)

    .map((item) => item.content.trim())

    .filter(Boolean)

    .join("\n\n")
}

function isMessageOutput(
  item: LmStudioOutputItem
): item is Extract<LmStudioOutputItem, { type: "message" }> {
  return item.type === "message" && typeof item.content === "string"
}

function isReasoningOutput(
  item: LmStudioOutputItem
): item is Extract<LmStudioOutputItem, { type: "reasoning" }> {
  return item.type === "reasoning" && typeof item.content === "string"
}

async function consumeSseStream(
  response: Response,

  onEvent: (eventName: string, payload: unknown) => void,
  signal?: AbortSignal
) {
  const decoder = new TextDecoder()

  let buffer = ""

  if (signal?.aborted) {
    throw getAbortReason(signal)
  }

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
    if (signal?.aborted) {
      throw getAbortReason(signal)
    }
    buffer += decoder.decode(chunk, { stream: true })

    buffer = buffer.replace(/\r\n/g, "\n")

    let boundaryIndex = buffer.indexOf("\n\n")

    while (boundaryIndex >= 0) {
      const rawEvent = buffer.slice(0, boundaryIndex)

      buffer = buffer.slice(boundaryIndex + 2)

      emitSseEvent(rawEvent, onEvent)

      boundaryIndex = buffer.indexOf("\n\n")
    }
  }

  buffer += decoder.decode()

  if (buffer.trim()) {
    emitSseEvent(buffer, onEvent)
  }
}

function createAbortError() {
  return new DOMException("The prompt request was cancelled.", "AbortError")
}

function getAbortReason(signal: AbortSignal) {
  if (signal.reason instanceof Error) {
    return signal.reason
  }

  return createAbortError()
}

function createTimeoutSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
) {
  const timeoutController = new AbortController()
  const timeoutId = setTimeout(() => {
    timeoutController.abort(createPromptTimeoutError(timeoutMs))
  }, timeoutMs)

  const abortFromParent = () => {
    timeoutController.abort(parentSignal?.reason ?? createAbortError())
  }

  if (parentSignal?.aborted) {
    abortFromParent()
  } else if (parentSignal) {
    parentSignal.addEventListener("abort", abortFromParent, { once: true })
  }

  return {
    signal: timeoutController.signal,
    abort(reason?: unknown) {
      timeoutController.abort(reason ?? createAbortError())
    },
    cleanup() {
      clearTimeout(timeoutId)

      if (parentSignal) {
        parentSignal.removeEventListener("abort", abortFromParent)
      }
    },
  }
}

function isRepeatedLoopSequence(streamedText: string) {
  if (streamedText.length < STREAM_LOOP_SEQUENCE_LENGTH) {
    return false
  }

  const sequence = streamedText.slice(-STREAM_LOOP_SEQUENCE_LENGTH)
  const lookbackStart = Math.max(
    0,
    streamedText.length -
    STREAM_LOOP_SEQUENCE_LENGTH -
    STREAM_LOOP_LOOKBACK_LENGTH
  )
  const priorWindow = streamedText.slice(
    lookbackStart,
    streamedText.length - STREAM_LOOP_SEQUENCE_LENGTH
  )

  return (
    countSubstringOccurrences(priorWindow, sequence) >=
    STREAM_LOOP_REPEAT_THRESHOLD
  )
}

function countSubstringOccurrences(haystack: string, needle: string) {
  if (!needle) {
    return 0
  }

  let count = 0
  let searchStart = 0

  while (searchStart <= haystack.length - needle.length) {
    const matchIndex = haystack.indexOf(needle, searchStart)

    if (matchIndex < 0) {
      return count
    }

    count += 1
    searchStart = matchIndex + 1
  }

  return count
}

function appendStreamTextOrThrow(
  streamedText: string,
  chunk: string | undefined,
  abortPrompt: (reason?: unknown) => void
) {
  if (!chunk) {
    return streamedText
  }

  const nextStreamedText = streamedText + chunk

  if (isRepeatedLoopSequence(nextStreamedText)) {
    abortPrompt(new Error(STREAM_LOOP_ERROR_MESSAGE))
    throw new Error(STREAM_LOOP_ERROR_MESSAGE)
  }

  return nextStreamedText
}

function createPromptTimeoutError(timeoutMs: number) {
  return new Error(
    `LM Studio prompt request timed out after ${Math.floor(timeoutMs / 60000)} minutes.`
  )
}

function normalizePromptAbortError(error: unknown) {
  if (error instanceof Error) {
    if (
      error.name === "AbortError" &&
      error.message === "The prompt request was cancelled."
    ) {
      return error
    }

    if (
      error.name === "TimeoutError" ||
      error.message.includes("timed out after")
    ) {
      return createPromptTimeoutError(LM_STUDIO_PROMPT_TIMEOUT_MS)
    }
  }

  return error
}

function emitSseEvent(
  rawEvent: string,

  onEvent: (eventName: string, payload: unknown) => void
) {
  const lines = rawEvent

    .split("\n")

    .map((line) => line.trimEnd())

    .filter(Boolean)

  let eventName = "message"

  const dataLines: string[] = []

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim()

      continue
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart())
    }
  }

  if (!dataLines.length) {
    return
  }

  const payloadText = dataLines.join("\n")

  const payload = JSON.parse(payloadText) as unknown

  onEvent(eventName, payload)
}

function asObjectRecord(value: unknown) {
  if (!value || typeof value !== "object") {
    return {}
  }

  return value as Record<string, unknown>
}


function asStringRecord(value: unknown) {
  return asObjectRecord(value) as Record<string, string | undefined>
}

function asNumberRecord(value: unknown) {
  return asObjectRecord(value) as Record<string, number | undefined>
}

function asContentRecord(value: unknown) {
  return asObjectRecord(value) as { content?: string }
}

function extractProviderLabel(value: unknown) {
  const providerInfo = asObjectRecord(asObjectRecord(value).provider_info)

  if (typeof providerInfo.server_label === "string") {
    return providerInfo.server_label
  }

  if (typeof providerInfo.plugin_id === "string") {
    return providerInfo.plugin_id
  }

  return undefined
}

function extractToolName(value: unknown) {
  const payload = asObjectRecord(value)

  const functionRecord = asObjectRecord(payload.function)

  if (typeof payload.tool === "string") {
    return payload.tool
  }

  if (typeof payload.tool_name === "string") {
    return payload.tool_name
  }

  if (typeof payload.name === "string") {
    return payload.name
  }

  if (typeof functionRecord.name === "string") {
    return functionRecord.name
  }

  return undefined
}

function safeJsonStringify(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return undefined
  }
}

async function requestJson<T>(
  fetchImpl: typeof fetch,

  input: string,

  init: RequestInit
): Promise<T> {
  const response = await fetchImpl(input, init)

  if (!response.ok) {
    throw new Error(await buildErrorMessage(response))
  }

  return (await response.json()) as T
}

async function buildErrorMessage(response: Response) {
  const contentType = response.headers.get("content-type") ?? ""

  if (contentType.includes("application/json")) {
    const payload = (await response.json()) as {
      error?: string

      message?: string
    }

    if (payload.error || payload.message) {
      return (
        payload.error ??
        payload.message ??
        `LM Studio request failed with ${response.status}.`
      )
    }
  }

  const bodyText = (await response.text()).trim()

  if (bodyText) {
    return bodyText
  }

  return `LM Studio request failed with ${response.status}.`
}





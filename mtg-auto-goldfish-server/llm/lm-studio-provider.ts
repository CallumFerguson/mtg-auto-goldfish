import type {
  LoadedTextModel,
  PromptProcessingResult,
  PromptProcessor,
  PromptStreamEvent,
} from "./index.js"

export const LM_STUDIO_DEFAULT_BASE_URL = "http://127.0.0.1:1234"

export type PromptProcessorOptions = {
  baseUrl?: string

  apiToken?: string

  fetchImpl?: typeof fetch

  mcpServerUrl?: string

  mcpServerLabel?: string
}

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

  const apiToken = options.apiToken?.trim() || undefined

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

      const selectedModel = pickLargestLoadedModel(loadedModels)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      const chatResponse = await requestJson<LmStudioChatResponse>(
        fetchImpl,

        `${baseUrl}/api/v1/chat`,

        {
          method: "POST",

          headers: buildHeaders(apiToken),

          body: JSON.stringify({
            model: selectedModel.key,

            input: prompt,

            integrations: buildIntegrations({
              mcpServerLabel,

              mcpServerUrl,
            }),

            temperature: 0,

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
    },

    async processPromptStream(
      prompt: string,

      onEvent: (event: PromptStreamEvent) => void
    ): Promise<PromptProcessingResult> {
      const loadedModels = await listLoadedTextModels({
        apiToken,

        baseUrl,

        fetchImpl,
      })

      const selectedModel = pickLargestLoadedModel(loadedModels)

      if (!selectedModel) {
        throw new Error(
          "LM Studio has no loaded LLMs available. Load a model in LM Studio and try again."
        )
      }

      onEvent({
        type: "start",

        model: selectedModel,
      })

      const response = await fetchImpl(`${baseUrl}/api/v1/chat`, {
        method: "POST",

        headers: buildHeaders(apiToken),

        body: JSON.stringify({
          model: selectedModel.key,

          input: prompt,

          integrations: buildIntegrations({
            mcpServerLabel,

            mcpServerUrl,
          }),

          temperature: 0,

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

      let finalResult = ""

      let finalReasoning = ""
      let pendingMessageStartPayload: Record<
        string,
        string | undefined
      > | null = null
      let pendingMessageWhitespace = ""
      let hasFlushedMessageBlock = false

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
            pendingMessageWhitespace = ""
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
            pendingMessageWhitespace = ""
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
              if (!hasFlushedMessageBlock) {
                if (!content.trim()) {
                  pendingMessageWhitespace += content
                  break
                }

                onEvent({
                  type: "status",
                  event: "message.start",
                  modelInstanceId:
                    pendingMessageStartPayload?.model_instance_id ??
                    asStringRecord(payload).model_instance_id,
                })

                if (pendingMessageWhitespace) {
                  onEvent({
                    type: "message",
                    delta: pendingMessageWhitespace,
                  })
                  pendingMessageWhitespace = ""
                }

                hasFlushedMessageBlock = true
              }

              onEvent({
                type: "message",
                delta: content,
              })
            }
            break
          }

          case "tool_call.start":
            onEvent({
              type: "tool",

              event: eventName,

              tool: extractToolName(payload),

              provider: extractProviderLabel(payload),
            })

            break

          case "tool_call.arguments":
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

          case "tool_call.success":
            onEvent({
              type: "tool",

              event: eventName,

              tool: extractToolName(payload),

              provider: extractProviderLabel(payload),

              argumentsText: safeJsonStringify(
                asObjectRecord(payload).arguments
              ),

              output: asStringRecord(payload).output,
            })

            break

          case "tool_call.failure":
            onEvent({
              type: "tool",

              event: eventName,

              error:
                asStringRecord(payload).reason ??
                asStringRecord(asObjectRecord(payload).error).message,
            })

            break

          case "error":
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
      })

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

function pickLargestLoadedModel(models: LoadedTextModel[]) {
  return [...models].sort((left, right) => right.sizeBytes - left.sizeBytes)[0]
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

  onEvent: (eventName: string, payload: unknown) => void
) {
  const decoder = new TextDecoder()

  let buffer = ""

  for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
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

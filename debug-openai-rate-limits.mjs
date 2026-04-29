import "dotenv/config"

import OpenAI from "openai"

let DEFAULT_PROMPT =
  "I'm testing a problem with token usage and mcp function calling. call the echo mcp function 30 times. ignore the following lorem ipsum text. "

for (let i = 0; i < 5000; i += 1) {
  DEFAULT_PROMPT += "lorem ipsum "
}

const RATE_LIMIT_HEADER_PREFIXES = [
  "x-ratelimit-",
  "x-request-id",
  "retry-after",
  "openai-",
]

function getRequiredEnv(name) {
  const value = process.env[name]?.trim()

  if (!value) {
    throw new Error(
      `Missing ${name}. Add it to your repo-root .env file or set it in this terminal session.`
    )
  }

  return value
}

function getOptionalEnv(name) {
  const value = process.env[name]?.trim()
  return value ? value : null
}

function headersToObject(headers) {
  if (!headers) {
    return {}
  }

  if (typeof headers.entries === "function") {
    return Object.fromEntries(headers.entries())
  }

  return { ...headers }
}

function pickDebugHeaders(headers) {
  const headerObject = headersToObject(headers)
  const picked = {}

  for (const [name, value] of Object.entries(headerObject)) {
    const normalizedName = name.toLowerCase()

    if (
      RATE_LIMIT_HEADER_PREFIXES.some((prefix) =>
        normalizedName.startsWith(prefix)
      )
    ) {
      picked[name] = value
    }
  }

  return picked
}

function logJson(label, value) {
  console.log(`\n${label}`)
  console.log(JSON.stringify(value, null, 2))
}

function isRecord(value) {
  return typeof value === "object" && value !== null
}

function compactMcpEvent(event) {
  return {
    type: event.type,
    item_id: event.item_id ?? event.item?.id ?? undefined,
    output_index: event.output_index ?? undefined,
    name: event.name ?? event.item?.name ?? undefined,
    server_label: event.server_label ?? event.item?.server_label ?? undefined,
    arguments: event.arguments ?? event.item?.arguments ?? undefined,
    error: event.error ?? event.item?.error ?? undefined,
    output: event.output ?? event.item?.output ?? undefined,
  }
}

function buildRequestPayload({
  model,
  prompt,
  reasoningEffort,
  openingHandMcpPublicUrl,
}) {
  const payload = {
    model,
    input: prompt,
    stream: true,
    max_output_tokens: 100000,
    metadata: {
      purpose: "rate_limit_debug",
    },
    tools: [
      {
        type: "mcp",
        server_label: "opening_hand",
        server_description:
          "Tools for drawing, mulliganing, and finalizing a Magic: The Gathering opening hand simulation.",
        server_url: openingHandMcpPublicUrl,
        require_approval: "never",
      },
    ],
  }

  if (reasoningEffort && reasoningEffort !== "none") {
    payload.reasoning = {
      effort: reasoningEffort,
      summary: "auto",
    }
  }

  return payload
}

async function main() {
  const apiKey = getRequiredEnv("OPENAI_API_KEY")
  const model = getRequiredEnv("OPENAI_MODEL")
  const reasoningEffort = getOptionalEnv("OPENAI_REASONING_EFFORT")
  const openingHandMcpPublicUrl = getRequiredEnv("OPENING_HAND_MCP_PUBLIC_URL")
  const prompt = process.argv.slice(2).join(" ").trim() || DEFAULT_PROMPT
  const client = new OpenAI({ apiKey })
  const payload = buildRequestPayload({
    model,
    prompt,
    reasoningEffort,
    openingHandMcpPublicUrl,
  })
  const startedAt = Date.now()

  logJson("Request", {
    ...payload,
    input: prompt,
    apiKey: "[redacted]",
  })

  const request = client.responses.create(payload)
  const { data: stream, response, request_id: requestId } =
    await request.withResponse()

  console.log(`\nHTTP status: ${response.status} ${response.statusText}`)
  console.log(`OpenAI request id: ${requestId ?? "(missing)"}`)
  logJson("All response headers", headersToObject(response.headers))

  const rateLimitHeaders = pickDebugHeaders(response.headers)
  let completedResponse = null
  let usage = null
  let outputText = ""
  let reasoningSummaryText = ""
  const eventCounts = new Map()

  console.log("\nStream events")

  for await (const event of stream) {
    const eventType = isRecord(event) ? event.type : "unknown"
    eventCounts.set(eventType, (eventCounts.get(eventType) ?? 0) + 1)

    if (eventType === "response.output_text.delta") {
      const delta = event.delta ?? ""
      outputText += delta
      process.stdout.write(delta)
      continue
    }

    if (
      eventType === "response.reasoning_summary_text.delta" ||
      eventType === "response.reasoning_summary.delta"
    ) {
      const delta = event.delta ?? ""
      reasoningSummaryText += delta
      process.stdout.write(delta)
      continue
    }

    if (
      eventType === "response.reasoning_summary_part.added" ||
      eventType === "response.reasoning_summary_text.done" ||
      eventType === "response.reasoning_summary_part.done" ||
      eventType === "response.reasoning_summary.done"
    ) {
      logJson(`[${eventType}]`, event)
      continue
    }

    if (typeof eventType === "string" && eventType.includes(".mcp_")) {
      logJson(`[${eventType}]`, compactMcpEvent(event))
      continue
    }

    if (eventType === "response.completed") {
      completedResponse = event.response ?? null
      usage = completedResponse?.usage ?? null
      outputText = completedResponse?.output_text || outputText
      console.log("\n[response.completed]")
      continue
    }

    if (
      eventType === "response.failed" ||
      eventType === "response.incomplete" ||
      eventType === "error"
    ) {
      logJson(`[${eventType}]`, event)
    }
  }

  const elapsedMs = Date.now() - startedAt

  if (completedResponse?.status && completedResponse.status !== "completed") {
    logJson("Non-completed response status", {
      status: completedResponse.status,
      incomplete_details: completedResponse.incomplete_details ?? null,
      error: completedResponse.error ?? null,
    })
  }

  logJson("Event counts", Object.fromEntries(eventCounts.entries()))
  logJson("Usage", usage)
  logJson("Completed response", completedResponse)
  console.log(`\nReasoning summary text: ${reasoningSummaryText || "(empty)"}`)
  console.log(`\nOutput text: ${outputText || "(empty)"}`)
  console.log(`Elapsed: ${elapsedMs}ms`)
  logJson("Summary: rate-limit and request headers", rateLimitHeaders)
  logJson("Summary: token usage", usage)
}

main().catch((error) => {
  console.error("\nRequest failed")
  console.error(`${error.name ?? "Error"}: ${error.message}`)

  if (error.status) {
    console.error(`Status: ${error.status}`)
  }

  if (error.request_id) {
    console.error(`OpenAI request id: ${error.request_id}`)
  }

  const headers = error.headers ?? error.response?.headers

  if (headers) {
    logJson("Rate-limit and request headers", pickDebugHeaders(headers))
    logJson("All error headers", headersToObject(headers))
  }

  if (error.error) {
    logJson("OpenAI error body", error.error)
  } else if (error.body) {
    logJson("OpenAI error body", error.body)
  }

  process.exitCode = 1
})

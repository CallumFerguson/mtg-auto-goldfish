import { createClaudePromptProcessor } from "./claude-provider.js"
import { createGeminiPromptProcessor } from "./gemini-provider.js"
import { createLmStudioPromptProcessor } from "./lm-studio-provider.js"
import { createOpenAiPromptProcessor } from "./openai-provider.js"

export type PromptProcessorProvider = "lm-studio" | "openai" | "claude" | "gemini"

export type PromptProcessorOptions = {
  provider?: PromptProcessorProvider | string
  baseUrl?: string
  apiToken?: string
  apiKey?: string
  model?: string
  maxOutputTokens?: number
  reasoningEffort?: string
  reasoningSummary?: string
  fetchImpl?: typeof fetch
  mcpServerUrl?: string
  mcpServerLabel?: string
}

export type LoadedTextModel = {
  key: string
  displayName: string
  sizeBytes: number
  instanceIds: string[]
}

export type PromptTokenUsage = {
  inputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  totalTokens?: number
}

export type PromptProcessingResult = {
  result: string
  provider: PromptProcessorProvider
  model: LoadedTextModel
  usage?: PromptTokenUsage
  durationMs: number
}

export type PromptStreamEvent =
  | {
      type: "start"
      model: LoadedTextModel
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
      model: LoadedTextModel
    }

export interface PromptProcessor {
  processPrompt(prompt: string): Promise<PromptProcessingResult>
  processPromptStream(
    prompt: string,
    onEvent: (event: PromptStreamEvent) => void,
    signal?: AbortSignal
  ): Promise<PromptProcessingResult>
}

export function createPromptProcessor(
  options: PromptProcessorOptions = {}
): PromptProcessor {
  switch (normalizePromptProcessorProvider(options.provider)) {
    case "openai":
      return createOpenAiPromptProcessor(options)
    case "claude":
      return createClaudePromptProcessor(options)
    case "gemini":
      return createGeminiPromptProcessor(options)
    case "lm-studio":
    default:
      return createLmStudioPromptProcessor(options)
  }
}

export function normalizePromptProcessorProvider(
  rawProvider: PromptProcessorOptions["provider"]
): PromptProcessorProvider {
  const normalizedProvider = rawProvider?.trim().toLowerCase()

  switch (normalizedProvider) {
    case "openai":
      return "openai"
    case "anthropic":
    case "claude":
      return "claude"
    case "google":
    case "google-gemini":
    case "gemini":
      return "gemini"
    case "lmstudio":
    case "lm-studio":
    case "local":
    case undefined:
    case "":
      return "lm-studio"
    default:
      throw new Error(
        `Unsupported LLM_PROVIDER value: ${rawProvider}. Expected lm-studio, openai, claude, or gemini.`
      )
  }
}



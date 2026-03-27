import {
  type PromptProcessorOptions,
  createLmStudioPromptProcessor,
} from "./lm-studio-provider.js"

export type LoadedTextModel = {
  key: string
  displayName: string
  sizeBytes: number
  instanceIds: string[]
}

export type PromptProcessingResult = {
  result: string
  model: LoadedTextModel
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
  return createLmStudioPromptProcessor(options)
}


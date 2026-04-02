import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { Check, Copy, LoaderCircle, Sparkles, Square, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { PromptStreamEvent } from "@/features/deck-intake/lib/simulation-session"

type CustomPromptTestModalProps = {
  isOpen: boolean
  serverUrl: string
  onClose: () => void
}

function formatRawStreamChunk(event: PromptStreamEvent) {
  if (event.type === "reasoning" || event.type === "message") {
    return event.delta
  }

  if (event.type === "done") {
    return ""
  }

  return `${JSON.stringify(event)}\n`
}

export function CustomPromptTestModal({
  isOpen,
  serverUrl,
  onClose,
}: CustomPromptTestModalProps) {
  const abortControllerRef = useRef<AbortController | null>(null)
  const resultScrollRef = useRef<HTMLDivElement | null>(null)
  const rawScrollRef = useRef<HTMLDivElement | null>(null)
  const [promptText, setPromptText] = useState("")
  const [resultText, setResultText] = useState("")
  const [rawStreamText, setRawStreamText] = useState("")
  const [errorMessage, setErrorMessage] = useState("")
  const [isRunning, setIsRunning] = useState(false)
  const [copyState, setCopyState] = useState<
    "idle" | "result-copied" | "raw-copied" | "copy-error"
  >("idle")

  useEffect(() => {
    if (!isOpen) {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      setIsRunning(false)
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        abortControllerRef.current?.abort()
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => {
      abortControllerRef.current?.abort()
      abortControllerRef.current = null
      setIsRunning(false)
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen, onClose])

  useEffect(() => {
    if (copyState === "idle") {
      return
    }

    const timeoutId = window.setTimeout(() => {
      setCopyState("idle")
    }, 1800)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [copyState])

  useLayoutEffect(() => {
    if (!isOpen) {
      return
    }

    if (resultScrollRef.current) {
      resultScrollRef.current.scrollTop = resultScrollRef.current.scrollHeight
    }

    if (rawScrollRef.current) {
      rawScrollRef.current.scrollTop = rawScrollRef.current.scrollHeight
    }
  }, [isOpen, resultText, rawStreamText])

  async function handleCopy(text: string, nextState: "result-copied" | "raw-copied") {
    try {
      await navigator.clipboard.writeText(text || "No output yet.")
      setCopyState(nextState)
    } catch {
      setCopyState("copy-error")
    }
  }

  function handleStop() {
    abortControllerRef.current?.abort()
    abortControllerRef.current = null
    setIsRunning(false)
  }

  async function handleRunPrompt() {
    const prompt = promptText.trim()

    if (!prompt || isRunning) {
      return
    }

    abortControllerRef.current?.abort()
    const abortController = new AbortController()
    abortControllerRef.current = abortController

    setIsRunning(true)
    setErrorMessage("")
    setResultText("")
    setRawStreamText("")

    try {
      const response = await fetch(`${serverUrl}/process-prompt`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        const payload = (await response.json()) as
          | { error?: string }
          | { details?: Array<{ message?: string }> }
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
            "Failed to process the custom prompt."
        )
      }

      if (!response.body) {
        throw new Error("The server response did not include a stream body.")
      }

      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      let finalText = ""

      while (true) {
        const { done, value } = await reader.read()

        if (abortController.signal.aborted) {
          throw new DOMException("Prompt cancelled.", "AbortError")
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

          const event = JSON.parse(trimmedLine) as PromptStreamEvent
          const rawChunk = formatRawStreamChunk(event)

          if (rawChunk) {
            setRawStreamText((current) => `${current}${rawChunk}`)
          }

          if (event.type === "message") {
            finalText += event.delta
            setResultText(finalText)
          }

          if (event.type === "done") {
            finalText = event.result
            setResultText(event.result)
          }

          if (event.type === "error") {
            throw new Error(event.error)
          }
        }
      }

      const trailing = `${buffer}${decoder.decode()}`.trim()

      if (trailing) {
        const event = JSON.parse(trailing) as PromptStreamEvent
        const rawChunk = formatRawStreamChunk(event)

        if (rawChunk) {
          setRawStreamText((current) => `${current}${rawChunk}`)
        }

        if (event.type === "message") {
          finalText += event.delta
          setResultText(finalText)
        }

        if (event.type === "done") {
          setResultText(event.result)
        }

        if (event.type === "error") {
          throw new Error(event.error)
        }
      }
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        setErrorMessage("Prompt cancelled.")
      } else {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : "Failed to process the custom prompt."
        )
      }
    } finally {
      if (abortControllerRef.current === abortController) {
        abortControllerRef.current = null
      }

      setIsRunning(false)
    }
  }

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto bg-black/75 px-4 py-6 backdrop-blur-sm sm:items-center sm:justify-center"
      onClick={() => {
        abortControllerRef.current?.abort()
        onClose()
      }}
      role="presentation"
    >
      <div
        className="my-auto flex max-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-fuchsia-300/15 bg-[linear-gradient(180deg,rgba(25,12,34,0.98)_0%,rgba(12,10,9,0.98)_100%)] shadow-[0_30px_120px_rgba(0,0,0,0.7)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-prompt-test-modal-title"
      >
        <div className="shrink-0 border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(217,70,239,0.18),transparent_55%)] p-5 sm:p-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-fuchsia-300/20 bg-fuchsia-400/10 text-fuchsia-200">
                <Sparkles className="size-5" />
              </div>
              <h3
                id="custom-prompt-test-modal-title"
                className="text-xl font-semibold tracking-tight text-stone-50"
              >
                Custom prompt test
              </h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-300">
                Run an arbitrary prompt through the current `process-prompt`
                pipeline and inspect the live output. This stays separate from
                the deck, game, and simulation session state.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-white/15 bg-white/5 px-4 text-stone-200 hover:bg-white/10 hover:text-stone-50"
                onClick={() => {
                  setResultText("")
                  setRawStreamText("")
                  setErrorMessage("")
                }}
                disabled={isRunning}
              >
                <X />
                Clear output
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-white/15 bg-white/5 px-4 text-stone-200 hover:bg-white/10 hover:text-stone-50"
                onClick={() => {
                  abortControllerRef.current?.abort()
                  onClose()
                }}
              >
                <X />
                Close
              </Button>
            </div>
          </div>
        </div>

        <div className="app-scrollbar min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="flex min-h-full flex-col gap-5">
          <section className="space-y-4 rounded-[24px] border border-white/10 bg-black/20 p-4 sm:p-5">
            <div className="space-y-2">
              <label
                htmlFor="custom-prompt-test-input"
                className="text-xs font-medium tracking-[0.16em] text-stone-400 uppercase"
              >
                Prompt input
              </label>
              <textarea
                id="custom-prompt-test-input"
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                placeholder="Write a prompt to test the current model pipeline..."
                className="app-scrollbar min-h-[180px] w-full resize-y rounded-[24px] border border-white/10 bg-black/35 px-4 py-3 text-sm leading-6 text-stone-100 outline-none transition placeholder:text-stone-500 focus:border-fuchsia-300/35 focus:bg-black/45 sm:min-h-[220px]"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                className="h-11 rounded-full bg-fuchsia-500 px-5 text-stone-950 hover:bg-fuchsia-400 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-400"
                disabled={!promptText.trim() || isRunning}
                onClick={() => {
                  void handleRunPrompt()
                }}
              >
                {isRunning ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Running prompt
                  </>
                ) : (
                  <>
                    <Sparkles />
                    Run custom prompt
                  </>
                )}
              </Button>

              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-full border-red-400/30 bg-red-500/10 px-5 text-red-100 hover:bg-red-500/20 hover:text-red-50 disabled:border-white/10 disabled:bg-stone-900 disabled:text-stone-500"
                disabled={!isRunning}
                onClick={handleStop}
              >
                <Square className="fill-current" />
                Stop
              </Button>
            </div>

            {errorMessage ? (
              <div className="rounded-[20px] border border-red-400/25 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-100">
                {errorMessage}
              </div>
            ) : null}
          </section>

          <section className="flex min-h-[280px] flex-col rounded-[24px] border border-white/10 bg-black/28 p-4">
            <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-100">
                  Streamed result
                </p>
                <p className="text-xs leading-5 text-stone-400">
                  Live assembled output from `message` and `done` events.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 self-start rounded-full border-sky-300/20 bg-sky-400/10 px-3 text-sky-100 hover:bg-sky-400/15 hover:text-sky-50"
                onClick={() => {
                  void handleCopy(resultText, "result-copied")
                }}
              >
                {copyState === "result-copied" ? <Check /> : <Copy />}
                {copyState === "result-copied"
                  ? "Copied"
                  : copyState === "copy-error"
                    ? "Copy failed"
                    : "Copy result"}
              </Button>
            </div>
            <div
              ref={resultScrollRef}
              className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-white/10 bg-black/35 p-4"
            >
              <pre className="font-mono text-xs leading-6 break-words whitespace-pre-wrap text-stone-200">
                {resultText || "No streamed result yet."}
              </pre>
            </div>
          </section>

          <section className="flex min-h-[320px] flex-col rounded-[24px] border border-white/10 bg-black/28 p-4">
            <div className="mb-3 flex flex-col items-start gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium text-stone-100">
                  Raw stream
                </p>
                <p className="text-xs leading-5 text-stone-400">
                  Newline-delimited events returned directly by the server.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 self-start rounded-full border-cyan-300/20 bg-cyan-400/10 px-3 text-cyan-100 hover:bg-cyan-400/15 hover:text-cyan-50"
                onClick={() => {
                  void handleCopy(rawStreamText, "raw-copied")
                }}
              >
                {copyState === "raw-copied" ? <Check /> : <Copy />}
                {copyState === "raw-copied"
                  ? "Copied"
                  : copyState === "copy-error"
                    ? "Copy failed"
                    : "Copy raw"}
              </Button>
            </div>
            <div
              ref={rawScrollRef}
              className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-[20px] border border-white/10 bg-black/35 p-4"
            >
              <pre className="font-mono text-xs leading-6 break-words whitespace-pre-wrap text-stone-300">
                {rawStreamText || "No raw stream yet."}
              </pre>
            </div>
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

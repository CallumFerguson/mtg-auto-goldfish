import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Check, Copy, Eye, LoaderCircle, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import type { SimulationPromptRun } from "@/features/deck-intake/lib/simulation-session"

type PromptStreamModalProps = {
  isOpen: boolean
  promptRuns: SimulationPromptRun[]
  isStarting: boolean
  onClose: () => void
}

export function PromptStreamModal({
  isOpen,
  promptRuns,
  isStarting,
  onClose,
}: PromptStreamModalProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const streamContentRef = useRef<HTMLPreElement | null>(null)
  const isNearBottomRef = useRef(true)
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const [copyState, setCopyState] = useState<
    "idle" | "stream-copied" | "all-copied" | "stream-error" | "all-error"
  >("idle")

  const selectedRun = useMemo(() => {
    if (!promptRuns.length) {
      return null
    }

    return (
      promptRuns.find((run) => run.id === selectedRunId) ??
      promptRuns[promptRuns.length - 1]
    )
  }, [promptRuns, selectedRunId])

  const streamText = selectedRun?.rawPromptStream.trim() || "No prompt stream yet."
  const allStreamsText = useMemo(
    () =>
      promptRuns
        .map(
          (run) =>
            `=== ${run.title} ===\n${run.rawPromptStream.trim() || "No prompt stream yet."}`
        )
        .join("\n\n"),
    [promptRuns]
  )

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

  async function handleCopyPromptStream() {
    try {
      await navigator.clipboard.writeText(streamText)
      setCopyState("stream-copied")
    } catch {
      setCopyState("stream-error")
    }
  }

  async function handleCopyAllPromptStreams() {
    try {
      await navigator.clipboard.writeText(allStreamsText || "No prompt stream yet.")
      setCopyState("all-copied")
    } catch {
      setCopyState("all-error")
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose()
      }
    }

    window.addEventListener("keydown", handleKeyDown)

    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen, onClose])

  useEffect(() => {
    if (!promptRuns.length) {
      setSelectedRunId(null)
      return
    }

    if (
      selectedRunId &&
      promptRuns.some((run) => run.id === selectedRunId)
    ) {
      return
    }

    setSelectedRunId(promptRuns[promptRuns.length - 1].id)
  }, [promptRuns, selectedRunId])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const scrollContainer = scrollContainerRef.current

    if (!scrollContainer) {
      return
    }

    const currentScrollContainer = scrollContainer

    function updateIsNearBottom() {
      const distanceToBottom =
        currentScrollContainer.scrollHeight -
        currentScrollContainer.scrollTop -
        currentScrollContainer.clientHeight

      isNearBottomRef.current = distanceToBottom <= 100
    }

    updateIsNearBottom()
    currentScrollContainer.addEventListener("scroll", updateIsNearBottom, {
      passive: true,
    })

    return () => {
      currentScrollContainer.removeEventListener("scroll", updateIsNearBottom)
    }
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) {
      return
    }

    const scrollContainer = scrollContainerRef.current

    if (!scrollContainer) {
      return
    }

    scrollContainer.scrollTop = scrollContainer.scrollHeight
    isNearBottomRef.current = true
  }, [isOpen])

  useLayoutEffect(() => {
    if (!isOpen) {
      return
    }

    const scrollContainer = scrollContainerRef.current

    if (!scrollContainer || !isNearBottomRef.current) {
      return
    }

    scrollContainer.scrollTop = scrollContainer.scrollHeight
  }, [isOpen, selectedRunId])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    const scrollContainer = scrollContainerRef.current
    const streamContent = streamContentRef.current

    if (!scrollContainer || !streamContent) {
      return
    }

    let previousHeight = scrollContainer.scrollHeight

    const observer = new ResizeObserver(() => {
      const nextHeight = scrollContainer.scrollHeight

      if (nextHeight === previousHeight) {
        return
      }

      previousHeight = nextHeight

      if (!isNearBottomRef.current) {
        return
      }

      scrollContainer.scrollTop = nextHeight
    })

    observer.observe(streamContent)

    return () => {
      observer.disconnect()
    }
  }, [isOpen, streamText])

  if (!isOpen) {
    return null
  }

  return (
    <div
      className="fixed inset-0 z-50 flex overflow-y-auto bg-black/70 px-4 py-6 backdrop-blur-sm sm:items-center sm:justify-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="my-auto flex max-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col overflow-hidden rounded-[28px] border border-sky-300/15 bg-[linear-gradient(180deg,rgba(15,23,42,0.98)_0%,rgba(12,10,9,0.97)_100%)] shadow-[0_30px_120px_rgba(0,0,0,0.65)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="prompt-stream-modal-title"
      >
        <div className="shrink-0 border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.15),transparent_55%)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-sky-300/20 bg-sky-400/10 text-sky-200">
                <Eye className="size-5" />
              </div>
              <h3
                id="prompt-stream-modal-title"
                className="text-xl font-semibold tracking-tight text-stone-50"
              >
                Full prompt stream
              </h3>
              <p className="mt-2 text-sm leading-6 text-stone-300">
                This is the raw live stream coming back through the configured prompt pipeline, separated by prompt run.
              </p>
            </div>

            <div className="flex shrink-0 flex-wrap items-center gap-3">
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-sky-300/20 bg-sky-400/10 px-4 text-sky-100 hover:bg-sky-400/15 hover:text-sky-50"
                onClick={() => {
                  void handleCopyPromptStream()
                }}
              >
                {copyState === "stream-copied" ? <Check /> : <Copy />}
                {copyState === "stream-copied"
                  ? "Copied"
                  : copyState === "stream-error"
                    ? "Copy failed"
                    : "Copy stream"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-cyan-300/20 bg-cyan-400/10 px-4 text-cyan-100 hover:bg-cyan-400/15 hover:text-cyan-50"
                onClick={() => {
                  void handleCopyAllPromptStreams()
                }}
              >
                {copyState === "all-copied" ? <Check /> : <Copy />}
                {copyState === "all-copied"
                  ? "Copied all"
                  : copyState === "all-error"
                    ? "Copy failed"
                    : "Copy all"}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-10 rounded-full border-white/15 bg-white/5 px-4 text-stone-200 hover:bg-white/10 hover:text-stone-50"
                onClick={onClose}
              >
                <X />
                Close
              </Button>
            </div>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-6">
          {promptRuns.length ? (
            <div className="mb-4 flex shrink-0 gap-2 overflow-x-auto pb-1">
              {promptRuns.map((run, index) => {
                const isSelected = run.id === selectedRun?.id

                return (
                  <button
                    key={run.id}
                    type="button"
                    className={`shrink-0 rounded-full border px-4 py-2 text-left text-xs transition ${
                      isSelected
                        ? "border-sky-300/40 bg-sky-400/15 text-sky-100"
                        : "border-white/10 bg-white/5 text-stone-300 hover:border-white/20 hover:bg-white/10 hover:text-stone-100"
                    }`}
                    onClick={() => setSelectedRunId(run.id)}
                    aria-pressed={isSelected}
                  >
                    <span className="block font-medium">{run.title}</span>
                    <span className="mt-1 block text-[11px] uppercase tracking-[0.16em] text-inherit/70">
                      Run {index + 1}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : null}

          <div
            ref={scrollContainerRef}
            className="app-scrollbar min-h-0 flex-1 overflow-y-auto rounded-[24px] border border-white/10 bg-black/35 p-4 pr-3"
          >
            <pre
              ref={streamContentRef}
              className="font-mono text-xs leading-6 break-words whitespace-pre-wrap text-stone-200"
            >
              {streamText}
            </pre>
          </div>

          {isStarting && selectedRun?.status === "running" ? (
            <div className="mt-4 flex items-center gap-2 text-sm text-stone-400">
              <LoaderCircle className="size-4 animate-spin text-amber-200" />
              Prompt stream is still running.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}



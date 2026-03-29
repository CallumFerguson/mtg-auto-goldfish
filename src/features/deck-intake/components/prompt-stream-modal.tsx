import { useEffect, useLayoutEffect, useRef } from "react"
import { Eye, LoaderCircle, X, XCircle } from "lucide-react"

import { Button } from "@/components/ui/button"

type PromptStreamModalProps = {
  isOpen: boolean
  streamText: string
  isStarting: boolean
  onCancel: () => void
  onClose: () => void
}

export function PromptStreamModal({
  isOpen,
  streamText,
  isStarting,
  onCancel,
  onClose,
}: PromptStreamModalProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  const streamContentRef = useRef<HTMLPreElement | null>(null)
  const isNearBottomRef = useRef(true)

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
  }, [isOpen, streamText])

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
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.15),transparent_55%)] p-6">
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
                This is the raw live stream coming back through the configured prompt pipeline.
              </p>
            </div>

            <div className="flex items-center gap-3">
              {isStarting ? (
                <Button
                  type="button"
                  variant="outline"
                  className="h-10 rounded-full border-red-400/30 bg-red-500/10 px-4 text-red-100 hover:bg-red-500/20 hover:text-red-50"
                  onClick={onCancel}
                >
                  <XCircle />
                  Cancel run
                </Button>
              ) : null}

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

        <div className="min-h-0 flex-1 overflow-hidden p-6">
          <div
            ref={scrollContainerRef}
            className="app-scrollbar max-h-[min(70vh,48rem)] overflow-y-scroll rounded-[24px] border border-white/10 bg-black/35 p-4 pr-3"
          >
            <pre
              ref={streamContentRef}
              className="font-mono text-xs leading-6 break-words whitespace-pre-wrap text-stone-200"
            >
              {streamText.trim() || "No prompt stream yet."}
            </pre>
          </div>

          {isStarting ? (
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



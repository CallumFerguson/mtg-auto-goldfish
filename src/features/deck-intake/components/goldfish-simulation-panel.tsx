import {
  CheckCircle2,
  ChevronDown,
  Eye,
  LoaderCircle,
  Play,
  Sparkles,
  XCircle,
} from "lucide-react"
import { useEffect, useRef } from "react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { GoldfishAnswerMarkdown } from "@/features/deck-intake/components/goldfish-answer-markdown"

type SimulationActivity = {
  id: string
  kind: "thinking" | "tool"
  title: string
  detail?: ReactNode
  status: "active" | "done" | "error"
}

type SimulationPromptRun = {
  id: string
  title: string
  activities: SimulationActivity[]
  result: string
  finalAnswerStatus: "idle" | "streaming" | "done"
  rawPromptStream: string
}

type GoldfishSimulationPanelProps = {
  canStart: boolean
  isStarting: boolean
  isCreatingDevGame: boolean
  gameId: string
  simulationSeedInput: string
  currentSimulationSeed: number | null
  promptRuns: SimulationPromptRun[]
  errorMessage: string
  onSimulationSeedInputChange: (value: string) => void
  onOpenPromptStream: () => void
  onCreateDevGame: () => void
  onStart: () => void
  onStartOpeningHandBatchTest: () => void
}

function ActivityIcon({ status }: Pick<SimulationActivity, "status">) {
  if (status === "done") {
    return <CheckCircle2 className="size-5 text-emerald-300" />
  }

  if (status === "error") {
    return <XCircle className="size-5 text-red-300" />
  }

  return <LoaderCircle className="size-5 animate-spin text-amber-200" />
}

function FinalAnswerIcon({
  finalAnswerStatus,
}: {
  finalAnswerStatus: SimulationPromptRun["finalAnswerStatus"]
}) {
  if (finalAnswerStatus === "done") {
    return <CheckCircle2 className="size-5 text-emerald-300" />
  }

  return <LoaderCircle className="size-5 animate-spin text-amber-200" />
}

export function GoldfishSimulationPanel({
  canStart,
  isStarting,
  isCreatingDevGame,
  gameId,
  simulationSeedInput,
  currentSimulationSeed,
  promptRuns,
  errorMessage,
  onSimulationSeedInputChange,
  onOpenPromptStream,
  onCreateDevGame,
  onStart,
  onStartOpeningHandBatchTest,
}: GoldfishSimulationPanelProps) {
  const isNearBottomRef = useRef(false)
  const hasStream = promptRuns.some((run) => run.rawPromptStream.trim())

  useEffect(() => {
    function updateIsNearBottom() {
      const distanceToBottom = getDocumentHeight() - getViewportBottom()

      isNearBottomRef.current = distanceToBottom <= 100
    }

    updateIsNearBottom()

    window.addEventListener("scroll", updateIsNearBottom, { passive: true })
    window.addEventListener("resize", updateIsNearBottom)

    return () => {
      window.removeEventListener("scroll", updateIsNearBottom)
      window.removeEventListener("resize", updateIsNearBottom)
    }
  }, [])

  useEffect(() => {
    if (!isStarting) {
      return
    }

    window.scrollTo({
      top: getDocumentHeight(),
      behavior: "smooth",
    })
  }, [isStarting])

  useEffect(() => {
    const observedRoot = document.body

    if (!observedRoot) {
      return
    }

    let previousHeight = getDocumentHeight()

    const observer = new ResizeObserver(() => {
      const nextHeight = getDocumentHeight()

      if (nextHeight === previousHeight) {
        return
      }

      previousHeight = nextHeight

      if (!isNearBottomRef.current) {
        return
      }

      window.scrollTo({
        top: nextHeight,
        behavior: "smooth",
      })
    })

    observer.observe(observedRoot)

    return () => {
      observer.disconnect()
    }
  }, [])

  return (
    <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
      <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-2">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs font-medium tracking-[0.18em] text-amber-100 uppercase">
            <Sparkles className="size-3.5" />
            Auto goldfish simulation
          </div>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold tracking-tight text-stone-100">
              Start a simulation
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-stone-400">
              Once the full commander and deck package is resolved, create a game on the goldfish server, then let the configured model work through the prompt while you follow a higher-level activity trace.
            </p>
            <div className="pt-2">
              <label className="block space-y-2">
                <span className="text-xs font-medium tracking-[0.16em] text-stone-400 uppercase">
                  Simulation seed
                </span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="1"
                  value={simulationSeedInput}
                  onChange={(event) =>
                    onSimulationSeedInputChange(event.target.value)
                  }
                  placeholder="Blank = random"
                  className="h-11 w-full max-w-xs appearance-none rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 outline-none transition [appearance:textfield] placeholder:text-stone-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none focus:border-amber-300/40 focus:bg-black/40"
                />
              </label>
              <p className="mt-2 text-xs leading-5 text-stone-500">
                Leave blank to generate a random seed and display it here for
                reruns.
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row">
          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-full border-white/15 bg-white/5 px-5 text-stone-200 hover:bg-white/10 hover:text-stone-50 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-stone-900 disabled:text-stone-500"
            disabled={!hasStream}
            onClick={onOpenPromptStream}
          >
            <Eye />
            View full prompt stream
          </Button>

          <Button
            type="button"
            variant="outline"
            className="h-11 rounded-full border-sky-400/25 bg-sky-500/10 px-5 text-sky-100 hover:bg-sky-500/20 hover:text-sky-50 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-stone-900 disabled:text-stone-500"
            disabled={!canStart || isStarting || isCreatingDevGame}
            onClick={onCreateDevGame}
          >
            {isCreatingDevGame ? (
              <>
                <LoaderCircle className="animate-spin" />
                Creating test game
              </>
            ) : (
              <>
                <Sparkles />
                Dev: create + copy ID
              </>
            )}
          </Button>

          <Button
            type="button"
            size="lg"
            variant="outline"
            className="h-11 rounded-full border-fuchsia-400/25 bg-fuchsia-500/10 px-5 text-fuchsia-100 hover:bg-fuchsia-500/20 hover:text-fuchsia-50 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-stone-900 disabled:text-stone-500"
            disabled={!canStart || isStarting || isCreatingDevGame}
            onClick={onStartOpeningHandBatchTest}
          >
            {isStarting ? (
              <>
                <LoaderCircle className="animate-spin" />
                Running batch
              </>
            ) : (
              <>
                <Sparkles />
                Temp: 10 opening hands
              </>
            )}
          </Button>

          <Button
            type="button"
            size="lg"
            className="h-11 rounded-full bg-amber-500 px-5 text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-400"
            disabled={!canStart || isStarting || isCreatingDevGame}
            onClick={onStart}
          >
            {isStarting ? (
              <>
                <LoaderCircle className="animate-spin" />
                Running
              </>
            ) : (
              <>
                <Play />
                Start auto goldfish
              </>
            )}
          </Button>
        </div>
      </div>

      {gameId ? (
        <div className="mt-5 rounded-[24px] border border-white/10 bg-black/25 p-4 text-sm leading-6 text-stone-300">
          <div className="space-y-3">
            <div className="space-y-1">
              <p className="text-stone-400">Current game ID</p>
              <p className="font-mono text-sm text-emerald-300">{gameId}</p>
            </div>
            {currentSimulationSeed !== null ? (
              <div className="space-y-1">
                <p className="text-stone-400">Seed used</p>
                <p className="font-mono text-sm text-amber-200">
                  {currentSimulationSeed}
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {promptRuns.length ? (
        <div className="mt-4 space-y-4">
          {promptRuns.map((run) => {
            const promptPreview = run.rawPromptStream.trim()
              ? getPromptPreview(run.rawPromptStream)
              : ""

            return (
              <div
                key={run.id}
                className="rounded-[24px] border border-white/10 bg-black/20 p-4"
              >
                <div className="mb-4 border-b border-white/10 pb-3">
                  <p className="text-base font-semibold tracking-[0.01em] text-stone-50">
                    {run.title}
                  </p>
                </div>

                <div className="space-y-3">
                  {run.activities.map((activity) => (
                    <details
                      key={activity.id}
                      open
                      className="group rounded-[20px] border border-white/10 bg-white/[0.03] p-4"
                    >
                      <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
                        <div className="mt-0.5 shrink-0">
                          <ActivityIcon status={activity.status} />
                        </div>

                        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-stone-100">
                              {activity.title}
                            </p>
                          </div>
                          <ChevronDown className="mt-0.5 size-4 shrink-0 text-stone-500 transition-transform group-open:rotate-180" />
                        </div>
                      </summary>

                      <div className="mt-4">
                        {activity.detail ? <div>{activity.detail}</div> : null}
                        {activity.status === "active" && promptPreview ? (
                          <div
                            className={`min-w-0 overflow-hidden ${activity.detail ? "mt-4" : ""}`}
                            style={{
                              maskImage:
                                "linear-gradient(to right, transparent 0%, black 18%, black 82%, transparent 100%)",
                              WebkitMaskImage:
                                "linear-gradient(to right, transparent 0%, black 18%, black 82%, transparent 100%)",
                            }}
                          >
                            <p className="overflow-hidden text-xs leading-5 whitespace-nowrap text-stone-500/75">
                              {promptPreview}
                            </p>
                          </div>
                        ) : null}
                      </div>
                    </details>
                  ))}

                  {run.result ? (
                    <details
                      open
                      className="group rounded-[20px] border border-white/10 bg-white/[0.03] p-4"
                    >
                      <summary className="flex cursor-pointer list-none items-start gap-3 [&::-webkit-details-marker]:hidden">
                        <div className="mt-0.5 shrink-0">
                          <FinalAnswerIcon
                            finalAnswerStatus={run.finalAnswerStatus}
                          />
                        </div>

                        <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-stone-100">
                              Final answer
                            </p>
                          </div>
                          <ChevronDown className="mt-0.5 size-4 shrink-0 text-stone-500 transition-transform group-open:rotate-180" />
                        </div>
                      </summary>

                      <div className="mt-4">
                        <GoldfishAnswerMarkdown content={run.result} />
                      </div>
                    </details>
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-4 rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm text-red-100">
          {errorMessage}
        </div>
      ) : null}
    </section>
  )
}

function getDocumentHeight() {
  return Math.max(
    document.documentElement.scrollHeight,
    document.body.scrollHeight
  )
}

function getViewportBottom() {
  return window.scrollY + window.innerHeight
}

function getPromptPreview(rawPromptStream: string) {
  const normalizedStream = rawPromptStream.replace(/\s+/g, " ").trim()

  if (!normalizedStream) {
    return ""
  }

  const maxCharacters = 180
  const preview =
    normalizedStream.length > maxCharacters
      ? normalizedStream.slice(-maxCharacters)
      : normalizedStream

  if (preview === normalizedStream) {
    return preview
  }

  return `...${preview.replace(/^\S*\s?/, "")}`
}








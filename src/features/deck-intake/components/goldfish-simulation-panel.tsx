import {
  CheckCircle2,
  ChevronDown,
  Eye,
  LoaderCircle,
  Play,
  RotateCcw,
  Sparkles,
  Square,
  XCircle,
} from "lucide-react"
import { useEffect, useRef } from "react"

import { Button } from "@/components/ui/button"
import { GoldfishAnswerMarkdown } from "@/features/deck-intake/components/goldfish-answer-markdown"
import {
  renderSimulationActivityDetail,
  type SimulationActivity,
  type SimulationPromptRun,
} from "@/features/deck-intake/lib/simulation-session"

type GoldfishSimulationPanelProps = {
  canStart: boolean
  isStarting: boolean
  isCreatingDevGame: boolean
  gameId: string
  simulationSeedInput: string
  autoSimulationTurnCount: number
  currentSimulationSeed: number | null
  nextTurnPromptNumber: number | null
  promptRuns: SimulationPromptRun[]
  errorMessage: string
  onSimulationSeedInputChange: (value: string) => void
  onAutoSimulationTurnCountChange: (value: number) => void
  onCancelPromptRun: (runId: string) => void
  onRerunPromptRun: (runId: string) => void
  onSimulateNextTurn: () => void
  onOpenPromptStream: () => void
  onOpenCustomPromptTest: () => void
  onCreateDevGame: () => void
  onStart: () => void
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
  autoSimulationTurnCount,
  currentSimulationSeed,
  nextTurnPromptNumber,
  promptRuns,
  errorMessage,
  onSimulationSeedInputChange,
  onAutoSimulationTurnCountChange,
  onCancelPromptRun,
  onRerunPromptRun,
  onSimulateNextTurn,
  onOpenPromptStream,
  onOpenCustomPromptTest,
  onCreateDevGame,
  onStart,
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
      <div className="space-y-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1 text-xs font-medium tracking-[0.18em] text-amber-100 uppercase">
              <Sparkles className="size-3.5" />
              Auto goldfish simulation
            </div>
          </div>

          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap xl:justify-end">
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
              size="lg"
              variant="outline"
              className="h-11 rounded-full border-fuchsia-400/25 bg-fuchsia-500/10 px-5 text-fuchsia-100 hover:bg-fuchsia-500/20 hover:text-fuchsia-50"
              onClick={onOpenCustomPromptTest}
            >
              <Sparkles />
              Temp: custom prompt
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

        <div className="w-full space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight text-stone-100">
            Start a simulation
          </h2>
          <p className="text-sm leading-6 text-stone-400">
            Once the full commander and deck package is resolved, create a game
            on the goldfish server, then let the configured model play through
            the opening hand and your selected number of turns while you follow
            a higher-level activity trace. After that, you can continue with
            the simulate-next-turn button below the latest run.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-[minmax(0,16rem)_minmax(0,16rem)]">
          <div>
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
                className="h-11 w-full [appearance:textfield] appearance-none rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 transition outline-none placeholder:text-stone-500 focus:border-amber-300/40 focus:bg-black/40 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </label>
            <p className="mt-2 text-xs leading-5 text-stone-500">
              Leave blank to generate a random seed and display it here for
              reruns.
            </p>
          </div>

          <div>
            <label className="block space-y-2">
              <span className="text-xs font-medium tracking-[0.16em] text-stone-400 uppercase">
                Auto goldfish turns
              </span>
              <select
                value={autoSimulationTurnCount}
                onChange={(event) =>
                  onAutoSimulationTurnCountChange(Number(event.target.value))
                }
                className="h-11 w-full cursor-pointer rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 transition outline-none focus:border-amber-300/40 focus:bg-black/40"
              >
                {Array.from({ length: 10 }, (_, index) => {
                  const turnCount = index + 1

                  return (
                    <option
                      key={turnCount}
                      value={turnCount}
                      className="bg-stone-950 text-stone-100"
                    >
                      {turnCount} turn{turnCount === 1 ? "" : "s"}
                    </option>
                  )
                })}
              </select>
            </label>
            <p className="mt-2 text-xs leading-5 text-stone-500">
              Only used when starting auto goldfish.
            </p>
          </div>
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
              <details
                key={run.id}
                open
                className="group/run rounded-[24px] border border-white/10 bg-black/20 p-4"
              >
                <summary className="flex cursor-pointer list-none items-start justify-between gap-3 border-b border-transparent pb-0 group-open/run:mb-4 group-open/run:border-white/10 group-open/run:pb-3 [&::-webkit-details-marker]:hidden">
                  <p className="text-base font-semibold tracking-[0.01em] text-stone-50">
                    {run.title}
                  </p>
                  <div className="flex items-center gap-2">
                    {run.rerunnable &&
                    (run.status === "done" ||
                      run.status === "cancelled" ||
                      run.status === "error") ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-full border-white/15 bg-white/5 px-3 text-xs text-stone-200 hover:bg-white/10 hover:text-stone-50"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onRerunPromptRun(run.id)
                        }}
                      >
                        <RotateCcw className="size-3.5" />
                        Rerun
                      </Button>
                    ) : null}
                    {run.status === "running" ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-full border-red-400/30 bg-red-500/10 px-3 text-xs text-red-100 hover:bg-red-500/20 hover:text-red-50"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          onCancelPromptRun(run.id)
                        }}
                      >
                        <Square className="size-3.5 fill-current" />
                        Stop
                      </Button>
                    ) : null}
                    <ChevronDown className="mt-0.5 size-4 shrink-0 -rotate-90 text-stone-500 transition-transform group-open/run:rotate-0" />
                  </div>
                </summary>

                <div className="space-y-3">
                  {run.activities.map((activity) => {
                    const hasPromptPreview =
                      activity.status === "active" && Boolean(promptPreview)
                    const hasExpandableContent =
                      Boolean(activity.detail) || hasPromptPreview
                    const showCollapsedDetailPreview =
                      activity.toolName === "update_game_state" &&
                      Boolean(activity.detail)
                    const defaultExpanded =
                      activity.kind !== "tool" ||
                      activity.toolName !== "update_game_state"

                    if (!hasExpandableContent) {
                      return (
                        <div
                          key={activity.id}
                          className="rounded-[20px] border border-white/10 bg-white/[0.03] p-4"
                        >
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 shrink-0">
                              <ActivityIcon status={activity.status} />
                            </div>

                            <div className="min-w-0 flex-1">
                              <p className="text-sm font-medium text-stone-100">
                                {activity.title}
                              </p>
                            </div>
                          </div>
                        </div>
                      )
                    }

                    return (
                      <details
                        key={activity.id}
                        open={defaultExpanded}
                        className="group/activity rounded-[20px] border border-white/10 bg-white/[0.03] p-4"
                      >
                        <summary className="list-none cursor-pointer [&::-webkit-details-marker]:hidden">
                          <div className="flex items-start gap-3">
                            <div className="mt-0.5 shrink-0">
                              <ActivityIcon status={activity.status} />
                            </div>

                            <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-stone-100">
                                  {activity.title}
                                </p>
                              </div>
                              <ChevronDown className="mt-0.5 size-4 shrink-0 -rotate-90 text-stone-500 transition-transform group-open/activity:rotate-0" />
                            </div>
                          </div>

                          {showCollapsedDetailPreview ? (
                            <div className="relative mt-3 overflow-hidden rounded-2xl border border-white/8 bg-black/10 p-3 group-open/activity:hidden">
                              <div className="max-h-[5.75rem] overflow-hidden">
                                {renderSimulationActivityDetail(activity.detail)}
                              </div>
                              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent via-[#171717]/80 to-[#171717]" />
                            </div>
                          ) : null}
                        </summary>

                        <div className="mt-4">
                          {activity.detail ? (
                            <div>
                              {renderSimulationActivityDetail(activity.detail)}
                            </div>
                          ) : null}
                          {hasPromptPreview ? (
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
                    )
                  })}

                  {run.result ? (
                    <details
                      open
                      className="group/final rounded-[20px] border border-white/10 bg-white/[0.03] p-4"
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
                          <ChevronDown className="mt-0.5 size-4 shrink-0 -rotate-90 text-stone-500 transition-transform group-open/final:rotate-0" />
                        </div>
                      </summary>

                      <div className="mt-4">
                        <GoldfishAnswerMarkdown content={run.result} />
                      </div>
                    </details>
                  ) : null}
                </div>
              </details>
            )
          })}

          {nextTurnPromptNumber !== null ? (
            <div className="flex justify-center pt-2">
              <Button
                type="button"
                size="lg"
                variant="outline"
                className="h-11 rounded-full border-emerald-400/25 bg-emerald-500/10 px-5 text-emerald-100 hover:bg-emerald-500/20 hover:text-emerald-50 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-stone-900 disabled:text-stone-500"
                disabled={isStarting || isCreatingDevGame}
                onClick={onSimulateNextTurn}
              >
                {isStarting ? (
                  <>
                    <LoaderCircle className="animate-spin" />
                    Running
                  </>
                ) : (
                  <>
                    <Play />
                    Simulate turn {nextTurnPromptNumber}
                  </>
                )}
              </Button>
            </div>
          ) : null}
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

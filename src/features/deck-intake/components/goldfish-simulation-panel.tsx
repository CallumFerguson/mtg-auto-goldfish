import { LoaderCircle, Play, Sparkles } from "lucide-react"

import { Button } from "@/components/ui/button"

type GoldfishSimulationPanelProps = {
  canStart: boolean
  isStarting: boolean
  gameId: string
  result: string
  errorMessage: string
  onStart: () => void
}

export function GoldfishSimulationPanel({
  canStart,
  isStarting,
  gameId,
  result,
  errorMessage,
  onStart,
}: GoldfishSimulationPanelProps) {
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
              Once the full commander and deck package is resolved, create a
              game on the local goldfish server, then ask the local model to
              draw a seven-card starting hand for that game while streaming
              reasoning, tool calls, and the final answer live.
            </p>
          </div>
        </div>

        <Button
          type="button"
          size="lg"
          className="h-11 rounded-full bg-amber-500 px-5 text-stone-950 hover:bg-amber-400 disabled:cursor-not-allowed disabled:bg-stone-800 disabled:text-stone-400"
          disabled={!canStart || isStarting}
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

      {gameId ? (
        <div className="mt-5 rounded-[24px] border border-white/10 bg-black/25 p-4 text-sm leading-6 text-stone-300">
          <div className="space-y-1">
            <p className="text-stone-400">Current game ID</p>
            <p className="font-mono text-sm text-emerald-300">{gameId}</p>
          </div>
        </div>
      ) : null}

      {isStarting ? (
        <div className="mt-4 flex items-center gap-3 rounded-[24px] border border-amber-400/20 bg-amber-500/10 p-4 text-sm text-amber-100">
          <LoaderCircle className="size-4 animate-spin" />
          <span>Streaming simulation</span>
        </div>
      ) : null}

      {result ? (
        <div className="mt-4 rounded-[24px] border border-emerald-400/20 bg-emerald-500/10 p-4">
          <p className="text-xs font-medium tracking-[0.18em] text-emerald-200 uppercase">
            Simulation stream
          </p>
          <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-emerald-50">
            {result}
          </p>
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

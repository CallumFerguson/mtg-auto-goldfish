import type { ComponentProps } from "react"
import { AlertTriangle, LoaderCircle, Search } from "lucide-react"

import { Button } from "@/components/ui/button"

import { SAMPLE_DECKLIST } from "../constants"

type DeckIntakeFormProps = {
  commanderOneName: string
  commanderTwoName: string
  decklistText: string
  expectedDecklistCount: number
  canProcess: boolean
  isProcessing: boolean
  validationMessage: string
  lookupError: string
  onCommanderOneChange: (value: string) => void
  onCommanderTwoChange: (value: string) => void
  onDecklistChange: (value: string) => void
  onSubmit: NonNullable<ComponentProps<"form">["onSubmit"]>
}

export function DeckIntakeForm({
  commanderOneName,
  commanderTwoName,
  decklistText,
  expectedDecklistCount,
  canProcess,
  isProcessing,
  validationMessage,
  lookupError,
  onCommanderOneChange,
  onCommanderTwoChange,
  onDecklistChange,
  onSubmit,
}: DeckIntakeFormProps) {
  return (
    <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
      <div className="mb-6 space-y-2">
        <h2 className="text-2xl font-semibold tracking-tight">Deck intake</h2>
        <p className="max-w-2xl text-sm leading-6 text-stone-400">
          Add one or two commanders separately so we can always keep them
          explicit. The deck box accepts common MTG mass-entry styles such as{" "}
          <span className="font-medium">1 Sol Ring</span> or{" "}
          <span className="font-medium">4 Lightning Bolt</span>.
        </p>
      </div>

      <form className="space-y-5" onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-2">
            <span className="text-sm font-medium text-stone-100">
              Commander 1
            </span>
            <input
              value={commanderOneName}
              onChange={(event) => onCommanderOneChange(event.target.value)}
              placeholder="Atraxa, Praetors' Voice"
              className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
            />
          </label>

          <label className="grid gap-2">
            <span className="text-sm font-medium text-stone-100">
              Commander 2
            </span>
            <input
              value={commanderTwoName}
              onChange={(event) => onCommanderTwoChange(event.target.value)}
              placeholder="Optional partner / background / second commander"
              className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
            />
          </label>
        </div>

        <label className="grid gap-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-medium text-stone-100">
              Decklist
            </span>
            <span className="text-xs uppercase tracking-[0.18em] text-stone-500">
              Expect {expectedDecklistCount} cards in main deck
            </span>
          </div>
          <textarea
            value={decklistText}
            onChange={(event) => onDecklistChange(event.target.value)}
            placeholder={SAMPLE_DECKLIST}
            className="app-scrollbar min-h-80 rounded-[24px] border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm leading-6 text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
          />
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            size="lg"
            className="h-11 rounded-full bg-stone-950 px-5 text-stone-50 hover:bg-stone-800"
            disabled={!canProcess}
          >
            {isProcessing ? (
              <>
                <LoaderCircle className="animate-spin" />
                Processing deck
              </>
            ) : (
              <>
                <Search />
                Process with Scryfall
              </>
            )}
          </Button>
          <p className="text-sm text-stone-400">
            Commander decks are 100 cards total, so the deck box should contain{" "}
            {expectedDecklistCount} cards with the current commander setup.
          </p>
        </div>

        {validationMessage ? (
          <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
            {validationMessage}
          </div>
        ) : null}
      </form>

      {lookupError ? (
        <div className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>{lookupError}</p>
        </div>
      ) : null}
    </section>
  )
}

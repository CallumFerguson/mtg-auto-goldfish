import type { MissingCard } from "../types"

type MissingCardsPanelProps = {
  missingCards: MissingCard[]
  onManualTextChange: (name: string, manualText: string) => void
}

export function MissingCardsPanel({
  missingCards,
  onManualTextChange,
}: MissingCardsPanelProps) {
  return (
    <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
      <div className="mb-5 space-y-1">
        <h2 className="text-2xl font-semibold tracking-tight">Missing cards</h2>
        <p className="text-sm leading-6 text-stone-400">
          If Scryfall cannot find a card, you can paste its rules text manually
          and it will be included above right away.
        </p>
      </div>

      {missingCards.length ? (
        <div className="grid gap-4">
          {missingCards.map((card) => (
            <label
              key={card.name}
              className="grid gap-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-4"
            >
              <div className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
                <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em]">
                  Missing
                </span>
                <span className="font-semibold">
                  {card.quantity}x {card.name}
                </span>
              </div>
              <textarea
                value={card.manualText}
                onChange={(event) =>
                  onManualTextChange(card.name, event.target.value)
                }
                placeholder="Paste oracle text, type line notes, or any gameplay-relevant reminder text here."
                className="app-scrollbar min-h-32 rounded-2xl border border-amber-400/30 bg-black/25 px-4 py-3 text-sm leading-6 text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-400/20"
              />
            </label>
          ))}
        </div>
      ) : (
        <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
          Any cards Scryfall misses will show up here for manual entry.
        </div>
      )}
    </div>
  )
}

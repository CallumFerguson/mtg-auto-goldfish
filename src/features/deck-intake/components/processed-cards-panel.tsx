import { AlertTriangle, CheckCircle2, LoaderCircle, Search } from "lucide-react"

import { cn } from "@/lib/utils"

import type { ResolvedCard } from "../types"
import { StatLine } from "./stat-line"

type StatusBadge = {
  icon: typeof LoaderCircle
  className: string
  label: string
  iconClassName?: string
}

type ProcessedCardsPanelProps = {
  completedCards: ResolvedCard[]
  fuzzyMatchCount: number
  missingCardCount: number
  isProcessing: boolean
}

export function ProcessedCardsPanel({
  completedCards,
  fuzzyMatchCount,
  missingCardCount,
  isProcessing,
}: ProcessedCardsPanelProps) {
  const fuzzyMatchLabel =
    fuzzyMatchCount === 1 ? "1 fuzzy match" : `${fuzzyMatchCount} fuzzy matches`
  const missingCardLabel =
    missingCardCount === 1 ? "1 missing card" : `${missingCardCount} missing cards`

  const statusBadges: StatusBadge[] =
    isProcessing
      ? [
          {
            icon: LoaderCircle,
            className: "bg-stone-900 text-stone-100",
            iconClassName: "animate-spin",
            label: "Processing",
          },
        ]
      : fuzzyMatchCount || missingCardCount
      ? [
          fuzzyMatchCount
            ? {
                icon: Search,
                className: "bg-amber-200 text-amber-900",
                label: fuzzyMatchLabel,
              }
            : undefined,
          missingCardCount
            ? {
                icon: AlertTriangle,
                className: "bg-red-500/20 text-red-100",
                label: missingCardLabel,
              }
            : undefined,
        ].filter((statusBadge): statusBadge is StatusBadge => Boolean(statusBadge))
      : completedCards.length
        ? [
            {
              icon: CheckCircle2,
              className: "bg-emerald-50 text-emerald-700",
              label: "Ready",
            },
          ]
        : []

  return (
    <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">
            Processed card text
          </h2>
          <p className="text-sm leading-6 text-stone-400">
            This is the card context the future goldfish agent will use.
          </p>
        </div>
        {statusBadges.length ? (
          <div className="flex flex-wrap items-start justify-end gap-2">
            {statusBadges.map((statusBadge) => (
              <div
                key={statusBadge.label}
                className={cn(
                  "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium",
                  statusBadge.className
                )}
              >
                <statusBadge.icon
                  className={cn("size-3.5", statusBadge.iconClassName)}
                />
                {statusBadge.label}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {completedCards.length ? (
        <div className="app-scrollbar grid max-h-[42rem] gap-3 overflow-y-auto pr-1">
          {completedCards.map((card) => (
            <article
              key={`${card.source}-${card.name}`}
              className="rounded-2xl border border-white/10 bg-black/20 p-4"
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h3 className="text-base font-semibold text-stone-100">
                  {card.name}
                </h3>
                {card.source !== "scryfall" ? (
                  <span
                    className={cn(
                      "rounded-full px-2.5 py-1 text-xs font-medium",
                      card.source === "manual"
                        ? "bg-amber-100 text-amber-800"
                        : "bg-sky-100 text-sky-800"
                    )}
                  >
                    {card.source === "manual"
                      ? "Manual text"
                      : "Accepted fuzzy match"}
                  </span>
                ) : null}
              </div>

              <div className="space-y-2 text-sm leading-6 text-stone-300">
                {card.manaCost ? (
                  <p>
                    <span className="font-medium text-stone-100">
                      Mana cost:
                    </span>{" "}
                    {card.manaCost}
                  </p>
                ) : null}
                {card.typeLine ? (
                  <p>
                    <span className="font-medium text-stone-100">Type:</span>{" "}
                    {card.typeLine}
                  </p>
                ) : null}
                <StatLine
                  power={card.power}
                  toughness={card.toughness}
                  loyalty={card.loyalty}
                />
                <p className="whitespace-pre-wrap">{card.oracleText}</p>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
          Process a deck to preview the final gameplay text package.
        </div>
      )}
    </div>
  )
}

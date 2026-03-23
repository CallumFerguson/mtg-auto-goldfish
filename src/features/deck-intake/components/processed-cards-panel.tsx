import { AlertTriangle, CheckCircle2, LoaderCircle, Search, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { toManaCost, toOracleText, toTypeLine } from "../lib/scryfall"
import type { FuzzyMatch, MissingCard, ResolvedCard } from "../types"
import { StatLine } from "./stat-line"

type StatusBadge = {
  icon: typeof LoaderCircle
  className: string
  label: string
  iconClassName?: string
}

type ProcessedCardsPanelProps = {
  commanderOneName: string
  commanderTwoName: string
  completedCards: ResolvedCard[]
  fuzzyMatches: FuzzyMatch[]
  missingCards: MissingCard[]
  fuzzyMatchCount: number
  missingCardCount: number
  isProcessing: boolean
  onAcceptFuzzyMatch: (match: FuzzyMatch) => void
  onAcceptManualCard: (name: string) => void
  onCancelFuzzyMatch: (card: ResolvedCard) => void
  onClearOverrides: () => void
  onEditManualCard: (name: string) => void
  onRejectFuzzyMatch: (match: FuzzyMatch) => void
  onManualTextChange: (name: string, manualText: string) => void
}

function normalizeName(name: string) {
  return name.trim().toLowerCase()
}

export function ProcessedCardsPanel({
  commanderOneName,
  commanderTwoName,
  completedCards,
  fuzzyMatches,
  missingCards,
  fuzzyMatchCount,
  missingCardCount,
  isProcessing,
  onAcceptFuzzyMatch,
  onAcceptManualCard,
  onCancelFuzzyMatch,
  onClearOverrides,
  onEditManualCard,
  onRejectFuzzyMatch,
  onManualTextChange,
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

  const commanderLookups = new Set(
    [commanderOneName, commanderTwoName].filter(Boolean).map(normalizeName)
  )
  const commanderSlots = [
    {
      lookup: normalizeName(commanderOneName),
    },
    {
      lookup: normalizeName(commanderTwoName),
    },
  ].filter((slot) => Boolean(slot.lookup))

  const regularFuzzyMatches = fuzzyMatches.filter(
    (match) => !commanderLookups.has(normalizeName(match.name))
  )
  const pendingMissingCards = missingCards.filter(
    (card) => !card.isAccepted && !commanderLookups.has(normalizeName(card.name))
  )
  const acceptedFuzzyCards = completedCards.filter(
    (card) => !card.isCommander && card.source === "fuzzy"
  )
  const manualCards = completedCards.filter(
    (card) => !card.isCommander && card.source === "manual"
  )
  const regularCards = completedCards.filter(
    (card) =>
      !card.isCommander &&
      card.source !== "fuzzy" &&
      card.source !== "manual"
  )
  const hasCurrentOverrides =
    completedCards.some(
      (card) => card.source === "fuzzy" || card.source === "manual"
    ) || missingCards.some((card) => Boolean(card.rejectedSuggestion))

  function renderResolvedCard(card: ResolvedCard) {
    const isManualCard = card.source === "manual"
    const isFuzzyCard = card.source === "fuzzy"

    return (
      <article
        key={`${card.source}-${card.requestedName}`}
        className="rounded-2xl border border-white/10 bg-black/20 p-4"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold text-stone-100">{card.name}</h3>
          {card.isCommander ? (
            <span className="rounded-full bg-violet-200 px-2.5 py-1 text-xs font-medium text-violet-900">
              Commander
            </span>
          ) : null}
          {isFuzzyCard ? (
            <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-medium text-sky-800">
              Accepted fuzzy match
            </span>
          ) : null}
          {isManualCard ? (
            <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-medium text-amber-800">
              Manual entry
            </span>
          ) : null}
          {isFuzzyCard ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-8 rounded-full px-3 text-stone-300 hover:bg-white/10 hover:text-stone-100"
              onClick={() => onCancelFuzzyMatch(card)}
            >
              <X className="size-3.5" />
              Cancel fuzzy match
            </Button>
          ) : null}
          {isManualCard ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="ml-auto h-8 rounded-full px-3 text-stone-300 hover:bg-white/10 hover:text-stone-100"
              onClick={() => onEditManualCard(card.requestedName)}
            >
              Edit
            </Button>
          ) : null}
        </div>

        <div className="space-y-2 text-sm leading-6 text-stone-300">
          {card.manaCost ? (
            <p>
              <span className="font-medium text-stone-100">Mana cost:</span>{" "}
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
    )
  }

  function renderFuzzyMatch(match: FuzzyMatch) {
    return (
      <article
        key={match.name}
        className="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-4"
      >
        <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
          <span className="rounded-full bg-amber-400/20 px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em] text-amber-100">
            Fuzzy review
          </span>
          <span className="font-semibold text-stone-100">
            {match.quantity}x {match.name}
          </span>
          <span className="text-stone-400">suggested as</span>
          <span className="font-semibold text-amber-100">
            {match.suggestedCard.name}
          </span>
        </div>

        <div className="space-y-2 text-sm leading-6 text-stone-300">
          {toManaCost(match.suggestedCard) ? (
            <p>
              <span className="font-medium text-stone-100">Mana cost:</span>{" "}
              {toManaCost(match.suggestedCard)}
            </p>
          ) : null}
          {toTypeLine(match.suggestedCard) ? (
            <p>
              <span className="font-medium text-stone-100">Type:</span>{" "}
              {toTypeLine(match.suggestedCard)}
            </p>
          ) : null}
          <p className="whitespace-pre-wrap">
            {toOracleText(match.suggestedCard)}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-3">
          <Button
            type="button"
            className="bg-emerald-600 text-white hover:bg-emerald-500"
            onClick={() => onAcceptFuzzyMatch(match)}
          >
            Accept match
          </Button>
          <Button
            type="button"
            variant="outline"
            className="border-white/10 bg-black/20 text-stone-100 hover:bg-black/35"
            onClick={() => onRejectFuzzyMatch(match)}
          >
            Reject and enter manually
          </Button>
        </div>
      </article>
    )
  }

  function renderMissingCard(card: MissingCard) {
    return (
      <label
        key={card.name}
        className="grid gap-2 rounded-2xl border border-red-400/20 bg-red-500/5 p-4"
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-red-100">
          <span className="rounded-full bg-red-500/20 px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em]">
            Missing
          </span>
          <span className="font-semibold">
            {card.quantity}x {card.name}
          </span>
        </div>
        <textarea
          value={card.manualText}
          onChange={(event) => onManualTextChange(card.name, event.target.value)}
          placeholder="Paste oracle text, type line notes, or any gameplay-relevant reminder text here."
          className="app-scrollbar min-h-32 rounded-2xl border border-red-400/25 bg-black/25 px-4 py-3 text-sm leading-6 text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-red-400 focus:ring-4 focus:ring-red-400/20"
        />
        <div className="flex justify-end">
          <Button
            type="button"
            className="bg-emerald-600 text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!card.manualText.trim()}
            onClick={() => onAcceptManualCard(card.name)}
          >
            Accept text
          </Button>
        </div>
      </label>
    )
  }

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
        {statusBadges.length || hasCurrentOverrides ? (
          <div className="flex flex-wrap items-start justify-end gap-2">
            {hasCurrentOverrides ? (
              <Button
                type="button"
                variant="outline"
                className="border-white/10 bg-black/20 text-stone-100 hover:bg-black/35"
                onClick={onClearOverrides}
              >
                Clear fuzzy/manual overrides
              </Button>
            ) : null}
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

      {completedCards.length || fuzzyMatches.length || missingCards.length ? (
        <div className="app-scrollbar grid max-h-[42rem] gap-3 overflow-y-auto pr-1">
          {commanderSlots.map((slot) => {
            const resolvedCommanderCards = completedCards.filter(
              (card) =>
                card.isCommander &&
                normalizeName(card.requestedName) === slot.lookup
            )
            const commanderFuzzyMatches = fuzzyMatches.filter(
              (match) => normalizeName(match.name) === slot.lookup
            )
            const commanderMissingCards = missingCards.filter(
              (card) =>
                !card.isAccepted && normalizeName(card.name) === slot.lookup
            )

            return (
              <div key={slot.lookup} className="contents">
                {resolvedCommanderCards.map(renderResolvedCard)}
                {commanderFuzzyMatches.map(renderFuzzyMatch)}
                {commanderMissingCards.map(renderMissingCard)}
              </div>
            )
          })}

          {regularFuzzyMatches.map(renderFuzzyMatch)}
          {pendingMissingCards.map(renderMissingCard)}
          {acceptedFuzzyCards.map(renderResolvedCard)}
          {manualCards.map(renderResolvedCard)}
          {regularCards.map(renderResolvedCard)}
        </div>
      ) : (
        <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
          Process a deck to preview the final gameplay text package.
        </div>
      )}
    </div>
  )
}

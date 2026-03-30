import { LoaderCircle, X } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { createPortal } from "react-dom"

import {
  fetchCardByName,
  fetchCardsByName,
  toManaCost,
  toOracleText,
  toTypeLine,
} from "@/features/deck-intake/lib/scryfall"
import type { ScryfallCard } from "@/features/deck-intake/types"
import { cn } from "@/lib/utils"

type ToolCardChipProps = {
  cardName: string
  className?: string
  onClick?: () => void
}

type ToolCardListProps = {
  cards: readonly string[]
  label?: string
  className?: string
}

export function ToolCardChip({
  cardName,
  className,
  onClick,
}: ToolCardChipProps) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex cursor-pointer items-center rounded-md border border-amber-300/15 bg-amber-400/10 px-2.5 py-0.5 text-[11px] font-medium leading-5 text-amber-50 transition hover:border-amber-200/35 hover:bg-amber-400/18 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950",
        className
      )}
      onClick={onClick}
    >
      {cardName}
    </button>
  )
}

export function ToolCardList({
  cards,
  label,
  className,
}: ToolCardListProps) {
  const uniqueCards = useMemo(() => Array.from(new Set(cards)), [cards])
  const cardEntries = useMemo(() => {
    const occurrences = new Map<string, number>()

    return cards.map((cardName) => {
      const nextOccurrence = (occurrences.get(cardName) ?? 0) + 1
      occurrences.set(cardName, nextOccurrence)

      return {
        cardName,
        key: `${cardName}-${nextOccurrence}`,
      }
    })
  }, [cards])
  const [selectedCardName, setSelectedCardName] = useState<string | null>(null)
  const [selectedCard, setSelectedCard] = useState<ScryfallCard | null>(null)
  const [lookupStatus, setLookupStatus] = useState<"idle" | "loading" | "error">(
    "idle"
  )
  const [lookupError, setLookupError] = useState("")
  const [allCardsStatus, setAllCardsStatus] = useState<
    "idle" | "loading" | "loaded" | "error"
  >("idle")
  const [allCardsError, setAllCardsError] = useState("")
  const [loadedCardsByName, setLoadedCardsByName] = useState<
    Record<string, ScryfallCard>
  >({})

  useEffect(() => {
    if (!selectedCardName || lookupStatus !== "loading") {
      return
    }

    let isCancelled = false

    void fetchCardByName(selectedCardName)
      .then((card) => {
        if (isCancelled) {
          return
        }

        if (!card) {
          setSelectedCard(null)
          setLookupStatus("error")
          setLookupError("Scryfall did not return a card for that name.")
          return
        }

        setSelectedCard(card)
        setLookupStatus("idle")
      })
      .catch((error: unknown) => {
        if (isCancelled) {
          return
        }

        setSelectedCard(null)
        setLookupStatus("error")
        setLookupError(
          error instanceof Error
            ? error.message
            : "Scryfall lookup failed. Please try again."
        )
      })

    return () => {
      isCancelled = true
    }
  }, [lookupStatus, selectedCardName])

  if (!cards.length) {
    return null
  }

  function handleCardClick(cardName: string) {
    setSelectedCardName(cardName)
    setSelectedCard(null)
    setLookupStatus("loading")
    setLookupError("")
  }

  function closeModal() {
    setSelectedCardName(null)
    setSelectedCard(null)
    setLookupStatus("idle")
    setLookupError("")
  }

  async function handleLoadAll() {
    if (!uniqueCards.length || allCardsStatus === "loading") {
      return
    }

    setAllCardsStatus("loading")
    setAllCardsError("")

    try {
      const { results, fuzzyMatches } = await fetchCardsByName(uniqueCards)
      const nextLoadedCards: Record<string, ScryfallCard> = {}

      for (const cardName of uniqueCards) {
        const lookupKey = cardName.toLowerCase()
        const match = results.get(lookupKey) ?? fuzzyMatches.get(lookupKey)

        if (match) {
          nextLoadedCards[cardName] = match
        }
      }

      setLoadedCardsByName(nextLoadedCards)
      setAllCardsStatus("loaded")
    } catch (error: unknown) {
      setAllCardsStatus("error")
      setAllCardsError(
        error instanceof Error
          ? error.message
          : "Scryfall bulk lookup failed. Please try again."
      )
    }
  }

  return (
    <>
      <div className={cn("space-y-2", className)}>
        {label ? (
          <p className="text-xs leading-5 text-stone-400">{label}</p>
        ) : null}
        {allCardsStatus !== "loaded" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center rounded-md border border-sky-300/20 bg-sky-400/10 px-2.5 py-0.5 text-[11px] font-medium leading-5 text-sky-100 transition hover:border-sky-200/35 hover:bg-sky-400/20 hover:text-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950 disabled:cursor-not-allowed disabled:border-white/10 disabled:bg-white/5 disabled:text-stone-500"
                onClick={handleLoadAll}
                disabled={allCardsStatus === "loading"}
              >
                {allCardsStatus === "loading" ? (
                  <>
                    <LoaderCircle className="mr-1.5 size-3 animate-spin" />
                    Loading all images
                  </>
                ) : (
                  "Load all card images"
                )}
              </button>
              {cardEntries.map(({ cardName, key }) => (
                <ToolCardChip
                  key={key}
                  cardName={cardName}
                  onClick={() => handleCardClick(cardName)}
                />
              ))}
            </div>
          </>
        ) : null}
        {allCardsError ? (
          <div className="rounded-2xl border border-red-400/25 bg-red-500/10 p-3 text-xs leading-5 text-red-100">
            {allCardsError}
          </div>
        ) : null}
        {allCardsStatus === "loaded" ? (
          <div className="flex flex-nowrap items-start gap-2 overflow-x-auto pt-2 pb-2">
            {cardEntries.map(({ cardName, key }) => {
              const card = loadedCardsByName[cardName]
              const imageUrl = getCardImageUrl(card ?? null)

              if (!card || !imageUrl) {
                return (
                  <button
                    key={key}
                    type="button"
                    className="w-full max-w-[calc((100%-3rem)/7)] flex-none overflow-hidden rounded-[20px] border border-white/10 bg-white/[0.03] p-2 text-left transition hover:border-amber-200/25 hover:bg-white/[0.05]"
                    onClick={() => handleCardClick(cardName)}
                  >
                    <div className="flex aspect-[5/7] items-center justify-center rounded-[14px] border border-dashed border-white/10 bg-black/25 px-2 text-center text-[11px] leading-4 text-stone-400">
                      No image available
                    </div>
                    <p className="mt-2 line-clamp-2 text-[11px] font-medium leading-4 text-stone-200">
                      {cardName}
                    </p>
                  </button>
                )
              }

              return (
                <button
                  key={key}
                  type="button"
                  className="w-full max-w-[calc((100%-3rem)/7)] flex-none overflow-hidden rounded-[20px] border border-white/10 bg-white/[0.03] text-left transition hover:border-amber-200/25 hover:bg-white/[0.05]"
                  onClick={() => {
                    setSelectedCardName(cardName)
                    setSelectedCard(card)
                    setLookupStatus("idle")
                    setLookupError("")
                  }}
                >
                  <img
                    src={imageUrl}
                    alt={card.name}
                    className="block aspect-[5/7] w-full object-cover"
                  />
                  <div className="p-2">
                    <p className="line-clamp-2 text-[11px] font-medium leading-4 text-stone-200">
                      {card.name}
                    </p>
                  </div>
                </button>
              )
            })}
          </div>
        ) : null}
      </div>
      <CardLookupModal
        card={selectedCard}
        cardName={selectedCardName}
        isLoading={lookupStatus === "loading"}
        errorMessage={lookupError}
        onClose={closeModal}
      />
    </>
  )
}

function CardLookupModal({
  card,
  cardName,
  isLoading,
  errorMessage,
  onClose,
}: {
  card: ScryfallCard | null
  cardName: string | null
  isLoading: boolean
  errorMessage: string
  onClose: () => void
}) {
  const imageUrl = useMemo(() => getCardImageUrl(card), [card])
  const manaCost = card ? toManaCost(card) : ""
  const typeLine = card ? toTypeLine(card) : ""
  const oracleText = card ? toOracleText(card) : ""
  const displayCardName = card?.name ?? cardName ?? "Card"
  const modalContent = (
    <div
      className="fixed inset-0 z-[100] flex overflow-y-auto bg-black/75 px-4 py-6 backdrop-blur-sm sm:items-center sm:justify-center"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="my-auto flex min-h-[calc(100vh-3rem)] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] border border-amber-300/15 bg-[linear-gradient(180deg,rgba(28,25,23,0.98)_0%,rgba(12,10,9,0.98)_100%)] shadow-[0_30px_120px_rgba(0,0,0,0.7)] sm:min-h-0"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tool-card-modal-title"
      >
        <div className="border-b border-white/10 bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.12),transparent_55%)] p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.22em] text-amber-100/75">
                Scryfall card details
              </p>
              <h3
                id="tool-card-modal-title"
                className="mt-2 text-2xl font-semibold tracking-tight text-stone-50"
              >
                {displayCardName}
              </h3>
              {card?.set_name ? (
                <p className="mt-2 text-sm text-stone-400">
                  {card.set_name}
                  {card.collector_number ? ` - #${card.collector_number}` : ""}
                  {card.rarity ? ` - ${card.rarity}` : ""}
                </p>
              ) : null}
              {card?.scryfall_uri ? (
                <a
                  href={card.scryfall_uri}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center rounded-full border border-sky-300/20 bg-sky-400/10 px-3 py-1 text-xs font-medium text-sky-100 transition hover:border-sky-200/35 hover:bg-sky-400/20 hover:text-sky-50"
                >
                  Open on Scryfall
                </a>
              ) : null}
            </div>

            <button
              type="button"
              className="inline-flex size-11 items-center justify-center rounded-full border border-white/10 bg-white/5 text-stone-300 transition hover:bg-white/10 hover:text-stone-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/60 focus-visible:ring-offset-2 focus-visible:ring-offset-stone-950"
              onClick={onClose}
              aria-label="Close card details"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>

        <div className="grid gap-6 p-6 lg:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
          <div className="flex items-start justify-center">
            <div className="overflow-hidden rounded-[24px] border border-white/10 bg-black/30 shadow-[0_18px_50px_rgba(0,0,0,0.45)]">
              {isLoading ? (
                <div className="flex min-h-[475px] w-[310px] items-center justify-center gap-3 px-6 text-sm text-stone-300">
                  <LoaderCircle className="size-5 animate-spin text-amber-200" />
                  Loading from Scryfall...
                </div>
              ) : imageUrl ? (
                <img
                  src={imageUrl}
                  alt={displayCardName}
                  className="block h-auto w-[310px] max-w-full"
                />
              ) : (
                <div className="flex min-h-[475px] w-[310px] items-center justify-center px-6 text-center text-sm leading-6 text-stone-400">
                  No card image was available from Scryfall for this card.
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4">
            {errorMessage ? (
              <div className="rounded-2xl border border-red-400/25 bg-red-500/10 p-4 text-sm text-red-100">
                {errorMessage}
              </div>
            ) : null}

            {manaCost ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">
                  Mana Cost
                </p>
                <p className="mt-2 text-sm text-stone-100">{manaCost}</p>
              </div>
            ) : null}

            {typeLine ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">
                  Type
                </p>
                <p className="mt-2 text-sm text-stone-100">{typeLine}</p>
              </div>
            ) : null}

            {oracleText ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">
                  Oracle Text
                </p>
                <p className="mt-2 text-sm leading-6 whitespace-pre-wrap text-stone-200">
                  {oracleText}
                </p>
              </div>
            ) : null}

            {card?.power && card.toughness ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">
                  Power / Toughness
                </p>
                <p className="mt-2 text-sm text-stone-100">
                  {card.power}/{card.toughness}
                </p>
              </div>
            ) : null}

            {card?.loyalty ? (
              <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
                <p className="text-xs font-medium uppercase tracking-[0.18em] text-stone-400">
                  Loyalty
                </p>
                <p className="mt-2 text-sm text-stone-100">{card.loyalty}</p>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )

  useEffect(() => {
    if (!cardName) {
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
  }, [cardName, onClose])

  if (!cardName) {
    return null
  }

  if (typeof document === "undefined") {
    return modalContent
  }

  return createPortal(modalContent, document.body)
}

function getCardImageUrl(card: ScryfallCard | null) {
  if (!card) {
    return ""
  }

  return (
    card.image_uris?.large ??
    card.image_uris?.normal ??
    card.image_uris?.small ??
    card.card_faces?.[0]?.image_uris?.large ??
    card.card_faces?.[0]?.image_uris?.normal ??
    card.card_faces?.[0]?.image_uris?.small ??
    ""
  )
}

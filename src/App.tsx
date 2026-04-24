import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react"
import {
  ArrowLeft,
  Plus,
  RefreshCw,
  Sparkles,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { validateAndParseDeckInput } from "@/lib/deck-input"

type Deck = {
  id: string
  name: string
  description: string | null
}

type DeckCard = {
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

type DeckDetails = Deck & {
  commanders: DeckCard[]
  cards: DeckCard[]
}

type DecksResponse = {
  decks: Deck[]
}

type DeckResponse = {
  deck: DeckDetails
}

type DeckPageTab = "details" | "simulation"

const API_BASE_URL = "http://127.0.0.1:3001"
const SIMULATION_PLACEHOLDERS = [
  "Opening hand check",
  "Three-turn ramp line",
  "Interaction-heavy table",
]
const CARD_TYPE_PRIORITY = [
  "Land",
  "Creature",
  "Planeswalker",
  "Battle",
  "Instant",
  "Sorcery",
  "Artifact",
  "Enchantment",
] as const
const CARD_TYPE_DISPLAY_ORDER = [
  ...CARD_TYPE_PRIORITY.filter((type) => type !== "Land"),
  "Land",
] as const
const DEFAULT_CARD_CATEGORY = "Other"
const CARD_CATEGORY_LABELS: Record<string, string> = {
  Artifact: "Artifacts",
  Battle: "Battles",
  Commander: "Commander",
  Creature: "Creatures",
  Enchantment: "Enchantments",
  Instant: "Instants",
  Land: "Lands",
  Other: "Other",
  Planeswalker: "Planeswalkers",
  Sorcery: "Sorceries",
}

export function App() {
  const pathname = usePathname()
  const deckId = getDeckIdFromPathname(pathname)

  return deckId ? <DeckPage deckId={deckId} /> : <DeckListPage />
}

function DeckListPage() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [isLoadingDecks, setIsLoadingDecks] = useState(true)
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null)
  const [isCreateDeckOpen, setIsCreateDeckOpen] = useState(false)

  async function loadDecks() {
    setIsLoadingDecks(true)
    setDeckLoadError(null)

    try {
      const response = await fetch(`${API_BASE_URL}/decks`)

      if (!response.ok) {
        throw new Error(`Deck request failed with ${response.status}`)
      }

      const data = (await response.json()) as DecksResponse
      setDecks(data.decks)
    } catch {
      setDeckLoadError("Decks could not be loaded.")
    } finally {
      setIsLoadingDecks(false)
    }
  }

  useEffect(() => {
    void loadDecks()
  }, [])

  return (
    <main className="min-h-svh bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <section className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-2">
            <p className="text-sm font-medium tracking-[0.18em] text-sky-300 uppercase">
              MTG Auto Goldfish
            </p>
            <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
              Decks
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Refresh decks"
              title="Refresh decks"
              onClick={() => void loadDecks()}
              disabled={isLoadingDecks}
            >
              <RefreshCw
                className={isLoadingDecks ? "animate-spin" : undefined}
              />
            </Button>
            <Button type="button" onClick={() => setIsCreateDeckOpen(true)}>
              <Plus data-icon="inline-start" />
              New deck
            </Button>
          </div>
        </header>

        <div className="overflow-hidden rounded-lg border border-border bg-card/70">
          {isLoadingDecks ? (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              Loading decks...
            </div>
          ) : deckLoadError ? (
            <div className="flex flex-col gap-3 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-destructive">{deckLoadError}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadDecks()}
              >
                Try again
              </Button>
            </div>
          ) : decks.length > 0 ? (
            <ul className="divide-y divide-border">
              {decks.map((deck) => (
                <li key={deck.id}>
                  <a
                    className="group flex items-center justify-between gap-4 px-4 py-4 text-base font-medium text-foreground transition-colors hover:bg-muted/45 focus:bg-muted/45 focus:outline-none"
                    href={`/decks/${deck.id}`}
                    onClick={(event) => {
                      event.preventDefault()
                      navigateTo(`/decks/${deck.id}`)
                    }}
                  >
                    <span>{deck.name}</span>
                    <span className="text-sm text-muted-foreground transition-colors group-hover:text-sky-200">
                      Open
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <div className="px-4 py-8 text-sm text-muted-foreground">
              No decks yet.
            </div>
          )}
        </div>
      </section>

      {isCreateDeckOpen ? (
        <CreateDeckModal
          onClose={() => setIsCreateDeckOpen(false)}
          onCreated={() => {
            setIsCreateDeckOpen(false)
            void loadDecks()
          }}
        />
      ) : null}
    </main>
  )
}

function DeckPage({ deckId }: { deckId: string }) {
  const [deck, setDeck] = useState<DeckDetails | null>(null)
  const [activeTab, setActiveTab] = useState<DeckPageTab>("details")
  const [isLoadingDeck, setIsLoadingDeck] = useState(true)
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null)

  const loadDeck = useCallback(async () => {
    setIsLoadingDeck(true)
    setDeckLoadError(null)

    try {
      const response = await fetch(`${API_BASE_URL}/decks/${deckId}`)

      if (!response.ok) {
        throw new Error(`Deck request failed with ${response.status}`)
      }

      const data = (await response.json()) as DeckResponse
      setDeck(data.deck)
    } catch {
      setDeckLoadError("Deck could not be loaded.")
    } finally {
      setIsLoadingDeck(false)
    }
  }, [deckId])

  useEffect(() => {
    void loadDeck()
  }, [loadDeck])

  return (
    <main className="min-h-svh bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <section className="mx-auto flex w-full max-w-6xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-border pb-5">
          <Button
            type="button"
            variant="ghost"
            className="w-fit"
            onClick={() => navigateTo("/")}
          >
            <ArrowLeft data-icon="inline-start" />
            Decks
          </Button>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-2">
              <p className="text-sm font-medium tracking-[0.18em] text-sky-300 uppercase">
                Deck page
              </p>
              <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
                {deck?.name ?? "Deck"}
              </h1>
            </div>

            <div className="inline-grid w-full grid-cols-2 rounded-lg border border-border bg-card/70 p-1 sm:w-auto">
              <TabButton
                isActive={activeTab === "details"}
                onClick={() => setActiveTab("details")}
              >
                Details
              </TabButton>
              <TabButton
                isActive={activeTab === "simulation"}
                onClick={() => setActiveTab("simulation")}
              >
                Simulation
              </TabButton>
            </div>
          </div>
        </header>

        {isLoadingDeck ? (
          <div className="rounded-lg border border-border bg-card/70 px-4 py-8 text-sm text-muted-foreground">
            Loading deck...
          </div>
        ) : deckLoadError ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card/70 px-4 py-8 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-destructive">{deckLoadError}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadDeck()}
            >
              Try again
            </Button>
          </div>
        ) : deck ? (
          activeTab === "details" ? (
            <DeckDetailsView deck={deck} />
          ) : (
            <SimulationView deckName={deck.name} />
          )
        ) : null}
      </section>
    </main>
  )
}

function DeckDetailsView({ deck }: { deck: DeckDetails }) {
  const cardGroups = getDeckCardGroups(deck)
  const [previewCard, setPreviewCard] = useState(
    deck.commanders[0] ?? deck.cards[0] ?? null
  )

  return (
    <div className="grid gap-7 sm:grid-cols-[12rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="sm:sticky sm:top-6 sm:self-start">
        <CardPreview card={previewCard} />
      </aside>

      <div className="space-y-6">
        {deck.description?.trim() ? (
          <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
            {deck.description}
          </p>
        ) : null}

        <div className={getCardColumnClassName(cardGroups.length)}>
          {cardGroups.map((group) => (
            <CardList
              key={group.category}
              group={group}
              onPreviewCard={setPreviewCard}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

function CardPreview({ card }: { card: DeckCard | null }) {
  if (!card?.defaultImageUrl) {
    return (
      <div className="hidden aspect-[488/680] w-full place-items-center rounded-lg border border-border bg-card/70 px-4 text-center text-sm text-muted-foreground sm:grid">
        No card image
      </div>
    )
  }

  return (
    <a
      className="hidden overflow-hidden rounded-[5.75%/4.4%] bg-card shadow-2xl shadow-black/30 outline-none sm:block"
      href={card.scryfallUri}
      rel="noreferrer"
      target="_blank"
    >
      <img
        alt={card.name}
        className="block aspect-[488/680] w-full object-cover"
        src={card.defaultImageUrl}
      />
    </a>
  )
}

function CardList({
  group,
  onPreviewCard,
}: {
  group: CardGroup
  onPreviewCard: (card: DeckCard) => void
}) {
  return (
    <section className="mb-9 break-inside-avoid">
      <div className="mb-1 flex items-center gap-2 border-b border-border pb-2">
        <h3 className="text-sm font-semibold text-foreground">
          {getCardCategoryLabel(group.category)} ({countCards(group.cards)})
        </h3>
      </div>
      <ul>
        {group.cards.map((card) => (
          <li
            key={`${card.oracleId}-${group.category}`}
            className="border-b border-border/45"
          >
            <a
              className="group flex min-w-0 items-baseline gap-2 py-1.5 text-sm text-foreground focus:outline-none"
              href={card.scryfallUri}
              onFocus={() => onPreviewCard(card)}
              onMouseEnter={() => onPreviewCard(card)}
              rel="noreferrer"
              target="_blank"
            >
              <span className="w-5 shrink-0 text-right text-muted-foreground">
                {card.quantity}
              </span>
              <span className="truncate decoration-primary decoration-2 underline-offset-3 group-hover:underline group-focus:underline">
                {card.name}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

type CardGroup = {
  category: string
  cards: DeckCard[]
}

function getDeckCardGroups(deck: DeckDetails) {
  return [
    {
      category: "Commander",
      cards: deck.commanders,
    },
    ...groupCardsByCategory(deck.cards),
  ].filter((group) => group.cards.length > 0)
}

function getCardColumnClassName(categoryCount: number) {
  const baseClassName = "gap-9"

  if (categoryCount <= 1) {
    return `${baseClassName} columns-1`
  }

  if (categoryCount === 2) {
    return `${baseClassName} columns-1 lg:columns-2`
  }

  if (categoryCount === 3) {
    return `${baseClassName} columns-1 lg:columns-2 xl:columns-3`
  }

  return `${baseClassName} columns-1 lg:columns-2 xl:columns-3 2xl:columns-4`
}

function groupCardsByCategory(cards: DeckCard[]): CardGroup[] {
  const groups = new Map<string, DeckCard[]>()

  for (const type of CARD_TYPE_DISPLAY_ORDER) {
    groups.set(type, [])
  }

  groups.set(DEFAULT_CARD_CATEGORY, [])

  for (const card of cards) {
    groups.get(getCardCategory(card))?.push(card)
  }

  return Array.from(groups.entries())
    .map(([category, groupedCards]) => ({
      category,
      cards: groupedCards,
    }))
    .filter((group) => group.cards.length > 0)
}

function countCards(cards: DeckCard[]) {
  return cards.reduce((total, card) => total + card.quantity, 0)
}

function getCardCategoryLabel(category: string) {
  return CARD_CATEGORY_LABELS[category] ?? category
}

function getCardCategory(card: DeckCard) {
  const typeLine = card.typeLine ?? ""
  const category = CARD_TYPE_PRIORITY.find((type) =>
    typeLineContainsCardType(typeLine, type)
  )

  return category ?? DEFAULT_CARD_CATEGORY
}

function typeLineContainsCardType(typeLine: string, cardType: string) {
  return new RegExp(`(^|\\s)${cardType}(\\s|$|-)`, "i").test(typeLine)
}

function SimulationView({ deckName }: { deckName: string }) {
  return (
    <div className="grid min-h-[34rem] overflow-hidden rounded-lg border border-border bg-card/70 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="border-b border-border bg-background/35 lg:border-r lg:border-b-0">
        <div className="border-b border-border p-4">
          <Button type="button" className="w-full">
            <Plus data-icon="inline-start" />
            New simulation
          </Button>
        </div>

        <nav className="grid gap-1 p-2" aria-label="Simulations">
          {SIMULATION_PLACEHOLDERS.map((simulation, index) => (
            <button
              key={simulation}
              className={`rounded-md px-3 py-3 text-left text-sm transition-colors ${index === 0
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-muted/45 hover:text-foreground"
                }`}
              type="button"
            >
              {simulation}
            </button>
          ))}
        </nav>
      </aside>

      <section className="flex min-h-[28rem] flex-col">
        <header className="border-b border-border px-5 py-4">
          <p className="text-sm font-medium tracking-[0.16em] text-sky-300 uppercase">
            Simulation
          </p>
          <h2 className="mt-1 text-2xl font-semibold">{deckName}</h2>
        </header>

        <div className="grid flex-1 place-items-center px-5 py-10 text-center">
          <div className="max-w-md space-y-3">
            <Sparkles className="mx-auto size-8 text-sky-300" />
            <h3 className="text-lg font-semibold">Simulation workspace</h3>
            <p className="text-sm leading-6 text-muted-foreground">
              The structure is ready for saved simulations, creation, and the
              active run view. Functionality can plug into this area next.
            </p>
          </div>
        </div>
      </section>
    </div>
  )
}

function TabButton({
  children,
  isActive,
  onClick,
}: {
  children: ReactNode
  isActive: boolean
  onClick: () => void
}) {
  return (
    <button
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${isActive
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-muted/45 hover:text-foreground"
        }`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function CreateDeckModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: () => void
}) {
  const [errors, setErrors] = useState<string[]>([])
  const [isCreating, setIsCreating] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const result = validateAndParseDeckInput({
      name: String(formData.get("name") ?? ""),
      description: String(formData.get("description") ?? ""),
      commanderOne: String(formData.get("commanderOne") ?? ""),
      commanderTwo: String(formData.get("commanderTwo") ?? ""),
      deckList: String(formData.get("deckList") ?? ""),
    })

    if (!result.ok) {
      setErrors(result.errors)
      return
    }

    setErrors([])
    setIsCreating(true)

    try {
      const response = await fetch(`${API_BASE_URL}/decks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(result.deck),
      })

      if (!response.ok) {
        const errorMessage = await readCreateDeckError(response)
        setErrors([errorMessage])
        return
      }

      onCreated()
    } catch {
      setErrors(["Deck could not be sent to the server."])
    } finally {
      setIsCreating(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        aria-labelledby="create-deck-title"
        className="max-h-full w-full max-w-2xl overflow-y-auto rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id="create-deck-title" className="text-xl font-semibold">
              New deck
            </h2>
            <p className="text-sm text-muted-foreground">
              Paste a Commander deck list and add its details.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        </header>

        <form className="grid gap-4 px-5 py-5" onSubmit={handleSubmit}>
          <Field label="Deck name" htmlFor="deck-name">
            <input
              id="deck-name"
              name="name"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              type="text"
            />
          </Field>

          <Field label="Description" htmlFor="deck-description">
            <textarea
              id="deck-description"
              name="description"
              className="min-h-24 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              placeholder="Optional description"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Commander 1" htmlFor="main-commander">
              <input
                id="main-commander"
                name="commanderOne"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                placeholder="The Ur-Dragon"
                type="text"
              />
            </Field>

            <Field label="Commander 2" htmlFor="secondary-commander">
              <input
                id="secondary-commander"
                name="commanderTwo"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                placeholder="Optional partner / background / etc."
                type="text"
              />
            </Field>
          </div>

          <Field label="Deck list" htmlFor="deck-list">
            <textarea
              id="deck-list"
              name="deckList"
              className="min-h-72 w-full resize-y rounded-md border border-input bg-background px-3 py-3 font-mono text-sm text-foreground transition outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/25"
              placeholder="1 Sol Ring&#10;1 Command Tower&#10;1 Arcane Signet"
            />
          </Field>

          {errors.length > 0 ? (
            <div
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              <p className="font-medium">Deck could not be created.</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isCreating}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isCreating}>
              {isCreating ? "Creating..." : "Create deck"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

async function readCreateDeckError(response: Response) {
  try {
    const data = (await response.json()) as {
      error?: unknown
      errors?: unknown
    }

    if (typeof data.error === "string" && data.error.trim()) {
      return data.error
    }

    if (Array.isArray(data.errors)) {
      const errors = data.errors.filter(
        (error): error is string => typeof error === "string" && !!error.trim()
      )

      if (errors.length > 0) {
        return errors.join(" ")
      }
    }
  } catch {
    // Fall through to the generic HTTP error.
  }

  return `Deck could not be created. Server responded with ${response.status}.`
}

function Field({
  children,
  htmlFor,
  label,
}: {
  children: ReactNode
  htmlFor: string
  label: string
}) {
  return (
    <label className="grid gap-2 text-sm font-medium" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
    </label>
  )
}

function usePathname() {
  const [pathname, setPathname] = useState(window.location.pathname)

  useEffect(() => {
    function handleLocationChange() {
      setPathname(window.location.pathname)
    }

    window.addEventListener("popstate", handleLocationChange)
    window.addEventListener("app:navigate", handleLocationChange)

    return () => {
      window.removeEventListener("popstate", handleLocationChange)
      window.removeEventListener("app:navigate", handleLocationChange)
    }
  }, [])

  return pathname
}

function navigateTo(pathname: string) {
  window.history.pushState(null, "", pathname)
  window.dispatchEvent(new Event("app:navigate"))
}

function getDeckIdFromPathname(pathname: string) {
  const match = pathname.match(/^\/decks\/([^/]+)$/)

  return match?.[1] ? decodeURIComponent(match[1]) : null
}

export default App

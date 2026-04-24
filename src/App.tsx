import { useEffect, useState, type ReactNode } from "react"
import { Plus, RefreshCw, X } from "lucide-react"

import { Button } from "@/components/ui/button"

type Deck = {
  id: string
  name: string
}

type DecksResponse = {
  decks: Deck[]
}

const API_BASE_URL = "http://127.0.0.1:3001"

export function App() {
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
                <li
                  key={deck.id}
                  className="px-4 py-4 text-base font-medium text-foreground transition-colors hover:bg-muted/45"
                >
                  {deck.name}
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
        <CreateDeckModal onClose={() => setIsCreateDeckOpen(false)} />
      ) : null}
    </main>
  )
}

function CreateDeckModal({ onClose }: { onClose: () => void }) {
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

        <form className="grid gap-4 px-5 py-5">
          <Field label="Deck name" htmlFor="deck-name">
            <input
              id="deck-name"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              type="text"
            />
          </Field>

          <Field label="Description" htmlFor="deck-description">
            <input
              id="deck-description"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              type="text"
            />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Main commander" htmlFor="main-commander">
              <input
                id="main-commander"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                type="text"
              />
            </Field>

            <Field
              label="Partner, background, or second commander"
              htmlFor="secondary-commander"
            >
              <input
                id="secondary-commander"
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                type="text"
              />
            </Field>
          </div>

          <Field label="Deck list" htmlFor="deck-list">
            <textarea
              id="deck-list"
              className="min-h-72 w-full resize-y rounded-md border border-input bg-background px-3 py-3 font-mono text-sm text-foreground transition outline-none placeholder:text-muted-foreground focus:border-ring focus:ring-3 focus:ring-ring/25"
              placeholder="1 Sol Ring&#10;1 Command Tower&#10;1 Arcane Signet"
            />
          </Field>

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" disabled>
              Create deck
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
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

export default App

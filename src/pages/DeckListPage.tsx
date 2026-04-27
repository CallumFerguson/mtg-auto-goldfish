import { useEffect, useState, type ReactNode } from "react"
import {
  Edit3,
  FileText,
  MoreVertical,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react"

import { DeleteDeckModal } from "@/components/DeleteDeckModal"
import { EditDeckDetailsModal } from "@/components/EditDeckDetailsModal"
import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type { Deck, DecksResponse } from "@/lib/deck-types"
import { navigateTo } from "@/lib/navigation"
import { CreateDeckModal } from "@/pages/CreateDeckModal"

export function DeckListPage() {
  const [decks, setDecks] = useState<Deck[]>([])
  const [isLoadingDecks, setIsLoadingDecks] = useState(true)
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null)
  const [isCreateDeckOpen, setIsCreateDeckOpen] = useState(false)
  const [openMenuDeckId, setOpenMenuDeckId] = useState<string | null>(null)
  const [deckToEdit, setDeckToEdit] = useState<Deck | null>(null)
  const [deckToDelete, setDeckToDelete] = useState<Deck | null>(null)
  const [isDeletingDeck, setIsDeletingDeck] = useState(false)
  const [deleteDeckError, setDeleteDeckError] = useState<string | null>(null)

  async function loadDecks() {
    setIsLoadingDecks(true)
    setDeckLoadError(null)

    try {
      const response = await fetch(`${API_BASE_URL}/decks`)

      if (!response.ok) {
        setDeckLoadError(
          await readApiError(response, "Decks could not be loaded.")
        )
        return
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

  function openDeck(deck: Deck, tab?: "details" | "simulation") {
    navigateTo(`/decks/${deck.id}${tab ? `?tab=${tab}` : ""}`)
  }

  async function handleDeleteDeck() {
    if (!deckToDelete) {
      return
    }

    setIsDeletingDeck(true)
    setDeleteDeckError(null)

    try {
      const response = await fetch(`${API_BASE_URL}/decks/${deckToDelete.id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        setDeleteDeckError(
          await readApiError(response, "Deck could not be deleted.")
        )
        return
      }

      setDecks((currentDecks) =>
        currentDecks.filter((deck) => deck.id !== deckToDelete.id)
      )
      setDeckToDelete(null)
    } catch {
      setDeleteDeckError("Deck could not be deleted.")
    } finally {
      setIsDeletingDeck(false)
    }
  }

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

        <div className="rounded-lg border border-border bg-card/70">
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
                <li key={deck.id} className="relative">
                  <button
                    className="group flex w-full min-w-0 items-center justify-between gap-4 px-4 py-4 pr-16 text-left text-base font-medium text-foreground transition-colors hover:bg-muted/45 focus:bg-muted/45 focus:outline-none"
                    type="button"
                    onClick={() => openDeck(deck)}
                  >
                    <span className="truncate">{deck.name}</span>
                  </button>

                  <div className="absolute inset-y-0 right-3 flex items-center">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Open actions for ${deck.name}`}
                      aria-expanded={openMenuDeckId === deck.id}
                      title="Deck actions"
                      onClick={() =>
                        setOpenMenuDeckId((currentDeckId) =>
                          currentDeckId === deck.id ? null : deck.id
                        )
                      }
                    >
                      <MoreVertical />
                    </Button>

                    {openMenuDeckId === deck.id ? (
                      <>
                        <button
                          className="fixed inset-0 z-10 cursor-default"
                          type="button"
                          aria-label="Close deck actions"
                          onClick={() => setOpenMenuDeckId(null)}
                        />
                        <div className="absolute top-10 right-3 z-20 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40">
                          <MenuButton
                            onClick={() => {
                              setOpenMenuDeckId(null)
                              openDeck(deck, "details")
                            }}
                          >
                            <FileText data-icon="inline-start" />
                            Details
                          </MenuButton>
                          <MenuButton
                            onClick={() => {
                              setOpenMenuDeckId(null)
                              openDeck(deck, "simulation")
                            }}
                          >
                            <Play data-icon="inline-start" />
                            Simulation
                          </MenuButton>
                          <MenuButton
                            onClick={() => {
                              setOpenMenuDeckId(null)
                              setDeckToEdit(deck)
                            }}
                          >
                            <Edit3 data-icon="inline-start" />
                            Edit deck
                          </MenuButton>
                          <MenuButton
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => {
                              setOpenMenuDeckId(null)
                              setDeleteDeckError(null)
                              setDeckToDelete(deck)
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            Delete deck
                          </MenuButton>
                        </div>
                      </>
                    ) : null}
                  </div>
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

      {deckToEdit ? (
        <EditDeckDetailsModal
          deck={deckToEdit}
          onClose={() => setDeckToEdit(null)}
          onUpdated={(updatedDeck) => {
            setDecks((currentDecks) =>
              currentDecks.map((deck) =>
                deck.id === updatedDeck.id ? { ...deck, ...updatedDeck } : deck
              )
            )
            setDeckToEdit(null)
          }}
        />
      ) : null}

      {deckToDelete ? (
        <DeleteDeckModal
          deckName={deckToDelete.name}
          error={deleteDeckError}
          isDeleting={isDeletingDeck}
          onClose={() => {
            if (!isDeletingDeck) {
              setDeckToDelete(null)
              setDeleteDeckError(null)
            }
          }}
          onConfirm={() => void handleDeleteDeck()}
        />
      ) : null}
    </main>
  )
}

function MenuButton({
  children,
  className = "",
  onClick,
}: {
  children: ReactNode
  className?: string
  onClick: () => void
}) {
  return (
    <button
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none ${className}`}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  )
}

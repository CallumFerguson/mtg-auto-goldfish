import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ArrowLeft, Edit3, MoreVertical, Trash2 } from "lucide-react"
import { useNavigate } from "react-router-dom"

import { AccountMenu } from "@/components/AccountMenu"
import { DeleteDeckModal } from "@/components/DeleteDeckModal"
import { EditDeckDetailsModal } from "@/components/EditDeckDetailsModal"
import { Button } from "@/components/ui/button"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type { AuthUser } from "@/lib/auth-client"
import type { DeckDetails, DeckResponse } from "@/lib/deck-types"
import { getDeckSimulationPath, type DeckPageTab } from "@/lib/navigation"
import { DeckSimulation } from "@/pages/DeckSimulation"
import { ViewDeckCards } from "@/pages/ViewDeckCards"

export function DeckPage({
  adminOptionsEnabled,
  deckId,
  isImpersonating,
  initialTab,
  initialSimulationId,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  user,
}: {
  adminOptionsEnabled: boolean
  deckId: string
  isImpersonating: boolean
  initialTab: DeckPageTab
  initialSimulationId: string | null
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
  onStopImpersonating: () => Promise<void> | void
  user: AuthUser
}) {
  const navigate = useNavigate()
  const [deck, setDeck] = useState<DeckDetails | null>(null)
  const [activeTab, setActiveTab] = useState<DeckPageTab>(initialTab)
  const [isLoadingDeck, setIsLoadingDeck] = useState(true)
  const [deckLoadError, setDeckLoadError] = useState<string | null>(null)
  const [isActionsOpen, setIsActionsOpen] = useState(false)
  const [isEditDeckOpen, setIsEditDeckOpen] = useState(false)
  const [isDeleteDeckOpen, setIsDeleteDeckOpen] = useState(false)
  const [isDeletingDeck, setIsDeletingDeck] = useState(false)
  const [deleteDeckError, setDeleteDeckError] = useState<string | null>(null)
  const [usageUpgradeRequestId, setUsageUpgradeRequestId] = useState(0)

  const loadDeck = useCallback(async () => {
    setIsLoadingDeck(true)
    setDeckLoadError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/decks/${deckId}`)

      if (!response.ok) {
        setDeckLoadError(
          await readApiError(response, "Deck could not be loaded.")
        )
        return
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

  useEffect(() => {
    setActiveTab(initialTab)
  }, [initialTab])

  function selectTab(tab: DeckPageTab) {
    setActiveTab(tab)
    navigate(
      tab === "simulation"
        ? getDeckSimulationPath(deckId, initialSimulationId ?? undefined)
        : `/decks/${encodeURIComponent(deckId)}?tab=${tab}`
    )
  }

  async function handleDeleteDeck() {
    setIsDeletingDeck(true)
    setDeleteDeckError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/decks/${deckId}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        setDeleteDeckError(
          await readApiError(response, "Deck could not be deleted.")
        )
        return
      }

      navigate("/")
    } catch {
      setDeleteDeckError("Deck could not be deleted.")
    } finally {
      setIsDeletingDeck(false)
    }
  }

  const isSimulationTab = activeTab === "simulation"
  const shouldShowAdminOptions = user.role === "admin" && adminOptionsEnabled

  return (
    <main className="flex h-svh overflow-hidden bg-background pt-3 text-foreground">
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex flex-col gap-2.5 border-b border-border px-4 pb-4 sm:px-6 lg:px-8">
          <Button
            type="button"
            variant="ghost"
            size="default"
            className="w-fit"
            onClick={() => navigate("/")}
          >
            <ArrowLeft data-icon="inline-start" />
            Decks
          </Button>

          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1.5">
              <p className="text-sm font-medium tracking-[0.18em] text-sky-300 uppercase">
                Deck page
              </p>
              <div className="flex items-center gap-2">
                <h1 className="text-3xl font-semibold text-foreground">
                  {deck?.name ?? "Deck"}
                </h1>
                {deck ? (
                  <div className="relative">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Open actions for ${deck.name}`}
                      aria-expanded={isActionsOpen}
                      title="Deck actions"
                      onClick={() =>
                        setIsActionsOpen((currentValue) => !currentValue)
                      }
                    >
                      <MoreVertical />
                    </Button>

                    {isActionsOpen ? (
                      <>
                        <button
                          className="fixed inset-0 z-10 cursor-default"
                          type="button"
                          aria-label="Close deck actions"
                          onClick={() => setIsActionsOpen(false)}
                        />
                        <div className="absolute top-10 left-0 z-20 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40">
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none"
                            type="button"
                            onClick={() => {
                              setIsActionsOpen(false)
                              setIsEditDeckOpen(true)
                            }}
                          >
                            <Edit3 data-icon="inline-start" />
                            Edit deck
                          </button>
                          <button
                            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:outline-none"
                            type="button"
                            onClick={() => {
                              setIsActionsOpen(false)
                              setDeleteDeckError(null)
                              setIsDeleteDeckOpen(true)
                            }}
                          >
                            <Trash2 data-icon="inline-start" />
                            Delete deck
                          </button>
                        </div>
                      </>
                    ) : null}
                  </div>
                ) : null}
              </div>
              {deck?.description?.trim() ? (
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                  {deck.description}
                </p>
              ) : null}
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <AccountMenu
                adminOptionsEnabled={adminOptionsEnabled}
                isImpersonating={isImpersonating}
                onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
                onSignedOut={onSignedOut}
                onStopImpersonating={onStopImpersonating}
                usageUpgradeRequestId={usageUpgradeRequestId}
                user={user}
              />
              <div className="inline-grid w-full grid-cols-2 rounded-lg border border-border bg-card/70 p-1 sm:w-auto">
                <TabButton
                  isActive={activeTab === "details"}
                  onClick={() => selectTab("details")}
                >
                  Details
                </TabButton>
                <TabButton
                  isActive={activeTab === "simulation"}
                  onClick={() => selectTab("simulation")}
                >
                  Simulation
                </TabButton>
              </div>
            </div>
          </div>
        </header>

        {isSimulationTab ? (
          isLoadingDeck ? (
            <div className="mx-4 mt-6 rounded-lg border border-border bg-card/70 px-4 py-8 text-sm text-muted-foreground sm:mx-6 lg:mx-8">
              Loading deck...
            </div>
          ) : deckLoadError ? (
            <div className="mx-4 mt-6 flex flex-col gap-3 rounded-lg border border-border bg-card/70 px-4 py-8 sm:mx-6 sm:flex-row sm:items-center sm:justify-between lg:mx-8">
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
            <div className="simulation-scrollbar min-h-0 min-w-0 flex-1 overflow-x-auto">
              <DeckSimulation
                canUpgradeUsage={!isImpersonating}
                cards={deck.cards}
                deckId={deck.id}
                isAdmin={shouldShowAdminOptions}
                onUpgradeUsage={() => {
                  setUsageUpgradeRequestId((currentId) => currentId + 1)
                }}
                selectedSimulationIdFromUrl={initialSimulationId}
              />
            </div>
          ) : null
        ) : (
          <div className="simulation-scrollbar min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8">
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
                <ViewDeckCards deck={deck} />
              ) : null}
            </div>
          </div>
        )}
      </section>

      {deck && isDeleteDeckOpen ? (
        <DeleteDeckModal
          deckName={deck.name}
          error={deleteDeckError}
          isDeleting={isDeletingDeck}
          onClose={() => {
            if (!isDeletingDeck) {
              setIsDeleteDeckOpen(false)
              setDeleteDeckError(null)
            }
          }}
          onConfirm={() => void handleDeleteDeck()}
        />
      ) : null}

      {deck && isEditDeckOpen ? (
        <EditDeckDetailsModal
          deck={deck}
          onClose={() => setIsEditDeckOpen(false)}
          onUpdated={(updatedDeck) => {
            setDeck((currentDeck) =>
              currentDeck
                ? {
                    ...currentDeck,
                    ...updatedDeck,
                  }
                : currentDeck
            )
            setIsEditDeckOpen(false)
          }}
        />
      ) : null}
    </main>
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
      className={`rounded-md px-4 py-2 text-sm font-medium transition-colors ${
        isActive
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

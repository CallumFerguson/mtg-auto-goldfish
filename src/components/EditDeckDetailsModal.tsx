import { useState, type FormEvent, type ReactNode } from "react"
import { Save, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type { Deck } from "@/lib/deck-types"

export function EditDeckDetailsModal({
  deck,
  onClose,
  onUpdated,
}: {
  deck: Deck
  onClose: () => void
  onUpdated: (deck: Deck) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const name = String(formData.get("name") ?? "").trim()
    const description = String(formData.get("description") ?? "").trim()

    if (!name) {
      setError("Deck name is required.")
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      const response = await fetch(`${API_BASE_URL}/decks/${deck.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          description,
        }),
      })

      if (!response.ok) {
        setError(
          await readApiError(response, "Deck details could not be updated.")
        )
        return
      }

      const data = (await response.json()) as { deck: Deck }
      onUpdated(data.deck)
    } catch {
      setError("Deck details could not be sent to the server.")
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={isSaving ? undefined : onClose}
    >
      <section
        aria-labelledby="edit-deck-title"
        className="w-full max-w-lg rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id="edit-deck-title" className="text-xl font-semibold">
              Edit deck
            </h2>
            <p className="text-sm text-muted-foreground">
              Update the deck title and description.
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close"
            title="Close"
            onClick={onClose}
            disabled={isSaving}
          >
            <X />
          </Button>
        </header>

        <form className="grid gap-4 px-5 py-5" onSubmit={handleSubmit}>
          <Field label="Deck name" htmlFor="edit-deck-name">
            <input
              id="edit-deck-name"
              name="name"
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              type="text"
              defaultValue={deck.name}
              disabled={isSaving}
            />
          </Field>

          <Field label="Description" htmlFor="edit-deck-description">
            <textarea
              id="edit-deck-description"
              name="description"
              className="min-h-32 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              placeholder="Optional description"
              defaultValue={deck.description ?? ""}
              disabled={isSaving}
            />
          </Field>

          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <div className="flex justify-end gap-2 border-t border-border pt-4">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSaving}>
              <Save data-icon="inline-start" />
              {isSaving ? "Saving..." : "Save changes"}
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

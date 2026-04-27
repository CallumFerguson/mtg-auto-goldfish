import { useState, type FormEvent, type ReactNode } from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import { validateAndParseDeckInput } from "@/lib/deck-input"

export function CreateDeckModal({
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
        setErrors([
          await readApiError(response, "Deck could not be created."),
        ])
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

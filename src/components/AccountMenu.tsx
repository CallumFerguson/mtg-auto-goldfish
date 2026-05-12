import { useState, type FormEvent } from "react"
import {
  KeyRound,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  UserRound,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { authClient, type AuthUser } from "@/lib/auth-client"
import { navigateTo } from "@/lib/navigation"
import { getPasswordRangeError } from "@/lib/password-validation"

export function AccountMenu({
  adminOptionsEnabled,
  onAdminOptionsEnabledChange,
  onSignedOut,
  user,
}: {
  adminOptionsEnabled: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
  user: AuthUser
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const accountLabel =
    user.name && user.name !== user.email ? user.name : "MTG Auto Deck"

  async function handleSignOut() {
    setIsSigningOut(true)

    try {
      await authClient.signOut()
      onSignedOut()
    } finally {
      setIsSigningOut(false)
    }
  }

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Account menu for ${user.email}`}
        aria-expanded={isOpen}
        title={user.email}
        onClick={() => setIsOpen((currentValue) => !currentValue)}
      >
        <UserRound />
      </Button>

      {isOpen ? (
        <>
          <button
            className="fixed inset-0 z-10 cursor-default"
            type="button"
            aria-label="Close account menu"
            onClick={() => setIsOpen(false)}
          />
          <div className="absolute top-11 right-0 z-20 w-64 overflow-hidden rounded-lg border border-border bg-popover py-1 text-popover-foreground shadow-2xl shadow-black/40">
            <div className="border-b border-border px-3 py-2">
              <p className="truncate text-sm font-medium">{user.email}</p>
              <p className="truncate text-xs text-muted-foreground">
                {accountLabel}
              </p>
            </div>
            {user.role === "admin" ? (
              <div className="border-b border-border py-1">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none"
                  type="button"
                  onClick={() => {
                    setIsOpen(false)
                    navigateTo("/admin")
                  }}
                >
                  <LayoutDashboard data-icon="inline-start" />
                  Admin dashboard
                </button>
                <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <ShieldCheck
                        className="size-4 shrink-0 text-sky-300"
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">
                          Admin options
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {adminOptionsEnabled ? "Visible" : "Hidden"}
                        </p>
                      </div>
                    </div>
                    <button
                      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:ring-3 focus:ring-ring/25 focus:outline-none ${
                        adminOptionsEnabled
                          ? "border-sky-300/70 bg-sky-500/70"
                          : "border-border bg-muted/55"
                      }`}
                      type="button"
                      role="switch"
                      aria-checked={adminOptionsEnabled}
                      aria-label="Show admin options"
                      title="Show admin options"
                      onClick={() =>
                        onAdminOptionsEnabledChange(!adminOptionsEnabled)
                      }
                    >
                      <span
                        className={`absolute top-1/2 left-1 size-4 -translate-y-1/2 rounded-full bg-foreground shadow-sm shadow-black/30 transition-transform ${
                          adminOptionsEnabled
                            ? "translate-x-5"
                            : "translate-x-0"
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none"
              type="button"
              onClick={() => {
                setIsOpen(false)
                setIsChangePasswordOpen(true)
              }}
            >
              <KeyRound data-icon="inline-start" />
              Change password
            </button>
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
              type="button"
              onClick={() => void handleSignOut()}
              disabled={isSigningOut}
            >
              <LogOut data-icon="inline-start" />
              {isSigningOut ? "Signing out..." : "Sign out"}
            </button>
          </div>
        </>
      ) : null}

      {isChangePasswordOpen ? (
        <ChangePasswordModal
          onClose={() => setIsChangePasswordOpen(false)}
          onPasswordChanged={() => setIsChangePasswordOpen(false)}
        />
      ) : null}
    </div>
  )
}

function ChangePasswordModal({
  onClose,
  onPasswordChanged,
}: {
  onClose: () => void
  onPasswordChanged: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const formData = new FormData(event.currentTarget)
    const currentPassword = String(formData.get("currentPassword") ?? "")
    const newPassword = String(formData.get("newPassword") ?? "")
    const passwordError = getPasswordRangeError(newPassword, "New password")

    if (passwordError) {
      setError(passwordError)
      return
    }

    setError(null)
    setIsSaving(true)

    try {
      const result = await authClient.changePassword({
        currentPassword,
        newPassword,
        revokeOtherSessions: true,
      })

      if (result.error) {
        setError(
          getAuthErrorMessage(result.error, "Password could not be changed.")
        )
        return
      }

      onPasswordChanged()
    } catch {
      setError("Password could not be changed.")
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
        aria-labelledby="change-password-title"
        className="w-full max-w-md rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="space-y-1">
            <h2 id="change-password-title" className="text-xl font-semibold">
              Change password
            </h2>
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
          <label className="grid gap-2 text-sm font-medium">
            <span>Current password</span>
            <input
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              disabled={isSaving}
            />
          </label>
          <label className="grid gap-2 text-sm font-medium">
            <span>New password</span>
            <input
              className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
              name="newPassword"
              type="password"
              autoComplete="new-password"
              disabled={isSaving}
            />
          </label>

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
              {isSaving ? "Saving..." : "Save password"}
            </Button>
          </div>
        </form>
      </section>
    </div>
  )
}

function getAuthErrorMessage(error: unknown, fallbackMessage: string) {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim()
  ) {
    return error.message
  }

  return fallbackMessage
}

import { useEffect, useState, type FormEvent } from "react"
import {
  ArrowLeft,
  CreditCard,
  ExternalLink,
  Gauge,
  KeyRound,
  LogOut,
  Mail,
  RefreshCw,
  Settings,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react"
import { useNavigate, useSearchParams } from "react-router-dom"

import { AccountMenu } from "@/components/AccountMenu"
import { SignOutConfirmModal } from "@/components/SignOutConfirmModal"
import {
  type PendingBillingAction,
  UpgradeSubscriptionModal,
} from "@/components/UpgradeSubscriptionModal"
import { UsageLimitRows } from "@/components/UsageLimitRows"
import { Button } from "@/components/ui/button"
import { authClient, type AuthUser } from "@/lib/auth-client"
import {
  getAuthErrorMessage,
  getBillingResultNotice,
  getStripeRedirectUrl,
  getStringErrorProperty,
  openStripeBillingPortal,
  refreshStripeBilling,
  startStripeCheckout,
} from "@/lib/billing"
import { useBillingTier, useBillingTierPolling } from "@/lib/billing-tier-state"
import { clearPasswordInputs } from "@/lib/password-form"
import { getPasswordRangeError } from "@/lib/password-validation"
import {
  BILLING_TIER_LABELS,
  isPaidBillingTier,
  type BillingTier,
} from "@/lib/subscription-tiers"
import { useUsageLimits, useUsageLimitsPolling } from "@/lib/usage-limits"

type SettingsPageProps = {
  adminOptionsEnabled: boolean
  isImpersonating: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
  onStopImpersonating: () => Promise<void> | void
  user: AuthUser
}

export function SettingsPage({
  adminOptionsEnabled,
  isImpersonating,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  user,
}: SettingsPageProps) {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [isChangePasswordOpen, setIsChangePasswordOpen] = useState(false)
  const [passwordNotice, setPasswordNotice] = useState<string | null>(null)
  const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false)
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [billingNotice, setBillingNotice] = useState<string | null>(null)
  const [billingActionError, setBillingActionError] = useState<string | null>(
    null
  )
  const [isRefreshingBilling, setIsRefreshingBilling] = useState(false)
  const [pendingBillingAction, setPendingBillingAction] =
    useState<PendingBillingAction>(null)
  const {
    billingTier,
    billingTierError,
    hasLoadedBillingTier,
    refreshBillingTier,
  } = useBillingTier()
  const { refreshUsageLimits } = useUsageLimits()
  const isBillingRefreshDisabled =
    isImpersonating || isRefreshingBilling || pendingBillingAction !== null
  const billingTierLabel =
    !hasLoadedBillingTier && !billingTierError
      ? "Loading..."
      : !hasLoadedBillingTier && billingTierError
        ? "Unavailable"
        : BILLING_TIER_LABELS[billingTier]

  useBillingTierPolling(true)
  useUsageLimitsPolling(true)

  useEffect(() => {
    const billingResult = searchParams.get("billing")

    if (!billingResult) {
      return
    }

    setBillingNotice(getBillingResultNotice(billingResult))
    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete("billing")
    setSearchParams(nextSearchParams, { replace: true })
  }, [searchParams, setSearchParams])

  async function handleSignOut() {
    setIsSigningOut(true)

    try {
      if (isImpersonating) {
        await onStopImpersonating()
      } else {
        await authClient.signOut()
        onSignedOut()
      }

      setIsSignOutConfirmOpen(false)
    } finally {
      setIsSigningOut(false)
    }
  }

  async function handleStartSubscription(plan: "plus" | "pro") {
    setPendingBillingAction(plan)
    setBillingActionError(null)
    setBillingNotice(null)

    try {
      const result = await startStripeCheckout(plan)

      if (result.error) {
        setBillingActionError(
          getAuthErrorMessage(
            result.error,
            "Stripe Checkout could not be started."
          )
        )
        return
      }

      const redirectUrl = getStripeRedirectUrl(result.data)

      if (!redirectUrl) {
        setBillingActionError("Stripe Checkout could not be started.")
        return
      }

      window.location.assign(redirectUrl)
    } catch {
      setBillingActionError("Stripe Checkout could not be started.")
    } finally {
      setPendingBillingAction(null)
    }
  }

  function handleOpenUpgradeModal() {
    setBillingActionError(null)
    setBillingNotice(null)
    setIsUpgradeModalOpen(true)
  }

  async function handleManageSubscription() {
    setPendingBillingAction("portal")
    setBillingActionError(null)
    setBillingNotice(null)

    try {
      const result = await openStripeBillingPortal()

      if (result.error) {
        setBillingActionError(
          getAuthErrorMessage(
            result.error,
            "Stripe Billing Portal could not be opened."
          )
        )
        return
      }

      const redirectUrl = getStripeRedirectUrl(result.data)

      if (!redirectUrl) {
        setBillingActionError("Stripe Billing Portal could not be opened.")
        return
      }

      window.location.assign(redirectUrl)
    } catch {
      setBillingActionError("Stripe Billing Portal could not be opened.")
    } finally {
      setPendingBillingAction(null)
    }
  }

  async function handleRefreshBilling() {
    setIsRefreshingBilling(true)
    setBillingActionError(null)
    setBillingNotice(null)

    try {
      const refreshResult = await refreshStripeBilling()
      const [nextBillingTier] = await Promise.all([
        refreshBillingTier(),
        refreshUsageLimits(),
      ])
      const refreshedTier = nextBillingTier ?? refreshResult.billingTier

      setBillingNotice(
        `Billing refreshed. Current tier: ${BILLING_TIER_LABELS[refreshedTier]}.`
      )
    } catch (error) {
      setBillingActionError(
        error instanceof Error
          ? error.message
          : "Billing could not be refreshed."
      )
    } finally {
      setIsRefreshingBilling(false)
    }
  }

  return (
    <main className="min-h-svh bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-border pb-5 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-3">
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
            <div className="space-y-1">
              <p className="text-sm font-medium text-sky-300">MTG Auto Deck</p>
              <div className="flex items-center gap-2">
                <Settings className="size-6 text-sky-300" aria-hidden />
                <h1 className="text-3xl font-semibold text-foreground sm:text-4xl">
                  Settings
                </h1>
              </div>
            </div>
          </div>

          <AccountMenu
            adminOptionsEnabled={adminOptionsEnabled}
            isImpersonating={isImpersonating}
            onAdminOptionsEnabledChange={onAdminOptionsEnabledChange}
            onSignedOut={onSignedOut}
            onStopImpersonating={onStopImpersonating}
            user={user}
          />
        </header>

        <div className="grid gap-4">
          <section
            className="overflow-hidden rounded-lg border border-border bg-card/55 shadow-2xl shadow-black/20"
            aria-label="Account settings"
          >
            <div className="flex items-start gap-4 border-b border-border px-5 py-5">
              <Mail
                className="mt-1 size-6 shrink-0 text-foreground"
                aria-hidden
              />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-foreground">Email</p>
                <p className="mt-1 text-xs break-all text-sky-100">
                  {user.email}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-4 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <KeyRound
                  className="mt-1 size-6 shrink-0 text-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    Password
                  </p>
                  <PasswordDots />
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-fit sm:self-center"
                onClick={() => {
                  setPasswordNotice(null)
                  setIsChangePasswordOpen(true)
                }}
              >
                Change password
              </Button>
            </div>
          </section>

          <section
            className="overflow-hidden rounded-lg border border-border bg-card/55 shadow-2xl shadow-black/20"
            aria-label="Billing settings"
          >
            <div className="flex flex-col gap-5 px-5 py-5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 items-start gap-4">
                <CreditCard
                  className="mt-1 size-6 shrink-0 text-foreground"
                  aria-hidden
                />
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">
                      Subscription
                    </p>
                    <p className="mt-1 text-xs text-sky-100">
                      Current tier:{" "}
                      <span className="font-semibold text-foreground">
                        {billingTierLabel}
                      </span>
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    className="mt-0.5"
                    aria-label="Refresh billing"
                    title="Refresh billing"
                    onClick={handleRefreshBilling}
                    disabled={isBillingRefreshDisabled}
                  >
                    <RefreshCw
                      className={isRefreshingBilling ? "animate-spin" : undefined}
                    />
                  </Button>
                </div>
              </div>

              <BillingActions
                billingTier={billingTier}
                isBillingTierReady={hasLoadedBillingTier}
                isImpersonating={isImpersonating}
                isRefreshingBilling={isRefreshingBilling}
                onManageSubscription={handleManageSubscription}
                onOpenUpgradeModal={handleOpenUpgradeModal}
                pendingBillingAction={pendingBillingAction}
              />
            </div>

            <div className="border-t border-border px-5 py-5">
              <div className="flex min-w-0 items-start gap-4">
                <Gauge
                  className="mt-1 size-6 shrink-0 text-foreground"
                  aria-hidden
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">
                    Usage remaining
                  </p>
                  <UsageLimitRows />
                </div>
              </div>
            </div>

            {isImpersonating ? (
              <p className="border-t border-border px-5 py-3 text-xs text-sky-100">
                Billing actions are disabled while impersonating.
              </p>
            ) : null}

            {billingNotice ? (
              <p
                className="border-t border-sky-300/25 bg-sky-400/10 px-5 py-3 text-sm text-sky-100"
                role="status"
              >
                {billingNotice}
              </p>
            ) : null}

            {billingTierError ? (
              <p
                className="border-t border-destructive/40 bg-destructive/10 px-5 py-3 text-sm text-destructive"
                role="alert"
              >
                {billingTierError}
              </p>
            ) : null}

            {billingActionError ? (
              <p
                className="border-t border-destructive/40 bg-destructive/10 px-5 py-3 text-sm text-destructive"
                role="alert"
              >
                {billingActionError}
              </p>
            ) : null}
          </section>

          {passwordNotice ? (
            <p
              className="rounded-md border border-sky-300/30 bg-sky-400/10 px-3 py-2 text-sm text-sky-100"
              role="status"
            >
              {passwordNotice}
            </p>
          ) : null}

          <div>
            <Button
              type="button"
              variant={isImpersonating ? "outline" : "destructive"}
              className={
                isImpersonating
                  ? "border-sky-300/35 bg-sky-400/10 text-sky-50 hover:bg-sky-400/20"
                  : undefined
              }
              onClick={() => setIsSignOutConfirmOpen(true)}
              disabled={isSigningOut}
            >
              {isImpersonating ? (
                <ShieldCheck data-icon="inline-start" />
              ) : (
                <LogOut data-icon="inline-start" />
              )}
              {isImpersonating ? "Stop impersonating" : "Sign out"}
            </Button>
          </div>
        </div>
      </div>

      {isChangePasswordOpen ? (
        <ChangePasswordModal
          onClose={() => setIsChangePasswordOpen(false)}
          onPasswordChanged={() => {
            setIsChangePasswordOpen(false)
            setPasswordNotice("Password changed.")
          }}
        />
      ) : null}
      {isSignOutConfirmOpen ? (
        <SignOutConfirmModal
          isSigningOut={isSigningOut}
          mode={isImpersonating ? "stop-impersonating" : "sign-out"}
          onClose={() => setIsSignOutConfirmOpen(false)}
          onConfirm={() => void handleSignOut()}
        />
      ) : null}
      {isUpgradeModalOpen ? (
        <UpgradeSubscriptionModal
          error={billingActionError}
          currentTier={billingTier}
          isSaving={
            pendingBillingAction === "plus" || pendingBillingAction === "pro"
          }
          onClose={() => setIsUpgradeModalOpen(false)}
          onStartSubscription={handleStartSubscription}
          pendingBillingAction={pendingBillingAction}
        />
      ) : null}
    </main>
  )
}

function BillingActions({
  billingTier,
  isBillingTierReady,
  isImpersonating,
  isRefreshingBilling,
  onManageSubscription,
  onOpenUpgradeModal,
  pendingBillingAction,
}: {
  billingTier: BillingTier
  isBillingTierReady: boolean
  isImpersonating: boolean
  isRefreshingBilling: boolean
  onManageSubscription: () => void
  onOpenUpgradeModal: () => void
  pendingBillingAction: PendingBillingAction
}) {
  const isDisabled =
    !isBillingTierReady ||
    isImpersonating ||
    isRefreshingBilling ||
    pendingBillingAction !== null

  if (isPaidBillingTier(billingTier)) {
    return (
      <div className="flex flex-wrap gap-2 sm:justify-end">
        <Button
          type="button"
          variant="outline"
          className="w-fit sm:self-center"
          onClick={onManageSubscription}
          disabled={isDisabled}
        >
          <ExternalLink data-icon="inline-start" />
          {pendingBillingAction === "portal"
            ? "Opening..."
            : "Manage subscription"}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
      <Button type="button" onClick={onOpenUpgradeModal} disabled={isDisabled}>
        <Sparkles data-icon="inline-start" />
        Upgrade
      </Button>
    </div>
  )
}

function PasswordDots() {
  return (
    <div
      className="mt-2 flex h-3 items-center gap-0.5"
      aria-label="Saved password"
    >
      {Array.from({ length: 12 }, (_, index) => (
        <span
          key={index}
          className="size-1 rounded-full bg-sky-100"
          aria-hidden="true"
        />
      ))}
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
    const form = event.currentTarget
    const formData = new FormData(form)
    const currentPassword = String(formData.get("currentPassword") ?? "")
    const newPassword = String(formData.get("newPassword") ?? "")
    const confirmPassword = String(formData.get("confirmPassword") ?? "")
    let shouldCloseAfterSave = false

    if (!currentPassword) {
      clearPasswordInputs(form)
      setError("Current password is required.")
      return
    }

    const passwordError = getPasswordRangeError(newPassword, "New password")

    if (passwordError) {
      clearPasswordInputs(form)
      setError(passwordError)
      return
    }

    if (newPassword !== confirmPassword) {
      clearPasswordInputs(form)
      setError("New passwords do not match.")
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
        const message = getAuthErrorMessage(
          result.error,
          "Password could not be changed."
        )

        if (isInvalidPasswordError(result.error)) {
          setError("Current password could not be verified.")
          return
        }

        setError(message)
        return
      }

      shouldCloseAfterSave = true
    } catch {
      setError("Password could not be changed.")
    } finally {
      clearPasswordInputs(form)
      setIsSaving(false)
    }

    if (shouldCloseAfterSave) {
      onPasswordChanged()
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
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-sky-300/30 bg-sky-400/10 text-sky-300">
              <KeyRound className="size-4" aria-hidden />
            </div>
            <h2
              id="change-password-title"
              className="truncate text-xl font-semibold"
            >
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

        <div className="grid gap-5 px-5 py-5">
          <form className="grid gap-4" onSubmit={handleSubmit}>
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
            <label className="grid gap-2 text-sm font-medium">
              <span>Confirm new password</span>
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                disabled={isSaving}
              />
            </label>

            <ErrorMessage error={error} />

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
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
        </div>
      </section>
    </div>
  )
}

function ErrorMessage({ error }: { error: string | null }) {
  return error ? (
    <p
      className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
      role="alert"
    >
      {error}
    </p>
  ) : null
}

function isInvalidPasswordError(error: unknown) {
  const code = getStringErrorProperty(error, "code")
  const message = getStringErrorProperty(error, "message")

  return (
    code === "INVALID_PASSWORD" ||
    message?.toLowerCase().includes("invalid password") === true ||
    message?.toLowerCase().includes("current password") === true
  )
}

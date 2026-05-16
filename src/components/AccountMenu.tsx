import { useCallback, useEffect, useRef, useState } from "react"
import {
  ExternalLink,
  Gauge,
  LayoutDashboard,
  LogOut,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react"
import { useNavigate } from "react-router-dom"

import { Button } from "@/components/ui/button"
import { SignOutConfirmModal } from "@/components/SignOutConfirmModal"
import {
  type PendingBillingAction,
  UpgradeSubscriptionModal,
} from "@/components/UpgradeSubscriptionModal"
import { UsageLimitRows } from "@/components/UsageLimitRows"
import { authClient, type AuthUser } from "@/lib/auth-client"
import {
  getAuthErrorMessage,
  getStripeRedirectUrl,
  openStripeBillingPortal,
  startStripeCheckout,
} from "@/lib/billing"
import { useBillingTier, useBillingTierPolling } from "@/lib/billing-tier-state"
import { BILLING_TIER_LABELS } from "@/lib/subscription-tiers"
import { useUsageLimitsPolling } from "@/lib/usage-limits"

export function AccountMenu({
  adminOptionsEnabled,
  isImpersonating,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  usageUpgradeRequestId = 0,
  user,
}: {
  adminOptionsEnabled: boolean
  isImpersonating: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
  onStopImpersonating: () => Promise<void> | void
  usageUpgradeRequestId?: number
  user: AuthUser
}) {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false)
  const [isUpgradeModalOpen, setIsUpgradeModalOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const [billingActionError, setBillingActionError] = useState<string | null>(
    null
  )
  const [pendingBillingAction, setPendingBillingAction] =
    useState<PendingBillingAction>(null)
  const lastHandledUsageUpgradeRequestIdRef = useRef(usageUpgradeRequestId)
  const {
    billingTier,
    billingTierError,
    hasLoadedBillingTier,
    isBillingTierLoading,
  } = useBillingTier()
  const billingTierLabel =
    !hasLoadedBillingTier && !billingTierError
      ? "Loading..."
      : !hasLoadedBillingTier && billingTierError
        ? "Unavailable"
        : `${BILLING_TIER_LABELS[billingTier]} tier`
  const shouldShowUsageUpgradeAction =
    !isImpersonating &&
    hasLoadedBillingTier &&
    (billingTier === "free" || billingTier === "plus")

  useBillingTierPolling(isOpen)
  useUsageLimitsPolling(isOpen)

  const isUpgradeButtonDisabled =
    pendingBillingAction !== null ||
    (!hasLoadedBillingTier && isBillingTierLoading)

  const upgradeModalError =
    billingActionError ??
    (!hasLoadedBillingTier && billingTierError ? billingTierError : null)

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

  const handleOpenBillingPortal = useCallback(async () => {
    setPendingBillingAction("portal")
    setBillingActionError(null)

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
  }, [])

  const handleUpgradeForMoreUsage = useCallback(() => {
    if (!shouldShowUsageUpgradeAction || isUpgradeButtonDisabled) {
      return
    }

    setBillingActionError(null)

    if (billingTier === "free") {
      setIsOpen(false)
      setIsUpgradeModalOpen(true)
      return
    }

    if (billingTier === "plus") {
      void handleOpenBillingPortal()
    }
  }, [
    billingTier,
    handleOpenBillingPortal,
    isUpgradeButtonDisabled,
    setIsOpen,
    shouldShowUsageUpgradeAction,
  ])

  useEffect(() => {
    if (usageUpgradeRequestId === lastHandledUsageUpgradeRequestIdRef.current) {
      return
    }

    lastHandledUsageUpgradeRequestIdRef.current = usageUpgradeRequestId

    if (usageUpgradeRequestId > 0) {
      handleUpgradeForMoreUsage()
    }
  }, [handleUpgradeForMoreUsage, usageUpgradeRequestId])

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="icon"
        aria-label={`Account menu for ${user.email}`}
        aria-expanded={isOpen}
        title={user.email}
        onClick={() => setIsOpen(!isOpen)}
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
            <div className="border-b border-border">
              <div className="px-3 py-2">
                <p className="truncate text-sm font-medium">{user.email}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {billingTierLabel}
                </p>
              </div>
              <div className="border-t border-border px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-xs font-semibold text-foreground">
                  <Gauge
                    className="size-3.5 shrink-0 text-foreground"
                    aria-hidden
                  />
                  <span className="truncate">Usage remaining</span>
                </div>
                <UsageLimitRows className="mt-1.5" />
                {shouldShowUsageUpgradeAction ? (
                  <button
                    className="mt-0.5 grid h-7 w-[calc(100%+0.5rem)] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md pr-2 text-left text-xs font-bold text-foreground transition-colors hover:bg-muted/55 focus:bg-muted/55 focus:outline-none disabled:cursor-not-allowed disabled:opacity-70"
                    type="button"
                    onClick={handleUpgradeForMoreUsage}
                    disabled={isUpgradeButtonDisabled}
                  >
                    <span className="truncate pl-4">
                      Upgrade for more usage
                    </span>
                    <ExternalLink
                      className="size-3.5 shrink-0 justify-self-end"
                      aria-hidden
                    />
                  </button>
                ) : null}
                {billingActionError ? (
                  <p className="mt-2 text-xs text-destructive" role="alert">
                    {billingActionError}
                  </p>
                ) : null}
              </div>
            </div>
            {user.role === "admin" ? (
              <div className="border-b border-border py-1">
                <button
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/45 hover:text-foreground focus:bg-muted/45 focus:outline-none"
                  type="button"
                  onClick={() => {
                    setIsOpen(false)
                    navigate("/admin")
                  }}
                >
                  <LayoutDashboard data-icon="inline-start" />
                  Admin dashboard
                </button>
                <div className="px-3 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <ShieldCheck
                        className="size-4 shrink-0 text-foreground"
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
                navigate("/settings")
              }}
            >
              <Settings data-icon="inline-start" />
              Settings
            </button>
            <button
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors focus:outline-none disabled:cursor-not-allowed disabled:opacity-70 ${
                isImpersonating
                  ? "text-sky-100 hover:bg-sky-400/10 hover:text-sky-100 focus:bg-sky-400/10"
                  : "text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10"
              }`}
              type="button"
              onClick={() => {
                setIsOpen(false)
                setIsSignOutConfirmOpen(true)
              }}
              disabled={isSigningOut}
            >
              <LogOut data-icon="inline-start" />
              {isImpersonating ? "Stop impersonating" : "Sign out"}
            </button>
          </div>
        </>
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
          currentTier={billingTier}
          error={upgradeModalError}
          isSaving={
            pendingBillingAction === "plus" || pendingBillingAction === "pro"
          }
          onClose={() => setIsUpgradeModalOpen(false)}
          onStartSubscription={handleStartSubscription}
          pendingBillingAction={pendingBillingAction}
        />
      ) : null}
    </div>
  )
}

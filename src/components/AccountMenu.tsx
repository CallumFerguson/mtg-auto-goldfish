import { useEffect, useState } from "react"
import {
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
import { UsageLimitRows } from "@/components/UsageLimitRows"
import { authClient, type AuthUser } from "@/lib/auth-client"
import {
  BILLING_TIER_LABELS,
  getActiveBillingSubscription,
  getBillingTierFromSubscription,
  type BillingTier,
} from "@/lib/subscription-tiers"
import { useUsageLimitsPolling } from "@/lib/usage-limits"

export function AccountMenu({
  adminOptionsEnabled,
  isImpersonating,
  onAdminOptionsEnabledChange,
  onSignedOut,
  onStopImpersonating,
  user,
}: {
  adminOptionsEnabled: boolean
  isImpersonating: boolean
  onAdminOptionsEnabledChange: (isEnabled: boolean) => void
  onSignedOut: () => void
  onStopImpersonating: () => Promise<void> | void
  user: AuthUser
}) {
  const navigate = useNavigate()
  const [isOpen, setIsOpen] = useState(false)
  const [billingTier, setBillingTier] = useState<BillingTier>("free")
  const [isBillingTierLoading, setIsBillingTierLoading] = useState(false)
  const [billingTierError, setBillingTierError] = useState(false)
  const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)
  const billingTierLabel = isBillingTierLoading
    ? "Loading..."
    : billingTierError
      ? "Unavailable"
      : `${BILLING_TIER_LABELS[billingTier]} tier`

  useUsageLimitsPolling(isOpen)

  useEffect(() => {
    if (!isOpen) {
      return
    }

    let isMounted = true

    async function loadBillingTier() {
      setIsBillingTierLoading(true)
      setBillingTierError(false)

      try {
        const result = await authClient.subscription.list({
          query: {},
        })

        if (result.error) {
          if (isMounted) {
            setBillingTierError(true)
          }
          return
        }

        const subscriptions = Array.isArray(result.data) ? result.data : []
        const activeSubscription = getActiveBillingSubscription(subscriptions)

        if (isMounted) {
          setBillingTier(getBillingTierFromSubscription(activeSubscription))
        }
      } catch {
        if (isMounted) {
          setBillingTierError(true)
        }
      } finally {
        if (isMounted) {
          setIsBillingTierLoading(false)
        }
      }
    }

    void loadBillingTier()

    return () => {
      isMounted = false
    }
  }, [isOpen, user.id])

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
                  <span className="truncate">Rate limits remaining</span>
                </div>
                <UsageLimitRows className="mt-1.5" />
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
    </div>
  )
}

import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { isPaidBillingTier, type BillingTier } from "@/lib/subscription-tiers"

export type PendingBillingAction = BillingTier | "portal" | null

type PricingPlan = {
  cadence: string
  cta: string
  description: string
  features: string[]
  name: string
  price: string
  tier: BillingTier
}

const PRICING_PLANS = [
  {
    name: "Free",
    price: "$0",
    cadence: "/mo",
    description: "A simple way to try AI-driven goldfishing.",
    features: [
      "Limited access to basic simulations",
      "Run 1 simulation at a time",
    ],
    cta: "Current tier",
    tier: "free",
  },
  {
    name: "Plus",
    price: "$4.99",
    cadence: "/mo",
    description: "More room to test and iterate.",
    features: [
      "Access to more intelligent simulations",
      "Run up to 2 simulations at a time",
    ],
    cta: "Upgrade to Plus",
    tier: "plus",
  },
  {
    name: "Pro",
    price: "$9.99",
    cadence: "/mo",
    description: "Test and iterate faster.",
    features: [
      "Access to the most intelligent simulations",
      "Higher usage limits",
      "Run up to 5 simulations at a time",
    ],
    cta: "Upgrade to Pro",
    tier: "pro",
  },
] satisfies PricingPlan[]

export function UpgradeSubscriptionModal({
  currentTier,
  error,
  isSaving,
  onClose,
  onStartSubscription,
  pendingBillingAction,
}: {
  currentTier: BillingTier
  error: string | null
  isSaving: boolean
  onClose: () => void
  onStartSubscription: (plan: "plus" | "pro") => void
  pendingBillingAction: PendingBillingAction
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 px-4 py-6 backdrop-blur-sm"
      role="presentation"
      onMouseDown={isSaving ? undefined : onClose}
    >
      <section
        aria-labelledby="upgrade-subscription-title"
        className="max-h-[calc(100svh-3rem)] w-full max-w-5xl overflow-y-auto rounded-lg border border-border bg-card shadow-2xl shadow-black/40"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0 space-y-2">
            <p className="text-xs font-black tracking-[0.14em] text-sky-300 uppercase">
              Pricing
            </p>
            <h2
              id="upgrade-subscription-title"
              className="text-3xl font-semibold text-foreground sm:text-4xl"
            >
              Choose a tier
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

        <div className="grid gap-4 px-5 py-5 md:grid-cols-3">
          {PRICING_PLANS.map((plan) => (
            <PricingPlanCard
              key={plan.tier}
              currentTier={currentTier}
              isSaving={isSaving}
              onStartSubscription={onStartSubscription}
              pendingBillingAction={pendingBillingAction}
              plan={plan}
            />
          ))}
        </div>

        {error ? (
          <p
            className="border-t border-destructive/40 bg-destructive/10 px-5 py-3 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
      </section>
    </div>
  )
}

function PricingPlanCard({
  currentTier,
  isSaving,
  onStartSubscription,
  pendingBillingAction,
  plan,
}: {
  currentTier: BillingTier
  isSaving: boolean
  onStartSubscription: (plan: "plus" | "pro") => void
  pendingBillingAction: PendingBillingAction
  plan: PricingPlan
}) {
  const isCurrent = currentTier === plan.tier
  const canStartSubscription = isPaidBillingTier(plan.tier)
  const isPlanOpening = pendingBillingAction === plan.tier
  const cta = isPlanOpening ? "Opening..." : plan.cta
  const handleSelect = () => {
    if (isPaidBillingTier(plan.tier)) {
      onStartSubscription(plan.tier)
    }
  }

  return (
    <article className="flex min-h-[31rem] flex-col rounded-lg border border-border bg-background/70 p-5 shadow-2xl shadow-black/10">
      <h3 className="text-lg font-semibold text-foreground">{plan.name}</h3>
      <p className="mt-3 min-h-12 text-sm text-muted-foreground">
        {plan.description}
      </p>
      <p className="mt-4 flex items-baseline gap-1">
        <span className="text-5xl leading-none font-black text-foreground">
          {plan.price}
        </span>
        <small className="text-base font-extrabold text-sky-100/60">
          {plan.cadence}
        </small>
      </p>
      <ul className="mt-7 grid list-none gap-3 p-0 text-sm text-muted-foreground">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-3">
            <span
              className="mt-2 size-2 shrink-0 rounded-full bg-sky-400"
              aria-hidden
            />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
      <div className="mt-auto pt-8">
        <Button
          type="button"
          variant={canStartSubscription ? "default" : "outline"}
          className={
            canStartSubscription
              ? "w-full"
              : "w-full border-sky-300/35 bg-sky-400/10 text-sky-50 hover:bg-sky-400/20"
          }
          onClick={canStartSubscription ? handleSelect : undefined}
          disabled={isSaving || isCurrent || !canStartSubscription}
        >
          {cta}
        </Button>
      </div>
    </article>
  )
}

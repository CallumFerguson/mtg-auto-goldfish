export const BILLING_TIER_LIMITS = {
  free: {
    maxTurnSimulationsPerDay: 3,
  },
  plus: {
    maxTurnSimulationsPerDay: 25,
  },
  pro: {
    maxTurnSimulationsPerDay: 100,
  },
} as const

export type BillingTier = keyof typeof BILLING_TIER_LIMITS

export const BILLING_TIER_LABELS = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
} satisfies Record<BillingTier, string>

export function isPaidBillingTier(tier: BillingTier) {
  return tier === "plus" || tier === "pro"
}

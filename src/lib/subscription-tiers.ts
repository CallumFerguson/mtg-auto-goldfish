export type BillingTier = "free" | "plus" | "pro"

export const BILLING_TIER_LABELS = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
} satisfies Record<BillingTier, string>

export function isPaidBillingTier(tier: BillingTier): tier is "plus" | "pro" {
  return tier === "plus" || tier === "pro"
}

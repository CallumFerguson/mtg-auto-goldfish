import type { StripePlan } from "@better-auth/stripe"

export const BILLING_TIER_LIMITS = {
  free: {
    maxConcurrentLlmRuns: 1,
  },
  plus: {
    maxConcurrentLlmRuns: 2,
  },
  pro: {
    maxConcurrentLlmRuns: 5,
  },
} as const

export type BillingTier = keyof typeof BILLING_TIER_LIMITS
export type BillingUsageLimitWindowKind = "five_hour" | "weekly"

export const BILLING_TIER_USAGE_LIMITS_USD = {
  free: {
    five_hour: 0.1,
    weekly: 0.5,
  },
  plus: {
    five_hour: 1,
    weekly: 5,
  },
  pro: {
    five_hour: 3,
    weekly: 15,
  },
} as const satisfies Record<
  BillingTier,
  Record<BillingUsageLimitWindowKind, number>
>

export function getStripeSubscriptionPlans(): StripePlan[] {
  return [
    {
      name: "plus",
      priceId: getRequiredBillingEnvironmentVariable("STRIPE_PLUS_PRICE_ID"),
      limits: BILLING_TIER_LIMITS.plus,
    },
    {
      name: "pro",
      priceId: getRequiredBillingEnvironmentVariable("STRIPE_PRO_PRICE_ID"),
      limits: BILLING_TIER_LIMITS.pro,
    },
  ]
}

function getRequiredBillingEnvironmentVariable(environmentVariable: string) {
  const value = process.env[environmentVariable]?.trim()

  if (!value) {
    throw new Error(
      `Missing billing environment variable: ${environmentVariable}. Add it to mtg-auto-deck-server/.env.`
    )
  }

  return value
}

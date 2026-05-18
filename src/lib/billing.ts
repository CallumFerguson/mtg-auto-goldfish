import { authClient } from "@/lib/auth-client"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { APP_PUBLIC_URL } from "@/lib/app-url"
import { readApiError } from "@/lib/api-error"
import type { BillingTier } from "@/lib/subscription-tiers"

export function getBillingReturnUrl(result: string) {
  return `${APP_PUBLIC_URL}/settings?billing=${encodeURIComponent(
    result
  )}`
}

export function getBillingResultNotice(result: string) {
  if (result === "success") {
    return "Subscription updated."
  }

  if (result === "cancel") {
    return "Subscription checkout canceled."
  }

  if (result === "portal") {
    return "Billing portal closed."
  }

  return null
}

export async function startStripeCheckout(plan: "plus" | "pro") {
  const result = await requestStripeCheckout(plan)

  if (!isMissingStripeCustomerError(result.error)) {
    return result
  }

  return await requestStripeCheckout(plan)
}

export async function openStripeBillingPortal() {
  return await authClient.subscription.billingPortal({
    disableRedirect: true,
    returnUrl: getBillingReturnUrl("portal"),
  })
}

export async function refreshStripeBilling() {
  const response = await apiFetch(`${API_BASE_URL}/billing/refresh`, {
    cache: "no-store",
    method: "POST",
  })

  if (!response.ok) {
    throw new Error(
      await readApiError(response, "Billing could not be refreshed.")
    )
  }

  return (await response.json()) as {
    activeSubscriptionCount: number
    billingTier: BillingTier
    stripeCustomerId: string
  }
}

export function getStripeRedirectUrl(data: unknown) {
  if (!data || typeof data !== "object") {
    return null
  }

  const url = (data as Record<string, unknown>).url

  return typeof url === "string" && url.trim() ? url : null
}

export function getAuthErrorMessage(error: unknown, fallbackMessage: string) {
  const message = getStringErrorProperty(error, "message")

  return message?.trim() ? message : fallbackMessage
}

export function getStringErrorProperty(error: unknown, property: string) {
  if (error && typeof error === "object") {
    const value = (error as Record<string, unknown>)[property]

    if (typeof value === "string") {
      return value
    }
  }

  return null
}

async function requestStripeCheckout(plan: "plus" | "pro") {
  return await authClient.subscription.upgrade({
    cancelUrl: getBillingReturnUrl("cancel"),
    disableRedirect: true,
    plan,
    returnUrl: getBillingReturnUrl("portal"),
    successUrl: getBillingReturnUrl("success"),
  })
}

function isMissingStripeCustomerError(error: unknown) {
  const code = getStringErrorProperty(error, "code")
  const message = getStringErrorProperty(error, "message")?.toLowerCase()

  return (
    code === "resource_missing" ||
    message?.includes("no such customer") === true
  )
}

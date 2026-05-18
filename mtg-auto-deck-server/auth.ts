import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { stripe } from "@better-auth/stripe"
import { createAuthMiddleware, sessionMiddleware } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { admin, emailOTP } from "better-auth/plugins"
import Stripe from "stripe"

import { getDatabasePool } from "./db.js"
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from "./email.js"
import {
  isConfiguredAutoAdminEmail,
  promoteAdminUserByEmail,
  AUTO_ADMIN_EMAIL_ENVIRONMENT_VARIABLE,
} from "./admin-users-postgres.js"
import {
  getStripeSubscriptionPlans,
  type BillingTier,
} from "./subscription-tiers.js"

const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 5 * 60
const STRIPE_API_VERSION = "2026-03-25.dahlia"
const STRIPE_USER_CUSTOMER_TYPE = "user"
const STRIPE_ORGANIZATION_CUSTOMER_TYPE = "organization"
const ACTIVE_BILLING_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"])
const stripeClient = new Stripe(
  getRequiredEnvironmentVariable("STRIPE_SECRET_KEY"),
  {
    apiVersion: STRIPE_API_VERSION,
  }
)

const staleStripeCustomerRepairPlugin = {
  id: "stale-stripe-customer-repair",
  hooks: {
    before: [
      {
        matcher: (context) =>
          context.path === "/subscription/upgrade" ||
          context.path === "/subscription/billing-portal",
        handler: createAuthMiddleware(
          { use: [sessionMiddleware] },
          async (ctx) => {
            const customerType = getCustomerType(ctx.body)

            if (customerType === STRIPE_ORGANIZATION_CUSTOMER_TYPE) {
              return
            }

            const session = getStripeBillingSession(ctx.context.session)
            const stripeCustomerId = session?.user.stripeCustomerId?.trim()

            if (!session || !stripeCustomerId) {
              return
            }

            const stripeCustomer =
              await retrieveActiveStripeCustomer(stripeCustomerId)

            if (stripeCustomer) {
              return
            }

            const replacementCustomer =
              (await findStripeCustomerByEmail(session.user.email, () => {
                ctx.context.logger.warn(
                  "Stripe customers.search failed, falling back to customers.list"
                )
              })) ?? (await createStripeCustomerForUser(session.user))

            await ctx.context.internalAdapter.updateUser(session.user.id, {
              stripeCustomerId: replacementCustomer.id,
            })

            ctx.context.logger.info(
              `Repaired stale Stripe customer ${stripeCustomerId} for user ${session.user.id}; using ${replacementCustomer.id}`
            )

            const repairedSession = {
              ...session,
              user: {
                ...session.user,
                stripeCustomerId: replacementCustomer.id,
              },
            }

            setSessionStripeCustomerId(
              ctx.context.session,
              replacementCustomer.id
            )

            return {
              context: {
                session: repairedSession,
              },
            }
          }
        ),
      },
    ],
  },
} satisfies BetterAuthPlugin

const passwordChangeNotificationPlugin = {
  id: "password-change-notification",
  hooks: {
    after: [
      {
        matcher: (context) => context.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const user = getPasswordChangeResponseUser(ctx.context.returned)

          if (!user) {
            return
          }

          await sendPasswordChangedNotification(user)
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

const impersonationAuditLogPlugin = {
  id: "impersonation-audit-log",
  hooks: {
    after: [
      {
        matcher: (context) => context.path === "/admin/impersonate-user",
        handler: createAuthMiddleware(async (ctx) => {
          logImpersonationStarted(ctx.context.returned)
        }),
      },
      {
        matcher: (context) => context.path === "/admin/stop-impersonating",
        handler: createAuthMiddleware(async (ctx) => {
          logImpersonationStopped(ctx.context, ctx.context.returned)
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

const configuredAutoAdminPromotionPlugin = {
  id: "configured-auto-admin-promotion",
  hooks: {
    after: [
      {
        matcher: (context) =>
          context.path === "/sign-up/email" ||
          context.path === "/admin/create-user",
        handler: createAuthMiddleware(async (ctx) => {
          const user = getAuthResponseUser(ctx.context.returned)

          if (!user?.email || !isConfiguredAutoAdminEmail(user.email)) {
            return
          }

          try {
            const promotion = await promoteAdminUserByEmail(user.email)

            if (promotion?.wasPromoted) {
              console.info("Auto-promoted configured admin user:", {
                email: promotion.email,
                environmentVariable: AUTO_ADMIN_EMAIL_ENVIRONMENT_VARIABLE,
                userId: promotion.id,
              })
            }
          } catch (error) {
            console.error(
              "Failed to auto-promote configured admin user:",
              error
            )
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin

export const auth = betterAuth({
  appName: "MTG Auto Deck",
  baseURL: getRequiredEnvironmentVariable("BETTER_AUTH_URL"),
  database: getDatabasePool(),
  emailAndPassword: {
    enabled: true,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ token, user }) => {
      void sendPasswordResetEmail({
        to: user.email,
        userName: user.name,
        resetUrl: createAppPasswordResetUrl(token),
      }).catch((error: unknown) => {
        console.error("Failed to send password reset email:", error)
      })
    },
    onPasswordReset: async ({ user }) => {
      await sendPasswordChangedNotification(user)
    },
  },
  emailVerification: {
    autoSignInAfterVerification: true,
    sendOnSignUp: true,
    sendOnSignIn: true,
  },
  plugins: [
    emailOTP({
      allowedAttempts: 3,
      expiresIn: 5 * 60,
      otpLength: 6,
      overrideDefaultEmailVerification: true,
      resendStrategy: "rotate",
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "email-verification") {
          throw new Error(`Unsupported email OTP type: ${type}`)
        }

        await sendVerificationCodeEmail({
          code: otp,
          to: email,
        })
      },
    }),
    admin({
      adminRoles: ["admin"],
      defaultRole: "user",
    }),
    staleStripeCustomerRepairPlugin,
    stripe({
      createCustomerOnSignUp: true,
      stripeClient,
      stripeWebhookSecret: getRequiredEnvironmentVariable(
        "STRIPE_WEBHOOK_SECRET"
      ),
      subscription: {
        enabled: true,
        plans: getStripeSubscriptionPlans,
        requireEmailVerification: true,
      },
    }),
    impersonationAuditLogPlugin,
    configuredAutoAdminPromotionPlugin,
    passwordChangeNotificationPlugin,
  ],
  secret: getRequiredEnvironmentVariable("BETTER_AUTH_SECRET"),
  trustedOrigins: getTrustedOrigins(),
})

export async function ensureAuthSchema() {
  const { runMigrations } = await getMigrations(auth.options)

  await runMigrations()
}

export async function isPasswordResetTokenValid(token: string) {
  const context = await auth.$context
  const verification = await context.internalAdapter.findVerificationValue(
    `reset-password:${token}`
  )

  return Boolean(verification && verification.expiresAt > new Date())
}

export async function hasValidEmailVerificationOtp(email: string) {
  const normalizedEmail = email.trim().toLowerCase()

  if (!normalizedEmail) {
    return false
  }

  const context = await auth.$context
  const verification = await context.internalAdapter.findVerificationValue(
    `email-verification-otp-${normalizedEmail}`
  )

  return Boolean(verification && verification.expiresAt > new Date())
}

export async function refreshStripeBillingForUser({
  email,
  id,
}: {
  email: string
  id: string
}) {
  const context = await auth.$context
  const user = await context.adapter.findOne<StripeBillingUser>({
    model: "user",
    where: [
      {
        field: "id",
        value: id,
      },
    ],
  })

  if (!user) {
    throw new Error("User not found.")
  }

  const billingUser = {
    ...user,
    email: user.email || email,
    id,
  }
  const planByPriceId = await getBillingPlanByPriceId()
  const existingCustomer = billingUser.stripeCustomerId
    ? await retrieveActiveStripeCustomer(billingUser.stripeCustomerId)
    : null
  const emailCustomers = await findStripeCustomersByEmail(
    billingUser.email,
    () => {
      context.logger.warn(
        "Stripe customers.search failed during billing refresh, falling back to customers.list"
      )
    }
  )
  const customerSnapshots = await getStripeCustomerSubscriptionSnapshots(
    dedupeStripeCustomers([existingCustomer, ...emailCustomers]),
    planByPriceId
  )
  const selectedSnapshot =
    chooseBestStripeCustomerSnapshot(
      customerSnapshots,
      existingCustomer?.id ?? null
    ) ??
    (await createStripeCustomerSnapshot(
      await createStripeCustomerForUser(billingUser),
      planByPriceId
    ))

  if (billingUser.stripeCustomerId !== selectedSnapshot.customer.id) {
    await context.internalAdapter.updateUser(id, {
      stripeCustomerId: selectedSnapshot.customer.id,
    })
  }

  const localSubscriptions = await context.adapter.findMany<LocalSubscription>({
    model: "subscription",
    where: [
      {
        field: "referenceId",
        value: id,
      },
    ],
  })
  const activeConfiguredSubscriptions =
    selectedSnapshot.configuredSubscriptions.filter(({ stripeSubscription }) =>
      isActiveBillingSubscriptionStatus(stripeSubscription.status)
    )
  const activeConfiguredSubscriptionIds = new Set(
    activeConfiguredSubscriptions.map(
      ({ stripeSubscription }) => stripeSubscription.id
    )
  )

  for (const configuredSubscription of activeConfiguredSubscriptions) {
    await upsertLocalSubscriptionFromStripe({
      context,
      existingSubscription: findLocalSubscriptionByStripeId(
        localSubscriptions,
        configuredSubscription.stripeSubscription.id
      ),
      referenceId: id,
      stripeCustomerId: selectedSnapshot.customer.id,
      stripePlanName: configuredSubscription.billingPlan.name,
      stripeSubscription: configuredSubscription.stripeSubscription,
      stripeSubscriptionItem: configuredSubscription.stripeSubscriptionItem,
    })
  }

  for (const localSubscription of localSubscriptions) {
    const stripeSubscriptionId = localSubscription.stripeSubscriptionId?.trim()

    if (
      stripeSubscriptionId &&
      activeConfiguredSubscriptionIds.has(stripeSubscriptionId)
    ) {
      continue
    }

    const configuredSubscription = stripeSubscriptionId
      ? findConfiguredSubscriptionByStripeId(
          selectedSnapshot.configuredSubscriptions,
          stripeSubscriptionId
        )
      : null

    if (configuredSubscription) {
      await updateLocalSubscriptionFromStripe({
        context,
        existingSubscription: localSubscription,
        referenceId: id,
        stripeCustomerId: selectedSnapshot.customer.id,
        stripePlanName: configuredSubscription.billingPlan.name,
        stripeSubscription: configuredSubscription.stripeSubscription,
        stripeSubscriptionItem: configuredSubscription.stripeSubscriptionItem,
      })
      continue
    }

    if (isActiveLocalBillingSubscription(localSubscription)) {
      await markLocalSubscriptionCanceled(context, localSubscription)
    }
  }

  const billingTier = getHighestBillingTier(
    activeConfiguredSubscriptions.map(
      ({ billingPlan }) => billingPlan.billingTier
    )
  )

  return {
    activeSubscriptionCount: activeConfiguredSubscriptions.length,
    billingTier,
    stripeCustomerId: selectedSnapshot.customer.id,
  }
}

type StripeBillingUser = Record<string, unknown> & {
  email: string
  id: string
  name?: string | null
  stripeCustomerId?: string | null
}

type StripeBillingSession = {
  session: unknown
  user: StripeBillingUser
}

type PasswordChangedNotificationUser = {
  email: string
  name?: string | null
}

type BillingPlan = {
  billingTier: BillingTier
  name: "plus" | "pro"
}

type ConfiguredStripeSubscription = {
  billingPlan: BillingPlan
  stripeSubscription: Stripe.Subscription
  stripeSubscriptionItem: Stripe.SubscriptionItem
}

type StripeCustomerSubscriptionSnapshot = {
  configuredSubscriptions: ConfiguredStripeSubscription[]
  customer: Stripe.Customer
  subscriptions: Stripe.Subscription[]
}

type LocalSubscription = {
  id: string
  plan: string
  referenceId: string
  status: string
  stripeCustomerId?: string | null
  stripeSubscriptionId?: string | null
}

async function retrieveActiveStripeCustomer(stripeCustomerId: string) {
  try {
    const customer = await stripeClient.customers.retrieve(stripeCustomerId)

    return isDeletedStripeCustomer(customer) ? null : customer
  } catch (error) {
    if (isMissingStripeCustomerError(error)) {
      return null
    }

    throw error
  }
}

async function findStripeCustomerByEmail(
  email: string,
  onSearchFallback: () => void
) {
  const customers = await findStripeCustomersByEmail(email, onSearchFallback)

  return customers[0] ?? null
}

async function findStripeCustomersByEmail(
  email: string,
  onSearchFallback: () => void
) {
  try {
    const searchResult = await stripeClient.customers.search({
      query: `email:"${escapeStripeSearchValue(email)}" AND -metadata["customerType"]:"${STRIPE_ORGANIZATION_CUSTOMER_TYPE}"`,
      limit: 100,
    })

    return searchResult.data.filter(isUserStripeCustomer)
  } catch {
    onSearchFallback()
  }

  const customers: Stripe.Customer[] = []

  for await (const customer of stripeClient.customers.list({
    email,
    limit: 100,
  })) {
    if (isUserStripeCustomer(customer)) {
      customers.push(customer)
    }
  }

  return customers
}

async function createStripeCustomerForUser(user: StripeBillingUser) {
  return await stripeClient.customers.create({
    email: user.email,
    name: user.name ?? user.email,
    metadata: {
      customerType: STRIPE_USER_CUSTOMER_TYPE,
      userId: user.id,
    },
  })
}

async function getBillingPlanByPriceId() {
  const planByPriceId = new Map<string, BillingPlan>()

  for (const plan of getStripeSubscriptionPlans()) {
    const name = plan.name.trim().toLowerCase()

    if (name !== "plus" && name !== "pro") {
      continue
    }

    addBillingPlanPrice(planByPriceId, plan.priceId, {
      billingTier: name,
      name,
    })
    addBillingPlanPrice(planByPriceId, plan.annualDiscountPriceId, {
      billingTier: name,
      name,
    })
  }

  return planByPriceId
}

function addBillingPlanPrice(
  planByPriceId: Map<string, BillingPlan>,
  priceId: string | undefined,
  billingPlan: BillingPlan
) {
  if (priceId?.trim()) {
    planByPriceId.set(priceId, billingPlan)
  }
}

async function getStripeCustomerSubscriptionSnapshots(
  customers: readonly Stripe.Customer[],
  planByPriceId: Map<string, BillingPlan>
) {
  const snapshots: StripeCustomerSubscriptionSnapshot[] = []

  for (const customer of customers) {
    snapshots.push(await createStripeCustomerSnapshot(customer, planByPriceId))
  }

  return snapshots
}

async function createStripeCustomerSnapshot(
  customer: Stripe.Customer,
  planByPriceId: Map<string, BillingPlan>
): Promise<StripeCustomerSubscriptionSnapshot> {
  const subscriptions = await listStripeSubscriptionsForCustomer(customer.id)

  return {
    configuredSubscriptions: subscriptions
      .map((subscription) =>
        resolveConfiguredStripeSubscription(subscription, planByPriceId)
      )
      .filter(
        (
          subscription
        ): subscription is ConfiguredStripeSubscription =>
          subscription !== null
      ),
    customer,
    subscriptions,
  }
}

async function listStripeSubscriptionsForCustomer(stripeCustomerId: string) {
  const subscriptions: Stripe.Subscription[] = []

  for await (const subscription of stripeClient.subscriptions.list({
    customer: stripeCustomerId,
    limit: 100,
    status: "all",
  })) {
    subscriptions.push(subscription)
  }

  return subscriptions
}

function resolveConfiguredStripeSubscription(
  stripeSubscription: Stripe.Subscription,
  planByPriceId: Map<string, BillingPlan>
): ConfiguredStripeSubscription | null {
  for (const stripeSubscriptionItem of stripeSubscription.items.data) {
    const priceId = stripeSubscriptionItem.price.id
    const billingPlan = planByPriceId.get(priceId)

    if (billingPlan) {
      return {
        billingPlan,
        stripeSubscription,
        stripeSubscriptionItem,
      }
    }
  }

  return null
}

function chooseBestStripeCustomerSnapshot(
  snapshots: readonly StripeCustomerSubscriptionSnapshot[],
  existingStripeCustomerId: string | null
) {
  const snapshotsWithActiveSubscriptions = snapshots
    .map((snapshot) => ({
      snapshot,
      tierRank: getHighestBillingTierRank(
        snapshot.configuredSubscriptions
          .filter(({ stripeSubscription }) =>
            isActiveBillingSubscriptionStatus(stripeSubscription.status)
          )
          .map(({ billingPlan }) => billingPlan.billingTier)
      ),
    }))
    .filter(({ tierRank }) => tierRank > 0)
    .sort((left, right) => right.tierRank - left.tierRank)

  if (snapshotsWithActiveSubscriptions.length > 0) {
    return snapshotsWithActiveSubscriptions[0].snapshot
  }

  return (
    snapshots.find(
      (snapshot) => snapshot.customer.id === existingStripeCustomerId
    ) ??
    snapshots[0] ??
    null
  )
}

async function upsertLocalSubscriptionFromStripe({
  context,
  existingSubscription,
  referenceId,
  stripeCustomerId,
  stripePlanName,
  stripeSubscription,
  stripeSubscriptionItem,
}: {
  context: Awaited<typeof auth.$context>
  existingSubscription: LocalSubscription | null
  referenceId: string
  stripeCustomerId: string
  stripePlanName: "plus" | "pro"
  stripeSubscription: Stripe.Subscription
  stripeSubscriptionItem: Stripe.SubscriptionItem
}) {
  if (existingSubscription) {
    await updateLocalSubscriptionFromStripe({
      context,
      existingSubscription,
      referenceId,
      stripeCustomerId,
      stripePlanName,
      stripeSubscription,
      stripeSubscriptionItem,
    })
    return
  }

  await context.adapter.create({
    model: "subscription",
    data: buildLocalSubscriptionData({
      referenceId,
      stripeCustomerId,
      stripePlanName,
      stripeSubscription,
      stripeSubscriptionItem,
    }),
  })
}

async function updateLocalSubscriptionFromStripe({
  context,
  existingSubscription,
  referenceId,
  stripeCustomerId,
  stripePlanName,
  stripeSubscription,
  stripeSubscriptionItem,
}: {
  context: Awaited<typeof auth.$context>
  existingSubscription: LocalSubscription
  referenceId: string
  stripeCustomerId: string
  stripePlanName: "plus" | "pro"
  stripeSubscription: Stripe.Subscription
  stripeSubscriptionItem: Stripe.SubscriptionItem
}) {
  await context.adapter.update({
    model: "subscription",
    update: buildLocalSubscriptionData({
      referenceId,
      stripeCustomerId,
      stripePlanName,
      stripeSubscription,
      stripeSubscriptionItem,
    }),
    where: [
      {
        field: "id",
        value: existingSubscription.id,
      },
    ],
  })
}

function buildLocalSubscriptionData({
  referenceId,
  stripeCustomerId,
  stripePlanName,
  stripeSubscription,
  stripeSubscriptionItem,
}: {
  referenceId: string
  stripeCustomerId: string
  stripePlanName: "plus" | "pro"
  stripeSubscription: Stripe.Subscription
  stripeSubscriptionItem: Stripe.SubscriptionItem
}) {
  const periodStart = getUnixTimestampDate(
    getNumberProperty(stripeSubscriptionItem, "current_period_start") ??
      getNumberProperty(stripeSubscription, "current_period_start")
  )
  const periodEnd = getUnixTimestampDate(
    getNumberProperty(stripeSubscriptionItem, "current_period_end") ??
      getNumberProperty(stripeSubscription, "current_period_end")
  )

  return {
    billingInterval: stripeSubscriptionItem.price.recurring?.interval ?? null,
    cancelAt: getUnixTimestampDate(stripeSubscription.cancel_at),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
    canceledAt: getUnixTimestampDate(stripeSubscription.canceled_at),
    endedAt: getUnixTimestampDate(stripeSubscription.ended_at),
    periodEnd,
    periodStart,
    plan: stripePlanName,
    referenceId,
    seats: stripeSubscriptionItem.quantity ?? 1,
    status: stripeSubscription.status,
    stripeCustomerId,
    stripeScheduleId: getStripeSubscriptionScheduleId(stripeSubscription),
    stripeSubscriptionId: stripeSubscription.id,
    trialEnd: getUnixTimestampDate(stripeSubscription.trial_end),
    trialStart: getUnixTimestampDate(stripeSubscription.trial_start),
    updatedAt: new Date(),
  }
}

async function markLocalSubscriptionCanceled(
  context: Awaited<typeof auth.$context>,
  localSubscription: LocalSubscription
) {
  await context.adapter.update({
    model: "subscription",
    update: {
      cancelAtPeriodEnd: false,
      canceledAt: new Date(),
      endedAt: new Date(),
      status: "canceled",
      stripeScheduleId: null,
      updatedAt: new Date(),
    },
    where: [
      {
        field: "id",
        value: localSubscription.id,
      },
    ],
  })
}

function dedupeStripeCustomers(
  customers: readonly (Stripe.Customer | null)[]
) {
  const customerById = new Map<string, Stripe.Customer>()

  for (const customer of customers) {
    if (customer) {
      customerById.set(customer.id, customer)
    }
  }

  return Array.from(customerById.values())
}

function findLocalSubscriptionByStripeId(
  subscriptions: readonly LocalSubscription[],
  stripeSubscriptionId: string
) {
  return (
    subscriptions.find(
      (subscription) =>
        subscription.stripeSubscriptionId === stripeSubscriptionId
    ) ?? null
  )
}

function findConfiguredSubscriptionByStripeId(
  subscriptions: readonly ConfiguredStripeSubscription[],
  stripeSubscriptionId: string
) {
  return (
    subscriptions.find(
      ({ stripeSubscription }) => stripeSubscription.id === stripeSubscriptionId
    ) ?? null
  )
}

function isActiveLocalBillingSubscription(subscription: LocalSubscription) {
  return (
    isActiveBillingSubscriptionStatus(subscription.status) &&
    (subscription.plan.trim().toLowerCase() === "plus" ||
      subscription.plan.trim().toLowerCase() === "pro")
  )
}

function isActiveBillingSubscriptionStatus(status: string) {
  return ACTIVE_BILLING_SUBSCRIPTION_STATUSES.has(status)
}

function getHighestBillingTier(tiers: readonly BillingTier[]): BillingTier {
  if (tiers.includes("pro")) {
    return "pro"
  }

  if (tiers.includes("plus")) {
    return "plus"
  }

  return "free"
}

function getHighestBillingTierRank(tiers: readonly BillingTier[]) {
  return getBillingTierRank(getHighestBillingTier(tiers))
}

function getBillingTierRank(tier: BillingTier) {
  if (tier === "pro") {
    return 2
  }

  if (tier === "plus") {
    return 1
  }

  return 0
}

function getStripeSubscriptionScheduleId(
  stripeSubscription: Stripe.Subscription
) {
  const schedule = stripeSubscription.schedule

  if (!schedule) {
    return null
  }

  return typeof schedule === "string" ? schedule : schedule.id
}

function getUnixTimestampDate(timestamp: number | null | undefined) {
  return typeof timestamp === "number" ? new Date(timestamp * 1000) : null
}

function getNumberProperty(value: unknown, property: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const propertyValue = (value as Record<string, unknown>)[property]

  return typeof propertyValue === "number" ? propertyValue : null
}

function isUserStripeCustomer(customer: Stripe.Customer) {
  return customer.metadata?.customerType !== STRIPE_ORGANIZATION_CUSTOMER_TYPE
}

function getStripeBillingSession(
  session: unknown
): StripeBillingSession | null {
  if (!session || typeof session !== "object") {
    return null
  }

  const sessionRecord = session as { session?: unknown; user?: unknown }
  const userRecord = getRecordProperty(sessionRecord, "user")
  const id = getStringProperty(userRecord, "id")
  const email = getStringProperty(userRecord, "email")

  if (!id || !email) {
    return null
  }

  return {
    session: sessionRecord.session,
    user: {
      ...userRecord,
      email,
      id,
      name: getStringProperty(userRecord, "name"),
      stripeCustomerId: getStringProperty(userRecord, "stripeCustomerId"),
    },
  }
}

function setSessionStripeCustomerId(
  session: unknown,
  stripeCustomerId: string
) {
  const user = getRecordProperty(session, "user")

  if (user) {
    const mutableUser = user as Record<string, unknown>

    mutableUser.stripeCustomerId = stripeCustomerId
  }
}

function getCustomerType(body: unknown) {
  const customerType = getStringProperty(body, "customerType")

  return customerType === STRIPE_ORGANIZATION_CUSTOMER_TYPE
    ? STRIPE_ORGANIZATION_CUSTOMER_TYPE
    : STRIPE_USER_CUSTOMER_TYPE
}

function isDeletedStripeCustomer(
  customer: Stripe.Customer | Stripe.DeletedCustomer
): customer is Stripe.DeletedCustomer {
  return "deleted" in customer && customer.deleted === true
}

function isMissingStripeCustomerError(error: unknown) {
  const code = getStringProperty(error, "code")
  const message = getStringProperty(error, "message")?.toLowerCase()

  return (
    code === "resource_missing" ||
    message?.includes("no such customer") === true
  )
}

function escapeStripeSearchValue(value: string) {
  return value.replace(/"/g, '\\"')
}

async function sendPasswordChangedNotification({
  email,
  name,
}: PasswordChangedNotificationUser) {
  const to = email.trim()

  if (!to) {
    return
  }

  await sendPasswordChangedEmail({
    to,
    userName: name?.trim() || to,
  }).catch((error: unknown) => {
    console.error("Failed to send password changed email:", error)
  })
}

function getPasswordChangeResponseUser(
  response: unknown
): PasswordChangedNotificationUser | null {
  if (!response || typeof response !== "object") {
    return null
  }

  const { user } = response as { user?: unknown }

  if (!user || typeof user !== "object") {
    return null
  }

  const { email, name } = user as { email?: unknown; name?: unknown }

  if (typeof email !== "string") {
    return null
  }

  return {
    email,
    name: typeof name === "string" ? name : null,
  }
}

function logImpersonationStarted(response: unknown) {
  const user = getAuthResponseUser(response)
  const session = getAuthResponseSession(response)

  console.info("Admin impersonation started:", {
    adminUserId: session?.impersonatedBy ?? "unknown",
    targetUserEmail: user?.email ?? null,
    targetUserId: user?.id ?? session?.userId ?? "unknown",
  })
}

function logImpersonationStopped(context: unknown, response: unknown) {
  const contextSession = getAuthResponseSession(
    getRecordProperty(context, "session")
  )
  const contextUser = getAuthResponseUser(getRecordProperty(context, "session"))
  const restoredAdmin = getAuthResponseUser(response)

  console.info("Admin impersonation stopped:", {
    adminUserId:
      restoredAdmin?.id ?? contextSession?.impersonatedBy ?? "unknown",
    targetUserEmail: contextUser?.email ?? null,
    targetUserId: contextUser?.id ?? contextSession?.userId ?? "unknown",
  })
}

function getAuthResponseUser(response: unknown) {
  const user = getRecordProperty(response, "user")
  const id = getStringProperty(user, "id")

  if (!id) {
    return null
  }

  return {
    email: getStringProperty(user, "email"),
    id,
  }
}

function getAuthResponseSession(response: unknown) {
  const session = getRecordProperty(response, "session")
  const impersonatedBy = getStringProperty(session, "impersonatedBy")
  const userId = getStringProperty(session, "userId")

  if (!impersonatedBy && !userId) {
    return null
  }

  return {
    impersonatedBy,
    userId,
  }
}

function getRecordProperty(value: unknown, property: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const propertyValue = (value as Record<string, unknown>)[property]

  return propertyValue && typeof propertyValue === "object"
    ? propertyValue
    : null
}

function getStringProperty(value: unknown, property: string) {
  if (!value || typeof value !== "object") {
    return null
  }

  const propertyValue = (value as Record<string, unknown>)[property]

  return typeof propertyValue === "string" && propertyValue.trim()
    ? propertyValue
    : null
}

function getTrustedOrigins() {
  return [
    normalizeOrigin(getRequiredEnvironmentVariable("APP_PUBLIC_URL")),
    normalizeOrigin(getRequiredEnvironmentVariable("BETTER_AUTH_URL")),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://[::1]:5173",
  ]
}

function createAppPasswordResetUrl(token: string) {
  const url = new URL(
    "/reset-password",
    normalizeOrigin(getRequiredEnvironmentVariable("APP_PUBLIC_URL"))
  )
  url.searchParams.set("token", token)

  return url.toString()
}

function normalizeOrigin(url: string) {
  return new URL(url.trim()).origin
}

function getRequiredEnvironmentVariable(environmentVariable: string) {
  const value = process.env[environmentVariable]?.trim()

  if (!value) {
    throw new Error(
      `Missing server environment variable: ${environmentVariable}. Add it to mtg-auto-deck-server/.env.`
    )
  }

  return value
}

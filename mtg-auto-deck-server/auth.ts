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
import { getStripeSubscriptionPlans } from "./subscription-tiers.js"

const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 5 * 60
const STRIPE_API_VERSION = "2026-03-25.dahlia"
const STRIPE_USER_CUSTOMER_TYPE = "user"
const STRIPE_ORGANIZATION_CUSTOMER_TYPE = "organization"
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

export const auth = betterAuth({
  appName: "MTG Auto Deck",
  baseURL: getRequiredEnvironmentVariable("BETTER_AUTH_URL"),
  database: getDatabasePool(),
  emailAndPassword: {
    enabled: true,
    resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      void sendPasswordResetEmail({
        to: user.email,
        userName: user.name,
        resetUrl: url,
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
  try {
    const searchResult = await stripeClient.customers.search({
      query: `email:"${escapeStripeSearchValue(email)}" AND -metadata["customerType"]:"${STRIPE_ORGANIZATION_CUSTOMER_TYPE}"`,
      limit: 1,
    })

    return searchResult.data[0] ?? null
  } catch {
    onSearchFallback()
  }

  for await (const customer of stripeClient.customers.list({
    email,
    limit: 100,
  })) {
    if (customer.metadata?.customerType !== STRIPE_ORGANIZATION_CUSTOMER_TYPE) {
      return customer
    }
  }

  return null
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
    getRequiredEnvironmentVariable("APP_PUBLIC_URL"),
    getRequiredEnvironmentVariable("BETTER_AUTH_URL"),
    "http://localhost:5173",
    "http://127.0.0.1:5173",
  ]
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

import { betterAuth, type BetterAuthPlugin } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { getMigrations } from "better-auth/db/migration"
import { admin, emailOTP } from "better-auth/plugins"

import { getDatabasePool } from "./db.js"
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from "./email.js"

const PASSWORD_RESET_TOKEN_EXPIRES_IN_SECONDS = 5 * 60

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

type PasswordChangedNotificationUser = {
  email: string
  name?: string | null
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
      `Missing auth environment variable: ${environmentVariable}. Add it to your repo-root .env file.`
    )
  }

  return value
}

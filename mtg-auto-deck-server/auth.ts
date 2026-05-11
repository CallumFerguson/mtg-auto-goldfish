import { betterAuth } from "better-auth"
import { getMigrations } from "better-auth/db/migration"
import { emailOTP } from "better-auth/plugins"

import { getDatabasePool } from "./db.js"
import {
  sendPasswordResetEmail,
  sendVerificationCodeEmail,
} from "./email.js"

export const auth = betterAuth({
  appName: "MTG Auto Deck",
  baseURL: getRequiredEnvironmentVariable("BETTER_AUTH_URL"),
  database: getDatabasePool(),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
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
  ],
  secret: getRequiredEnvironmentVariable("BETTER_AUTH_SECRET"),
  trustedOrigins: getTrustedOrigins(),
})

export async function ensureAuthSchema() {
  const { runMigrations } = await getMigrations(auth.options)

  await runMigrations()
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

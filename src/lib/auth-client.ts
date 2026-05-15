import { createAuthClient } from "better-auth/react"
import { stripeClient } from "@better-auth/stripe/client"
import { adminClient, emailOTPClient } from "better-auth/client/plugins"

import { API_BASE_URL } from "@/lib/api"

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  plugins: [
    emailOTPClient(),
    adminClient(),
    stripeClient({ subscription: true }),
  ],
})

export type AuthUser = {
  email: string
  emailVerified: boolean
  id: string
  name: string
  role?: string | null
}

export type AuthSession = {
  impersonatedBy?: string | null
}

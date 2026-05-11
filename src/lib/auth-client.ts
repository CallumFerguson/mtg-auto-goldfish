import { createAuthClient } from "better-auth/react"
import { emailOTPClient } from "better-auth/client/plugins"

import { API_BASE_URL } from "@/lib/api"

export const authClient = createAuthClient({
  baseURL: API_BASE_URL,
  plugins: [emailOTPClient()],
})

export type AuthUser = {
  email: string
  emailVerified: boolean
  id: string
  name: string
}

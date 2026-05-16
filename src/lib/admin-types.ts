export type AdminUser = {
  id: string
  email: string
  emailVerified: boolean
  name: string
  role: string | null
  banned: boolean
  banReason: string | null
  banExpires: string | null
  recentLlmRunCostUsd: number
  totalLlmRunCostUsd: number
  createdAt: string
  updatedAt: string
}

export type AdminUsersResponse = {
  users: AdminUser[]
  total: number
  recentLlmRunCostUsd: number
  totalLlmRunCostUsd: number
}

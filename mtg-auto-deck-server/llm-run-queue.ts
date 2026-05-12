export type LlmRunQueueCapacityInput = {
  activeOwnerUserIds: readonly (string | null)[]
  candidateOwnerUserId: string | null
  candidateQueuedAt: string | null
  maxConcurrentRuns: number
  maxConcurrentRunsPerUser: number
}

export function canClaimQueuedLlmRunWithCapacity({
  activeOwnerUserIds,
  candidateOwnerUserId,
  candidateQueuedAt,
  maxConcurrentRuns,
  maxConcurrentRunsPerUser,
}: LlmRunQueueCapacityInput) {
  if (candidateQueuedAt === null) {
    return false
  }

  if (activeOwnerUserIds.length >= maxConcurrentRuns) {
    return false
  }

  const activeRunsForOwner = activeOwnerUserIds.filter(
    (ownerUserId) => ownerUserId === candidateOwnerUserId
  ).length

  return activeRunsForOwner < maxConcurrentRunsPerUser
}

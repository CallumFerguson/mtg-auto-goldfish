import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"

import { API_BASE_URL, apiFetch } from "@/lib/api"
import { readApiError } from "@/lib/api-error"
import type {
  UsageLimitsResponse,
  UsageLimitWindow,
} from "@/lib/usage-limit-types"
import {
  UsageLimitsContext,
  type UsageLimitsContextValue,
} from "@/lib/usage-limits"

const USAGE_LIMIT_REFRESH_INTERVAL_MS = 5000

export function UsageLimitsProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null
}) {
  const requestIdRef = useRef(0)
  const prefetchedUserIdRef = useRef<string | null>(null)
  const [usageLimits, setUsageLimits] = useState<UsageLimitWindow[]>([])
  const [isUsageLimitsLoading, setIsUsageLimitsLoading] = useState(false)
  const [usageLimitsError, setUsageLimitsError] = useState<string | null>(null)
  const [pollingRequestCount, setPollingRequestCount] = useState(0)

  useEffect(() => {
    requestIdRef.current += 1
    setUsageLimits([])
    setUsageLimitsError(null)
    setIsUsageLimitsLoading(false)
    prefetchedUserIdRef.current = null
  }, [userId])

  const refreshUsageLimits = useCallback(async () => {
    const requestId = requestIdRef.current + 1
    requestIdRef.current = requestId

    if (!userId) {
      setUsageLimits([])
      setUsageLimitsError(null)
      setIsUsageLimitsLoading(false)
      return []
    }

    setIsUsageLimitsLoading(true)
    setUsageLimitsError(null)

    try {
      const response = await apiFetch(`${API_BASE_URL}/usage-limits`, {
        cache: "no-store",
      })

      if (!response.ok) {
        throw new Error(
          await readApiError(response, "Usage limits could not be loaded.")
        )
      }

      const data = (await response.json()) as UsageLimitsResponse

      if (requestIdRef.current === requestId) {
        setUsageLimits(data.usageLimits)
        setUsageLimitsError(null)
      }

      return data.usageLimits
    } catch (error) {
      if (requestIdRef.current === requestId) {
        setUsageLimitsError(
          error instanceof Error
            ? error.message
            : "Usage limits could not be loaded."
        )
      }

      return []
    } finally {
      if (requestIdRef.current === requestId) {
        setIsUsageLimitsLoading(false)
      }
    }
  }, [userId])

  useEffect(() => {
    if (!userId || prefetchedUserIdRef.current === userId) {
      return
    }

    prefetchedUserIdRef.current = userId
    void refreshUsageLimits()
  }, [refreshUsageLimits, userId])

  const beginUsageLimitsPolling = useCallback(() => {
    setPollingRequestCount((currentCount) => currentCount + 1)

    return () => {
      setPollingRequestCount((currentCount) => Math.max(0, currentCount - 1))
    }
  }, [])

  useEffect(() => {
    if (pollingRequestCount <= 0) {
      return
    }

    void refreshUsageLimits()
    const refreshInterval = window.setInterval(() => {
      void refreshUsageLimits()
    }, USAGE_LIMIT_REFRESH_INTERVAL_MS)

    return () => {
      window.clearInterval(refreshInterval)
    }
  }, [pollingRequestCount, refreshUsageLimits])

  const contextValue = useMemo<UsageLimitsContextValue>(
    () => ({
      beginUsageLimitsPolling,
      isUsageLimitsLoading,
      refreshUsageLimits,
      usageLimits,
      usageLimitsError,
    }),
    [
      beginUsageLimitsPolling,
      isUsageLimitsLoading,
      refreshUsageLimits,
      usageLimits,
      usageLimitsError,
    ]
  )

  return (
    <UsageLimitsContext.Provider value={contextValue}>
      {children}
    </UsageLimitsContext.Provider>
  )
}

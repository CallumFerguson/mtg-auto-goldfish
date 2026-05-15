import {
  createContext,
  useCallback,
  useContext,
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

const USAGE_LIMIT_REFRESH_INTERVAL_MS = 5000

type UsageLimitsContextValue = {
  beginUsageLimitsPolling: () => () => void
  isUsageLimitsLoading: boolean
  refreshUsageLimits: () => Promise<UsageLimitWindow[]>
  usageLimits: UsageLimitWindow[]
  usageLimitsError: string | null
}

const UsageLimitsContext = createContext<UsageLimitsContextValue | null>(null)

export function UsageLimitsProvider({
  children,
  userId,
}: {
  children: ReactNode
  userId: string | null
}) {
  const requestIdRef = useRef(0)
  const [usageLimits, setUsageLimits] = useState<UsageLimitWindow[]>([])
  const [isUsageLimitsLoading, setIsUsageLimitsLoading] = useState(false)
  const [usageLimitsError, setUsageLimitsError] = useState<string | null>(null)
  const [pollingRequestCount, setPollingRequestCount] = useState(0)

  useEffect(() => {
    requestIdRef.current += 1
    setUsageLimits([])
    setUsageLimitsError(null)
    setIsUsageLimitsLoading(false)
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

  const contextValue = useMemo(
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

export function useUsageLimits() {
  const contextValue = useContext(UsageLimitsContext)

  if (!contextValue) {
    throw new Error("useUsageLimits must be used within UsageLimitsProvider.")
  }

  return contextValue
}

export function useUsageLimitsPolling(isActive: boolean) {
  const { beginUsageLimitsPolling } = useUsageLimits()

  useEffect(() => {
    if (!isActive) {
      return
    }

    return beginUsageLimitsPolling()
  }, [beginUsageLimitsPolling, isActive])
}

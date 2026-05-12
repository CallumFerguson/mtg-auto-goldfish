import { useEffect, useState } from "react"

import {
  getAdminDashboardSectionIdFromPathname,
  getDeckIdFromPathname,
  getDeckPageTabFromSearch,
  getDeckSimulationIdFromSearch,
  isAdminPathname,
  navigateTo,
} from "@/lib/navigation"
import { authClient, type AuthUser } from "@/lib/auth-client"
import {
  AdminAccessDeniedPage,
  AdminDashboardPage,
} from "@/pages/AdminDashboardPage"
import { AuthPage, type AuthMode } from "@/pages/AuthPage"
import { DeckListPage } from "@/pages/DeckListPage"
import { DeckPage } from "@/pages/DeckPage"
import { SettingsPage } from "@/pages/SettingsPage"

const ADMIN_OPTIONS_ENABLED_STORAGE_KEY = "mtg-auto-deck.admin-options-enabled"

export function App() {
  const location = useLocation()
  const session = authClient.useSession()
  const [adminOptionsEnabled, setAdminOptionsEnabled] = useState(
    getStoredAdminOptionsEnabled
  )
  const authMode = getAuthModeFromLocation(location.pathname)
  const deckId = getDeckIdFromPathname(location.pathname)
  const handleAuthenticated = async () => {
    await session.refetch()
    navigateTo("/")
  }
  const handleSignedOut = () => {
    void session.refetch()
  }

  if (session.isPending) {
    return (
      <main className="flex min-h-svh items-center justify-center bg-background px-4 text-sm text-muted-foreground">
        Loading account...
      </main>
    )
  }

  if (authMode === "reset-password" && !session.data?.user) {
    return (
      <AuthPage initialMode={authMode} onAuthenticated={handleAuthenticated} />
    )
  }

  if (!session.data?.user) {
    return (
      <AuthPage
        initialMode={authMode ?? "sign-in"}
        onAuthenticated={handleAuthenticated}
      />
    )
  }

  if (!session.data.user.emailVerified) {
    return (
      <AuthPage
        initialEmail={session.data.user.email}
        initialMode="verify-email"
        initialNotice="Enter the verification code we emailed you."
        isVerificationWall
        onAuthenticated={handleAuthenticated}
        onSignedOut={handleSignedOut}
      />
    )
  }

  const user = toAuthUser(session.data.user)
  const handleAdminOptionsEnabledChange = (isEnabled: boolean) => {
    setAdminOptionsEnabled(isEnabled)
    storeAdminOptionsEnabled(isEnabled)
  }

  if (location.pathname === "/settings") {
    return (
      <SettingsPage
        adminOptionsEnabled={adminOptionsEnabled}
        onAdminOptionsEnabledChange={handleAdminOptionsEnabledChange}
        onSignedOut={handleSignedOut}
        user={user}
      />
    )
  }

  if (isAdminPathname(location.pathname)) {
    if (user.role !== "admin") {
      return (
        <AdminAccessDeniedPage
          adminOptionsEnabled={adminOptionsEnabled}
          onAdminOptionsEnabledChange={handleAdminOptionsEnabledChange}
          user={user}
          onSignedOut={handleSignedOut}
        />
      )
    }

    return (
      <AdminDashboardPage
        activeSectionId={getAdminDashboardSectionIdFromPathname(
          location.pathname
        )}
        adminOptionsEnabled={adminOptionsEnabled}
        onAdminOptionsEnabledChange={handleAdminOptionsEnabledChange}
        user={user}
        onSignedOut={handleSignedOut}
      />
    )
  }

  return deckId ? (
    <DeckPage
      adminOptionsEnabled={adminOptionsEnabled}
      deckId={deckId}
      initialTab={getDeckPageTabFromSearch(location.search)}
      initialSimulationId={getDeckSimulationIdFromSearch(location.search)}
      onAdminOptionsEnabledChange={handleAdminOptionsEnabledChange}
      user={user}
      onSignedOut={handleSignedOut}
    />
  ) : (
    <DeckListPage
      adminOptionsEnabled={adminOptionsEnabled}
      onAdminOptionsEnabledChange={handleAdminOptionsEnabledChange}
      user={user}
      onSignedOut={handleSignedOut}
    />
  )
}

function getStoredAdminOptionsEnabled() {
  try {
    return (
      window.localStorage.getItem(ADMIN_OPTIONS_ENABLED_STORAGE_KEY) !== "false"
    )
  } catch {
    return true
  }
}

function storeAdminOptionsEnabled(isEnabled: boolean) {
  try {
    window.localStorage.setItem(
      ADMIN_OPTIONS_ENABLED_STORAGE_KEY,
      String(isEnabled)
    )
  } catch {
    // Local storage is only a convenience for this display preference.
  }
}

function useLocation() {
  const [location, setLocation] = useState({
    pathname: window.location.pathname,
    search: window.location.search,
  })

  useEffect(() => {
    function handleLocationChange() {
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      })
    }

    window.addEventListener("popstate", handleLocationChange)
    window.addEventListener("app:navigate", handleLocationChange)

    return () => {
      window.removeEventListener("popstate", handleLocationChange)
      window.removeEventListener("app:navigate", handleLocationChange)
    }
  }, [])

  return location
}

function getAuthModeFromLocation(pathname: string): AuthMode | null {
  if (pathname === "/sign-up") {
    return "sign-up"
  }

  if (pathname === "/forgot-password") {
    return "forgot-password"
  }

  if (pathname === "/reset-password") {
    return "reset-password"
  }

  if (pathname === "/sign-in") {
    return "sign-in"
  }

  return null
}

function toAuthUser(user: {
  email: string
  emailVerified: boolean
  id: string
  name?: string | null
  role?: string | null
}) {
  return {
    email: user.email,
    emailVerified: user.emailVerified,
    id: user.id,
    name: user.name ?? "",
    role: user.role ?? null,
  } satisfies AuthUser
}

export default App

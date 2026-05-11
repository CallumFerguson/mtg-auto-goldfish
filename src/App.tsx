import { useEffect, useState } from "react"

import {
  getDeckIdFromPathname,
  getDeckPageTabFromSearch,
  getDeckSimulationIdFromSearch,
  navigateTo,
} from "@/lib/navigation"
import { authClient, type AuthUser } from "@/lib/auth-client"
import { AuthPage, type AuthMode } from "@/pages/AuthPage"
import { DeckListPage } from "@/pages/DeckListPage"
import { DeckPage } from "@/pages/DeckPage"

export function App() {
  const location = useLocation()
  const session = authClient.useSession()
  const authMode = getAuthModeFromLocation(location.pathname)
  const deckId = getDeckIdFromPathname(location.pathname)
  const handleAuthenticated = async () => {
    await session.refetch()
    navigateTo("/")
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
        onAuthenticated={handleAuthenticated}
      />
    )
  }

  const user = toAuthUser(session.data.user)
  const handleSignedOut = () => {
    void session.refetch()
  }

  return deckId ? (
    <DeckPage
      deckId={deckId}
      initialTab={getDeckPageTabFromSearch(location.search)}
      initialSimulationId={getDeckSimulationIdFromSearch(location.search)}
      user={user}
      onSignedOut={handleSignedOut}
    />
  ) : (
    <DeckListPage user={user} onSignedOut={handleSignedOut} />
  )
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
}) {
  return {
    email: user.email,
    emailVerified: user.emailVerified,
    id: user.id,
    name: user.name ?? "",
  } satisfies AuthUser
}

export default App

import { useState, type FormEvent } from "react"
import { KeyRound, LogIn, MailCheck, RotateCcw, UserPlus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { navigateTo } from "@/lib/navigation"
import { getPasswordRangeError } from "@/lib/password-validation"

export type AuthMode =
  | "forgot-password"
  | "reset-password"
  | "sign-in"
  | "sign-up"
  | "verify-email"

export function AuthPage({
  initialEmail = "",
  initialMode = "sign-in",
  onAuthenticated,
}: {
  initialEmail?: string
  initialMode?: AuthMode
  onAuthenticated: () => Promise<void> | void
}) {
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [error, setError] = useState<string | null>(getInitialError())
  const [notice, setNotice] = useState<string | null>(getInitialNotice())
  const [verificationEmail, setVerificationEmail] = useState(initialEmail)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isResendingCode, setIsResendingCode] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setNotice(null)

    const formData = new FormData(event.currentTarget)
    const email = String(formData.get("email") ?? "").trim()
    const password = String(formData.get("password") ?? "")
    const otp = String(formData.get("otp") ?? "").trim()
    const passwordError = getPreSubmitPasswordError(mode, password)

    if (passwordError) {
      setError(passwordError)
      return
    }

    setIsSubmitting(true)

    try {
      if (mode === "sign-in") {
        const result = await authClient.signIn.email({
          email,
          password,
          rememberMe: true,
        })

        if (result.error) {
          if (isEmailNotVerifiedError(result.error)) {
            setVerificationEmail(email)
            setMode("verify-email")
            setNotice("A verification code has been sent to your email.")
            return
          }

          setError(getAuthErrorMessage(result.error, "Sign in failed."))
          return
        }

        const session = await waitForSession()

        if (!session) {
          setError(
            "Sign in worked, but the browser did not keep the session cookie. Open the app using the same host as APP_PUBLIC_URL, then try again."
          )
          return
        }

        await onAuthenticated()
        return
      }

      if (mode === "sign-up") {
        const result = await createAccount({ email, password })

        if (result.error) {
          setError(result.error)
          return
        }

        setVerificationEmail(email)
        setMode("verify-email")
        setNotice(
          "Account created. Enter the verification code we emailed you."
        )
        return
      }

      if (mode === "verify-email") {
        if (!verificationEmail) {
          setError("Email address is missing. Start sign in again.")
          return
        }

        const result = await authClient.emailOtp.verifyEmail({
          email: verificationEmail,
          otp,
        })

        if (result.error) {
          setError(
            getAuthErrorMessage(result.error, "Verification code failed.")
          )
          return
        }

        const session = await waitForSession()

        if (!session) {
          setError(
            "Email verified, but the browser did not keep the session cookie. Open the app using the same host as APP_PUBLIC_URL, then sign in."
          )
          setMode("sign-in")
          return
        }

        await onAuthenticated()
        return
      }

      if (mode === "forgot-password") {
        const result = await authClient.requestPasswordReset({
          email,
          redirectTo: `${window.location.origin}/reset-password`,
        })

        if (result.error) {
          setError(
            getAuthErrorMessage(result.error, "Reset email could not be sent.")
          )
          return
        }

        setNotice("If that account exists, a reset link has been sent.")
        return
      }

      const token = new URLSearchParams(window.location.search).get("token")

      if (!token) {
        setError("Password reset token is missing or invalid.")
        return
      }

      const result = await authClient.resetPassword({
        token,
        newPassword: password,
      })

      if (result.error) {
        setError(
          getAuthErrorMessage(result.error, "Password could not be reset.")
        )
        return
      }

      setMode("sign-in")
      navigateTo("/sign-in?reset=success")
    } catch {
      setError("Authentication request failed.")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleResendVerificationCode() {
    if (!verificationEmail) {
      setError("Email address is missing. Start sign in again.")
      return
    }

    setError(null)
    setNotice(null)
    setIsResendingCode(true)

    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: verificationEmail,
        type: "email-verification",
      })

      if (result.error) {
        setError(
          getAuthErrorMessage(
            result.error,
            "Verification code could not be sent."
          )
        )
        return
      }

      setNotice("A new verification code has been sent.")
    } catch {
      setError("Verification code could not be sent.")
    } finally {
      setIsResendingCode(false)
    }
  }

  const isSignIn = mode === "sign-in"
  const isSignUp = mode === "sign-up"
  const isForgotPassword = mode === "forgot-password"
  const isResetPassword = mode === "reset-password"
  const isVerifyEmail = mode === "verify-email"

  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-border bg-card/80 shadow-2xl shadow-black/40">
        <header className="border-b border-border px-6 py-5">
          <p className="text-sm font-medium tracking-[0.18em] text-sky-300 uppercase">
            MTG Auto Deck
          </p>
          <h1 className="mt-2 text-2xl font-semibold">
            {isSignIn
              ? "Sign in"
              : isSignUp
                ? "Create account"
                : isForgotPassword
                  ? "Reset password"
                  : isVerifyEmail
                    ? "Verify email"
                    : "Choose a new password"}
          </h1>
        </header>

        <form className="grid gap-4 px-6 py-6" onSubmit={handleSubmit}>
          {isVerifyEmail ? (
            <div className="rounded-md border border-sky-300/25 bg-sky-400/10 px-3 py-2 text-sm text-sky-100">
              {verificationEmail}
            </div>
          ) : null}

          {!isResetPassword && !isVerifyEmail ? (
            <label className="grid gap-2 text-sm font-medium">
              <span>Email</span>
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                name="email"
                type="email"
                autoComplete="email"
                disabled={isSubmitting}
              />
            </label>
          ) : null}

          {!isForgotPassword && !isVerifyEmail ? (
            <label className="grid gap-2 text-sm font-medium">
              <span>{isResetPassword ? "New password" : "Password"}</span>
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                name="password"
                type="password"
                autoComplete={isSignIn ? "current-password" : "new-password"}
                disabled={isSubmitting}
              />
            </label>
          ) : null}

          {isVerifyEmail ? (
            <label className="grid gap-2 text-sm font-medium">
              <span>Verification code</span>
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm tracking-[0.18em] text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                name="otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                disabled={isSubmitting}
              />
            </label>
          ) : null}

          {error ? (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          {notice ? (
            <p
              className="rounded-md border border-sky-300/30 bg-sky-400/10 px-3 py-2 text-sm text-sky-100"
              role="status"
            >
              {notice}
            </p>
          ) : null}

          <Button type="submit" disabled={isSubmitting}>
            {isSignIn ? (
              <LogIn data-icon="inline-start" />
            ) : isSignUp ? (
              <UserPlus data-icon="inline-start" />
            ) : isVerifyEmail ? (
              <MailCheck data-icon="inline-start" />
            ) : (
              <KeyRound data-icon="inline-start" />
            )}
            {isSubmitting
              ? "Working..."
              : isSignIn
                ? "Sign in"
                : isSignUp
                  ? "Create account"
                  : isVerifyEmail
                    ? "Verify email"
                    : isForgotPassword
                      ? "Send reset link"
                      : "Reset password"}
          </Button>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-sm">
            <button
              className="text-sky-300 transition hover:text-sky-200 focus:ring-2 focus:ring-ring/40 focus:outline-none"
              type="button"
              onClick={() => {
                setError(null)
                setNotice(null)
                setMode(isSignIn ? "sign-up" : "sign-in")
              }}
            >
              {isSignIn ? "Create account" : "Sign in"}
            </button>
            {isVerifyEmail ? (
              <Button
                type="button"
                variant="outline"
                onClick={handleResendVerificationCode}
                disabled={isResendingCode}
              >
                <RotateCcw data-icon="inline-start" />
                {isResendingCode ? "Sending..." : "Resend code"}
              </Button>
            ) : !isResetPassword ? (
              <button
                className="text-muted-foreground transition hover:text-foreground focus:ring-2 focus:ring-ring/40 focus:outline-none"
                type="button"
                onClick={() => {
                  setError(null)
                  setNotice(null)
                  setMode(isForgotPassword ? "sign-in" : "forgot-password")
                }}
              >
                {isForgotPassword ? "Back to sign in" : "Forgot password"}
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </main>
  )
}

async function createAccount({
  email,
  password,
}: {
  email: string
  password: string
}) {
  const response = await apiFetch(`${API_BASE_URL}/api/app-auth/sign-up`, {
    body: JSON.stringify({ email, password }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  })

  if (response.ok) {
    return { error: null }
  }

  return {
    error: await getApiErrorMessage(response, "Account could not be created."),
  }
}

async function getApiErrorMessage(response: Response, fallbackMessage: string) {
  try {
    const body = (await response.json()) as unknown

    if (body && typeof body === "object") {
      const record = body as Record<string, unknown>
      const message = record.error ?? record.message

      if (typeof message === "string" && message.trim()) {
        return message
      }
    }
  } catch {
    return fallbackMessage
  }

  return fallbackMessage
}

function getInitialError() {
  const error = new URLSearchParams(window.location.search).get("error")

  return error ? "Password reset link is invalid or expired." : null
}

function getInitialNotice() {
  const reset = new URLSearchParams(window.location.search).get("reset")

  return reset === "success"
    ? "Password reset. Sign in with your new password."
    : null
}

function getPreSubmitPasswordError(mode: AuthMode, password: string) {
  if (mode === "sign-up") {
    return getPasswordRangeError(password)
  }

  if (mode === "reset-password") {
    return getPasswordRangeError(password, "New password")
  }

  return null
}

function getAuthErrorMessage(error: unknown, fallbackMessage: string) {
  const message = getStringErrorProperty(error, "message")

  return message?.trim() ? message : fallbackMessage
}

function isEmailNotVerifiedError(error: unknown) {
  const status = getNumberErrorProperty(error, "status")
  const code = getStringErrorProperty(error, "code")
  const message = getStringErrorProperty(error, "message")

  return (
    status === 403 ||
    code === "EMAIL_NOT_VERIFIED" ||
    message?.toLowerCase().includes("email not verified") === true
  )
}

function getStringErrorProperty(error: unknown, property: string) {
  if (error && typeof error === "object") {
    const value = (error as Record<string, unknown>)[property]

    if (typeof value === "string") {
      return value
    }
  }

  return null
}

function getNumberErrorProperty(error: unknown, property: string) {
  if (error && typeof error === "object") {
    const value = (error as Record<string, unknown>)[property]

    if (typeof value === "number") {
      return value
    }
  }

  return null
}

async function waitForSession() {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await authClient.getSession()

    if (session.data) {
      return session.data
    }

    await new Promise((resolve) => window.setTimeout(resolve, 150))
  }

  return null
}

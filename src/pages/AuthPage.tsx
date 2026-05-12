import { useEffect, useState, type FormEvent } from "react"
import {
  KeyRound,
  LogIn,
  LogOut,
  MailCheck,
  RotateCcw,
  UserPlus,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { API_BASE_URL, apiFetch } from "@/lib/api"
import { authClient } from "@/lib/auth-client"
import { navigateTo } from "@/lib/navigation"
import { clearPasswordInputs } from "@/lib/password-form"
import { getPasswordRangeError } from "@/lib/password-validation"

export type AuthMode =
  | "forgot-password"
  | "reset-password"
  | "sign-in"
  | "sign-up"
  | "verify-email"

type ResetLinkStatus = "checking" | "invalid" | "unavailable" | "valid"

const INVALID_PASSWORD_RESET_LINK_MESSAGE =
  "This password reset link is no longer valid."

export function AuthPage({
  initialEmail = "",
  initialMode = "sign-in",
  initialNotice,
  isVerificationWall = false,
  onAuthenticated,
  onSignedOut,
}: {
  initialEmail?: string
  initialMode?: AuthMode
  initialNotice?: string
  isVerificationWall?: boolean
  onAuthenticated: () => Promise<void> | void
  onSignedOut?: () => Promise<void> | void
}) {
  const initialResetLinkStatus = getInitialResetLinkStatus(initialMode)
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [error, setError] = useState<string | null>(
    getInitialError(initialMode, initialResetLinkStatus)
  )
  const [notice, setNotice] = useState<string | null>(
    initialNotice ?? getInitialNotice()
  )
  const [resetLinkStatus, setResetLinkStatus] = useState<ResetLinkStatus>(
    initialResetLinkStatus
  )
  const [verificationEmail, setVerificationEmail] = useState(initialEmail)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isResendingCode, setIsResendingCode] = useState(false)
  const [isSigningOut, setIsSigningOut] = useState(false)

  useEffect(() => {
    if (mode !== "reset-password") {
      setResetLinkStatus("valid")
      return
    }

    const token = getPasswordResetToken()

    if (!token || hasPasswordResetErrorParam()) {
      setResetLinkStatus("invalid")
      setError(INVALID_PASSWORD_RESET_LINK_MESSAGE)
      setNotice(null)
      return
    }

    let isActive = true
    setResetLinkStatus("checking")
    setError(null)
    setNotice(null)

    verifyPasswordResetToken(token)
      .then((isValid) => {
        if (!isActive) {
          return
        }

        if (isValid) {
          setResetLinkStatus("valid")
          setError(null)
          return
        }

        setResetLinkStatus("invalid")
        setError(INVALID_PASSWORD_RESET_LINK_MESSAGE)
      })
      .catch(() => {
        if (!isActive) {
          return
        }

        setResetLinkStatus("unavailable")
        setError("Password reset link could not be checked. Refresh the page.")
      })

    return () => {
      isActive = false
    }
  }, [mode])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    setError(null)
    setNotice(null)

    const formData = new FormData(form)
    const email = String(formData.get("email") ?? "").trim()
    const password = String(formData.get("password") ?? "")
    const confirmPassword = String(formData.get("confirmPassword") ?? "")
    const otp = String(formData.get("otp") ?? "").trim()

    if (mode === "reset-password" && resetLinkStatus !== "valid") {
      clearPasswordInputs(form)
      setError(
        resetLinkStatus === "checking"
          ? "Password reset link is still being checked."
          : INVALID_PASSWORD_RESET_LINK_MESSAGE
      )
      return
    }

    const passwordError = getPreSubmitPasswordError(
      mode,
      password,
      confirmPassword
    )

    if (passwordError) {
      clearPasswordInputs(form)
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
            await sendVerificationCode(
              email,
              "A verification code has been sent to your email."
            )
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

        if (!session.user.emailVerified) {
          const emailToVerify = session.user.email || email

          setVerificationEmail(emailToVerify)
          setMode("verify-email")
          await sendVerificationCode(
            emailToVerify,
            "A verification code has been sent to your email."
          )
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

        const session = await waitForSession()

        if (!session) {
          setError(
            "Account created, but the browser did not keep the session cookie. Open the app using the same host as APP_PUBLIC_URL, then sign in."
          )
          return
        }

        if (!session.user.emailVerified) {
          setVerificationEmail(session.user.email || email)
          setMode("verify-email")
          setNotice(
            "Account created. Enter the verification code we emailed you."
          )
        }

        await onAuthenticated()
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

      const token = getPasswordResetToken()

      if (!token) {
        setResetLinkStatus("invalid")
        setError(INVALID_PASSWORD_RESET_LINK_MESSAGE)
        return
      }

      const result = await authClient.resetPassword({
        token,
        newPassword: password,
      })

      if (result.error) {
        const message = getResetPasswordErrorMessage(result.error)

        if (message === INVALID_PASSWORD_RESET_LINK_MESSAGE) {
          setResetLinkStatus("invalid")
        }

        setError(message)
        return
      }

      setMode("sign-in")
      navigateTo("/sign-in?reset=success")
    } catch {
      setError("Authentication request failed.")
    } finally {
      clearPasswordInputs(form)
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
      await sendVerificationCode(
        verificationEmail,
        "A new verification code has been sent."
      )
    } finally {
      setIsResendingCode(false)
    }
  }

  async function handleSignOut() {
    setError(null)
    setNotice(null)
    setIsSigningOut(true)

    try {
      await authClient.signOut()
      await onSignedOut?.()
      navigateTo("/sign-in")
    } catch {
      setError("Sign out failed.")
    } finally {
      setIsSigningOut(false)
    }
  }

  async function sendVerificationCode(email: string, successMessage: string) {
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email,
        type: "email-verification",
      })

      if (result.error) {
        setError(
          getAuthErrorMessage(
            result.error,
            "Verification code could not be sent."
          )
        )
        return false
      }

      setNotice(successMessage)
      return true
    } catch {
      setError("Verification code could not be sent.")
      return false
    }
  }

  const isSignIn = mode === "sign-in"
  const isSignUp = mode === "sign-up"
  const isForgotPassword = mode === "forgot-password"
  const isResetPassword = mode === "reset-password"
  const isVerifyEmail = mode === "verify-email"
  const canUseResetLink = !isResetPassword || resetLinkStatus === "valid"
  const isCheckingResetLink = isResetPassword && resetLinkStatus === "checking"
  const footerAlignment = isVerificationWall ? "justify-end" : "justify-between"

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

          {!isForgotPassword && !isVerifyEmail && canUseResetLink ? (
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

          {isResetPassword && canUseResetLink ? (
            <label className="grid gap-2 text-sm font-medium">
              <span>Confirm new password</span>
              <input
                className="h-10 rounded-md border border-input bg-background px-3 text-sm text-foreground transition outline-none focus:border-ring focus:ring-3 focus:ring-ring/25"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                disabled={isSubmitting}
              />
            </label>
          ) : null}

          {isCheckingResetLink ? (
            <p
              className="rounded-md border border-sky-300/30 bg-sky-400/10 px-3 py-2 text-sm text-sky-100"
              role="status"
            >
              Checking password reset link...
            </p>
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

          {canUseResetLink ? (
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
          ) : null}

          <div
            className={`flex flex-wrap items-center ${footerAlignment} gap-2 border-t border-border pt-4 text-sm`}
          >
            {!isVerificationWall ? (
              <button
                className="text-sky-300 transition hover:text-sky-200 focus:ring-2 focus:ring-ring/40 focus:outline-none"
                type="button"
                onClick={(event) => {
                  const form = event.currentTarget.form

                  if (form) {
                    clearPasswordInputs(form)
                  }

                  setError(null)
                  setNotice(null)
                  setMode(isSignIn ? "sign-up" : "sign-in")
                }}
              >
                {isSignIn ? "Create account" : "Sign in"}
              </button>
            ) : null}
            {isVerifyEmail ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResendVerificationCode}
                  disabled={isResendingCode || isSigningOut}
                >
                  <RotateCcw data-icon="inline-start" />
                  {isResendingCode ? "Sending..." : "Resend code"}
                </Button>
                {isVerificationWall ? (
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void handleSignOut()}
                    disabled={isSubmitting || isResendingCode || isSigningOut}
                  >
                    <LogOut data-icon="inline-start" />
                    {isSigningOut ? "Signing out..." : "Sign out"}
                  </Button>
                ) : null}
              </div>
            ) : !isResetPassword ? (
              <button
                className="text-muted-foreground transition hover:text-foreground focus:ring-2 focus:ring-ring/40 focus:outline-none"
                type="button"
                onClick={(event) => {
                  const form = event.currentTarget.form

                  if (form) {
                    clearPasswordInputs(form)
                  }

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

async function verifyPasswordResetToken(token: string) {
  const response = await apiFetch(
    `${API_BASE_URL}/api/app-auth/password-reset-token/${encodeURIComponent(
      token
    )}`
  )

  if (!response.ok) {
    throw new Error("Password reset token check failed.")
  }

  const body = (await response.json()) as unknown

  return Boolean(
    body &&
    typeof body === "object" &&
    (body as Record<string, unknown>).valid === true
  )
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

function getInitialResetLinkStatus(initialMode: AuthMode): ResetLinkStatus {
  if (initialMode !== "reset-password") {
    return "valid"
  }

  return getPasswordResetToken() && !hasPasswordResetErrorParam()
    ? "checking"
    : "invalid"
}

function getInitialError(
  initialMode: AuthMode,
  initialResetLinkStatus: ResetLinkStatus
) {
  if (
    initialMode === "reset-password" &&
    initialResetLinkStatus === "invalid"
  ) {
    return INVALID_PASSWORD_RESET_LINK_MESSAGE
  }

  return null
}

function getInitialNotice() {
  const reset = new URLSearchParams(window.location.search).get("reset")

  return reset === "success"
    ? "Password reset. Sign in with your new password."
    : null
}

function getPreSubmitPasswordError(
  mode: AuthMode,
  password: string,
  confirmPassword: string
) {
  if (mode === "sign-up") {
    return getPasswordRangeError(password)
  }

  if (mode === "reset-password") {
    return (
      getPasswordRangeError(password, "New password") ??
      (password !== confirmPassword ? "New passwords do not match." : null)
    )
  }

  return null
}

function getAuthErrorMessage(error: unknown, fallbackMessage: string) {
  const message = getStringErrorProperty(error, "message")

  return message?.trim() ? message : fallbackMessage
}

function getResetPasswordErrorMessage(error: unknown) {
  if (isInvalidTokenError(error)) {
    return INVALID_PASSWORD_RESET_LINK_MESSAGE
  }

  return getAuthErrorMessage(error, "Password could not be reset.")
}

function isInvalidTokenError(error: unknown) {
  const code = getStringErrorProperty(error, "code")
  const message = getStringErrorProperty(error, "message")

  return (
    code === "INVALID_TOKEN" ||
    message?.toLowerCase().includes("invalid token") === true ||
    message?.toLowerCase().includes("expired") === true
  )
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

function getPasswordResetToken() {
  return new URLSearchParams(window.location.search).get("token")?.trim() ?? ""
}

function hasPasswordResetErrorParam() {
  return new URLSearchParams(window.location.search).has("error")
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

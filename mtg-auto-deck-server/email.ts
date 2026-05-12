import { createTransport } from "nodemailer"

type SendPasswordResetEmailInput = {
  resetUrl: string
  to: string
  userName: string
}

type SendPasswordChangedEmailInput = {
  to: string
  userName: string
}

type SendVerificationCodeEmailInput = {
  code: string
  to: string
}

export async function sendPasswordResetEmail({
  resetUrl,
  to,
  userName,
}: SendPasswordResetEmailInput) {
  const { from, transporter } = getEmailTransport()
  const displayName = userName.trim() || "there"

  await transporter.sendMail({
    from,
    to,
    subject: "Reset your MTG Auto Deck password",
    text: renderPasswordResetText({ displayName, resetUrl }),
    html: renderPasswordResetHtml({ displayName, resetUrl, to }),
  })
}

export async function sendPasswordChangedEmail({
  to,
  userName,
}: SendPasswordChangedEmailInput) {
  const { from, transporter } = getEmailTransport()
  const displayName = userName.trim() || "there"

  await transporter.sendMail({
    from,
    to,
    subject: "Your MTG Auto Deck password was changed",
    text: renderPasswordChangedText({ displayName }),
    html: renderPasswordChangedHtml({ displayName, to }),
  })
}

export async function sendVerificationCodeEmail({
  code,
  to,
}: SendVerificationCodeEmailInput) {
  const { from, transporter } = getEmailTransport()

  await transporter.sendMail({
    from,
    to,
    subject: `Your MTG Auto Deck code is ${code}`,
    text: renderVerificationCodeText({ code }),
    html: renderVerificationCodeHtml({ code, to }),
  })
}

function renderPasswordResetText({
  displayName,
  resetUrl,
}: {
  displayName: string
  resetUrl: string
}) {
  return `Hi ${displayName},

We received a request to reset the password for your MTG Auto Deck account.

Choose a new password here:
${resetUrl}

This link expires in 5 minutes and can only be used once.

If you did not request this change, you can ignore this email. Your current password will keep working.`
}

function renderPasswordChangedText({ displayName }: { displayName: string }) {
  return `Hi ${displayName},

This is a confirmation that the password for your MTG Auto Deck account was changed.

If this was you, no action is needed.

If you did not make this change, reset your password immediately.`
}

function renderVerificationCodeText({ code }: { code: string }) {
  return `Verify your MTG Auto Deck account with this one-time code:

${code}

This code expires in 5 minutes. If you did not request it, you can ignore this email.`
}

function renderPasswordResetHtml({
  displayName,
  resetUrl,
  to,
}: {
  displayName: string
  resetUrl: string
  to: string
}) {
  return renderEmailLayout({
    previewText: "Choose a new password for your MTG Auto Deck account.",
    to,
    content: `
      ${renderHeadingBlock({
        eyebrow: "Password reset",
        heading: `Hi ${displayName}, choose a new password`,
        body: "We received a request to reset the password for your MTG Auto Deck account. Use the secure link below to continue.",
      })}
      ${renderCtaButton({
        href: resetUrl,
        label: "Reset password",
      })}
      ${renderInfoPanel({
        title: "This link expires in 5 minutes",
        body: "It can only be used once. If it no longer works, request a new password reset email.",
      })}
      ${renderInfoPanel({
        title: "Security note",
        body: "If you did not request this change, you can safely ignore this email. Your current password will keep working.",
      })}
      ${renderFallbackLink(resetUrl)}
    `,
  })
}

function renderPasswordChangedHtml({
  displayName,
  to,
}: {
  displayName: string
  to: string
}) {
  return renderEmailLayout({
    previewText: "Your MTG Auto Deck password was changed.",
    to,
    content: `
      ${renderHeadingBlock({
        eyebrow: "Password changed",
        heading: `Hi ${displayName}, your password was changed`,
        body: "This is a confirmation that the password for your MTG Auto Deck account was changed.",
      })}
      ${renderInfoPanel({
        title: "If this was you",
        body: "No action is needed. You can keep using MTG Auto Deck with your new password.",
      })}
      ${renderInfoPanel({
        title: "If this was not you",
        body: "Reset your password immediately.",
      })}
    `,
  })
}

function renderVerificationCodeHtml({
  code,
  to,
}: {
  code: string
  to: string
}) {
  return renderEmailLayout({
    previewText: "Use this one-time code to verify your MTG Auto Deck account.",
    to,
    content: `
      ${renderHeadingBlock({
        eyebrow: "Email verification",
        heading: "Verify your email address",
        body: "Enter this one-time code in MTG Auto Deck to finish setting up your account.",
      })}
      ${renderCodePanel(code)}
      ${renderInfoPanel({
        title: "This code expires in 5 minutes",
        body: "If you did not create or sign in to an MTG Auto Deck account, no action is needed.",
      })}
    `,
  })
}

function renderEmailLayout({
  content,
  previewText,
  to,
}: {
  content: string
  previewText: string
  to: string
}) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark">
    <meta name="supported-color-schemes" content="dark">
    <title>MTG Auto Deck</title>
  </head>
  <body style="margin: 0; padding: 0; background: #070b14; color: #e5edf8; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">
    <div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent;">
      ${escapeHtml(previewText)}
    </div>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; background: #070b14;">
      <tr>
        <td align="center" style="padding: 40px 16px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width: 100%; max-width: 560px; border-collapse: collapse;">
            <tr>
              <td style="padding: 0 0 18px;">
                <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse: collapse;">
                  <tr>
                    <td width="42" height="42" align="center" style="width: 42px; height: 42px; border-radius: 12px; background: #16a34a; color: #04130a; font-size: 18px; font-weight: 800; line-height: 42px;">
                      M
                    </td>
                    <td style="padding-left: 12px;">
                      <div style="color: #f8fafc; font-size: 16px; font-weight: 700; line-height: 22px;">MTG Auto Deck</div>
                      <div style="color: #8ea0b8; font-size: 13px; line-height: 18px;">AI deck goldfishing</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="background: #0d1320; border: 1px solid #263246; border-radius: 18px; padding: 36px; box-shadow: 0 20px 48px rgba(0, 0, 0, 0.35);">
                ${content}
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 6px 0; color: #718096; font-size: 12px; line-height: 18px;">
                This message was sent to ${escapeHtml(to)} for your MTG Auto Deck account.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function renderHeadingBlock({
  body,
  eyebrow,
  heading,
}: {
  body: string
  eyebrow: string
  heading: string
}) {
  return `
    <div style="color: #34d399; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; line-height: 16px; text-transform: uppercase;">${escapeHtml(eyebrow)}</div>
    <h1 style="margin: 10px 0 0; color: #f8fafc; font-size: 28px; font-weight: 800; line-height: 34px;">${escapeHtml(heading)}</h1>
    <p style="margin: 16px 0 0; color: #cbd5e1; font-size: 16px; line-height: 25px;">${escapeHtml(body)}</p>
  `
}

function renderCtaButton({ href, label }: { href: string; label: string }) {
  const escapedHref = escapeHtml(href)

  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin: 28px 0 0; border-collapse: collapse;">
      <tr>
        <td style="border-radius: 10px; background: #22c55e;">
          <a href="${escapedHref}" style="display: inline-block; padding: 14px 22px; color: #04130a; font-size: 15px; font-weight: 800; line-height: 18px; text-decoration: none;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>
  `
}

function renderCodePanel(code: string) {
  return `
    <div style="margin: 28px 0 0; border-radius: 14px; border: 1px solid #2f3d54; background: #111827; padding: 24px; text-align: center;">
      <div style="color: #94a3b8; font-size: 12px; font-weight: 800; letter-spacing: 0.12em; line-height: 16px; text-transform: uppercase;">Verification code</div>
      <div style="margin-top: 10px; color: #f8fafc; font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', monospace; font-size: 34px; font-weight: 800; letter-spacing: 0.18em; line-height: 42px;">${escapeHtml(code)}</div>
    </div>
  `
}

function renderInfoPanel({ body, title }: { body: string; title: string }) {
  return `
    <div style="margin: 24px 0 0; border-left: 3px solid #38bdf8; background: #0f172a; border-radius: 10px; padding: 14px 16px;">
      <div style="color: #e2e8f0; font-size: 14px; font-weight: 800; line-height: 20px;">${escapeHtml(title)}</div>
      <div style="margin-top: 4px; color: #aab8cc; font-size: 14px; line-height: 22px;">${escapeHtml(body)}</div>
    </div>
  `
}

function renderFallbackLink(url: string) {
  const escapedUrl = escapeHtml(url)

  return `
    <p style="margin: 24px 0 0; color: #94a3b8; font-size: 13px; line-height: 20px;">
      If the button does not work, paste this link into your browser:
      <br>
      <a href="${escapedUrl}" style="color: #67e8f9; text-decoration: underline; word-break: break-all;">${escapedUrl}</a>
    </p>
  `
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function getEmailTransport() {
  const smtpConfig = getSmtpConfig()

  return {
    from: smtpConfig.from,
    transporter: createTransport({
      host: smtpConfig.host,
      port: smtpConfig.port,
      secure: smtpConfig.secure,
      auth:
        smtpConfig.user && smtpConfig.password
          ? {
              user: smtpConfig.user,
              pass: smtpConfig.password,
            }
          : undefined,
    }),
  }
}

function getSmtpConfig() {
  return {
    host: getRequiredEnvironmentVariable("SMTP_HOST"),
    port: getRequiredPositiveIntegerEnvironmentVariable("SMTP_PORT"),
    secure: getOptionalBooleanEnvironmentVariable("SMTP_SECURE"),
    user: getOptionalEnvironmentVariable("SMTP_USER"),
    password: getOptionalEnvironmentVariable("SMTP_PASSWORD"),
    from: getRequiredEnvironmentVariable("SMTP_FROM"),
  }
}

function getRequiredEnvironmentVariable(environmentVariable: string) {
  const value = process.env[environmentVariable]?.trim()

  if (!value) {
    throw new Error(
      `Missing email environment variable: ${environmentVariable}. Add it to your repo-root .env file.`
    )
  }

  return value
}

function getOptionalEnvironmentVariable(environmentVariable: string) {
  return process.env[environmentVariable]?.trim() || null
}

function getRequiredPositiveIntegerEnvironmentVariable(
  environmentVariable: string
) {
  const value = getRequiredEnvironmentVariable(environmentVariable)
  const parsedValue = Number(value)

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${environmentVariable} must be a positive integer.`)
  }

  return parsedValue
}

function getOptionalBooleanEnvironmentVariable(environmentVariable: string) {
  const value = process.env[environmentVariable]?.trim().toLowerCase()

  return value === "true" || value === "1" || value === "yes"
}

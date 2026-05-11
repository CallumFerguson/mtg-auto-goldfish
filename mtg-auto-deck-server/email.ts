import { createTransport } from "nodemailer"

type SendPasswordResetEmailInput = {
  resetUrl: string
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
    text: `Hi ${displayName},

Use this link to reset your MTG Auto Deck password:

${resetUrl}

If you did not request this, you can ignore this email.`,
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
    subject: "Verify your MTG Auto Deck email",
    text: `Use this code to verify your MTG Auto Deck account:

${code}

This code expires in 5 minutes. If you did not request this, you can ignore this email.`,
  })
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

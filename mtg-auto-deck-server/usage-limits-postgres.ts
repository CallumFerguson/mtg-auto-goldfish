import type { QueryResultRow } from "pg"

import {
  BILLING_TIER_USAGE_LIMITS_USD,
  type BillingTier,
  type BillingUsageLimitWindowKind,
} from "./subscription-tiers.js"

type Queryable = {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<{
    rowCount: number | null
    rows: T[]
  }>
}

export type UsageLimitWindowKind = BillingUsageLimitWindowKind

export type UsageLimitWindowStatus = {
  kind: UsageLimitWindowKind
  label: string
  remainingPercent: number
  resetAt: string
}

export type UsageLimitStartDecision = {
  allowed: boolean
  exhaustedWindowKinds: UsageLimitWindowKind[]
  windows: UsageLimitWindowStatus[]
}

type UsageLimitWindowConfig = {
  durationMs: number
  kind: UsageLimitWindowKind
  label: string
}

type UsageWindowRow = {
  reset_at: Date
  started_at: Date
  window_kind: UsageLimitWindowKind
}

type UsageLimitWindowBounds = {
  isActive: boolean
  resetAt: Date
  startedAt: Date | null
}

type StartedUsageLimitWindowBounds = {
  isActive: true
  resetAt: Date
  startedAt: Date
}

type UsageLimitWindowSpend = {
  kind: UsageLimitWindowKind
  limitUsd: number
  spentUsd: number
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const ACTIVE_BILLING_SUBSCRIPTION_STATUSES = ["active", "trialing"]

export const USAGE_LIMIT_OUT_OF_USAGE_MESSAGE =
  "Out of usage limits. Wait until your usage limits reset, then try again."

export const USAGE_LIMIT_WINDOW_CONFIGS: readonly UsageLimitWindowConfig[] = [
  {
    durationMs: FIVE_HOURS_MS,
    kind: "five_hour",
    label: "5h",
  },
  {
    durationMs: SEVEN_DAYS_MS,
    kind: "weekly",
    label: "Weekly",
  },
] as const

export async function ensureUsageLimitsSchema(client: Queryable) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_usage_windows (
      id bigserial PRIMARY KEY,

      owner_user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      window_kind text NOT NULL,
      started_at timestamptz NOT NULL,
      reset_at timestamptz NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (owner_user_id, window_kind)
    )
  `)
  await client.query(`
    ALTER TABLE user_usage_windows
    DROP CONSTRAINT IF EXISTS user_usage_windows_kind_check
  `)
  await client.query(`
    ALTER TABLE user_usage_windows
    ADD CONSTRAINT user_usage_windows_kind_check
      CHECK (window_kind IN ('five_hour', 'weekly'))
  `)
  await client.query(`
    ALTER TABLE user_usage_windows
    DROP CONSTRAINT IF EXISTS user_usage_windows_reset_after_start_check
  `)
  await client.query(`
    ALTER TABLE user_usage_windows
    ADD CONSTRAINT user_usage_windows_reset_after_start_check
      CHECK (reset_at > started_at)
  `)
  await client.query(`
    CREATE INDEX IF NOT EXISTS user_usage_windows_owner_reset_idx
      ON user_usage_windows (owner_user_id, reset_at)
  `)
}

export async function getUserUsageLimitStatus(
  client: Queryable,
  ownerUserId: string,
  now = new Date()
): Promise<UsageLimitWindowStatus[]> {
  const billingTier = await getUserBillingTierWithClient(client, ownerUserId)
  const existingWindows = await getUsageWindowsByKind(client, ownerUserId)

  return Promise.all(
    USAGE_LIMIT_WINDOW_CONFIGS.map(async (config) => {
      const bounds = getUsageLimitWindowBounds({
        durationMs: config.durationMs,
        existingWindow: existingWindows.get(config.kind) ?? null,
        now,
      })
      const spentUsd = bounds.isActive
        ? await getUsageWindowSpentUsdWithClient(client, {
            ownerUserId,
            resetAt: bounds.resetAt,
            startedAt: bounds.startedAt,
          })
        : 0

      return toUsageLimitWindowStatus({
        config,
        limitUsd: BILLING_TIER_USAGE_LIMITS_USD[billingTier][config.kind],
        resetAt: bounds.resetAt,
        spentUsd,
      })
    })
  )
}

export async function ensureUserUsageLimitWindowsForRunStartWithClient(
  client: Queryable,
  ownerUserId: string,
  now = new Date()
): Promise<UsageLimitStartDecision> {
  const billingTier = await getUserBillingTierWithClient(client, ownerUserId)
  const existingWindows = await getUsageWindowsByKind(
    client,
    ownerUserId,
    true
  )
  const windowSpends: UsageLimitWindowSpend[] = []
  const windows: UsageLimitWindowStatus[] = []

  for (const config of USAGE_LIMIT_WINDOW_CONFIGS) {
    const bounds = getStartedUsageLimitWindowBounds({
      durationMs: config.durationMs,
      existingWindow: existingWindows.get(config.kind) ?? null,
      now,
    })

    if (!isExistingWindowActive(existingWindows.get(config.kind), now)) {
      await upsertUsageWindowWithClient(client, {
        bounds,
        config,
        ownerUserId,
      })
    }

    const spentUsd = await getUsageWindowSpentUsdWithClient(client, {
      ownerUserId,
      resetAt: bounds.resetAt,
      startedAt: bounds.startedAt,
    })
    const limitUsd = BILLING_TIER_USAGE_LIMITS_USD[billingTier][config.kind]

    windowSpends.push({
      kind: config.kind,
      limitUsd,
      spentUsd,
    })
    windows.push(
      toUsageLimitWindowStatus({
        config,
        limitUsd,
        resetAt: bounds.resetAt,
        spentUsd,
      })
    )
  }

  const gateDecision = getUsageLimitGateDecision(windowSpends)

  return {
    ...gateDecision,
    windows,
  }
}

export function getUsageLimitWindowBounds({
  durationMs,
  existingWindow,
  now,
}: {
  durationMs: number
  existingWindow: Pick<UsageWindowRow, "reset_at" | "started_at"> | null
  now: Date
}): UsageLimitWindowBounds {
  if (isExistingWindowActive(existingWindow, now)) {
    return {
      isActive: true,
      resetAt: existingWindow.reset_at,
      startedAt: existingWindow.started_at,
    }
  }

  return {
    isActive: false,
    resetAt: new Date(now.getTime() + durationMs),
    startedAt: null,
  }
}

export function getStartedUsageLimitWindowBounds({
  durationMs,
  existingWindow,
  now,
}: {
  durationMs: number
  existingWindow: Pick<UsageWindowRow, "reset_at" | "started_at"> | null
  now: Date
}): StartedUsageLimitWindowBounds {
  if (isExistingWindowActive(existingWindow, now)) {
    return {
      isActive: true,
      resetAt: existingWindow.reset_at,
      startedAt: existingWindow.started_at,
    }
  }

  return {
    isActive: true,
    resetAt: new Date(now.getTime() + durationMs),
    startedAt: now,
  }
}

export function getUsageLimitGateDecision(
  windows: readonly UsageLimitWindowSpend[]
) {
  const exhaustedWindowKinds = windows
    .filter((window) => window.spentUsd >= window.limitUsd)
    .map((window) => window.kind)

  return {
    allowed: exhaustedWindowKinds.length === 0,
    exhaustedWindowKinds,
  }
}

export function getPreferredUsageCostUsd({
  estimatedCostUsd,
  openrouterReportedCostUsd,
}: {
  estimatedCostUsd: number | null
  openrouterReportedCostUsd: number | null
}) {
  return openrouterReportedCostUsd ?? estimatedCostUsd
}

export function roundUsageRemainingPercent({
  limitUsd,
  spentUsd,
}: {
  limitUsd: number
  spentUsd: number
}) {
  if (limitUsd <= 0) {
    return 0
  }

  const remainingUsd = Math.max(Math.min(limitUsd - spentUsd, limitUsd), 0)

  if (remainingUsd === limitUsd) {
    return 100
  }

  if (remainingUsd === 0) {
    return 0
  }

  const rawPercent = (remainingUsd / limitUsd) * 100

  return Math.max(1, Math.min(99, Math.round(rawPercent)))
}

async function getUserBillingTierWithClient(
  client: Queryable,
  ownerUserId: string
): Promise<BillingTier> {
  const result = await client.query<{ plan: string }>(
    `
      SELECT lower(plan) AS plan
      FROM "subscription"
      WHERE "referenceId" = $1
        AND status = ANY($2::text[])
        AND lower(plan) IN ('plus', 'pro')
      ORDER BY
        CASE lower(plan)
          WHEN 'pro' THEN 2
          WHEN 'plus' THEN 1
          ELSE 0
        END DESC
      LIMIT 1
    `,
    [ownerUserId, ACTIVE_BILLING_SUBSCRIPTION_STATUSES]
  )
  const plan = result.rows[0]?.plan

  return plan === "plus" || plan === "pro" ? plan : "free"
}

async function getUsageWindowsByKind(
  client: Queryable,
  ownerUserId: string,
  forUpdate = false
) {
  const result = await client.query<UsageWindowRow>(
    `
      SELECT window_kind, started_at, reset_at
      FROM user_usage_windows
      WHERE owner_user_id = $1
        AND window_kind = ANY($2::text[])
      ${forUpdate ? "FOR UPDATE" : ""}
    `,
    [ownerUserId, USAGE_LIMIT_WINDOW_CONFIGS.map((config) => config.kind)]
  )

  return new Map(
    result.rows.map((window) => [window.window_kind, window] as const)
  )
}

async function upsertUsageWindowWithClient(
  client: Queryable,
  {
    bounds,
    config,
    ownerUserId,
  }: {
    bounds: StartedUsageLimitWindowBounds
    config: UsageLimitWindowConfig
    ownerUserId: string
  }
) {
  await client.query(
    `
      INSERT INTO user_usage_windows (
        owner_user_id,
        window_kind,
        started_at,
        reset_at
      )
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (owner_user_id, window_kind)
      DO UPDATE
      SET started_at = EXCLUDED.started_at,
          reset_at = EXCLUDED.reset_at,
          updated_at = now()
    `,
    [ownerUserId, config.kind, bounds.startedAt, bounds.resetAt]
  )
}

async function getUsageWindowSpentUsdWithClient(
  client: Queryable,
  {
    ownerUserId,
    resetAt,
    startedAt,
  }: {
    ownerUserId: string
    resetAt: Date
    startedAt: Date | null
  }
) {
  if (startedAt === null) {
    return 0
  }

  const query = buildUsageWindowSpentUsdQuery({
    ownerUserId,
    resetAt,
    startedAt,
  })
  const result = await client.query<{ spent_cost_usd: string | number | null }>(
    query.text,
    query.values
  )

  return toOptionalNumber(result.rows[0]?.spent_cost_usd) ?? 0
}

export function buildUsageWindowSpentUsdQuery({
  ownerUserId,
  resetAt,
  startedAt,
}: {
  ownerUserId: string
  resetAt: Date
  startedAt: Date
}) {
  return {
    text: `
      SELECT
        COALESCE(SUM(COALESCE(openrouter_reported_cost_usd, estimated_cost_usd)), 0) AS spent_cost_usd
      FROM llm_runs
      WHERE owner_user_id = $1
        AND started_at >= $2
        AND started_at < $3
        AND COALESCE(openrouter_reported_cost_usd, estimated_cost_usd) IS NOT NULL
    `,
    values: [ownerUserId, startedAt, resetAt],
  }
}

function toUsageLimitWindowStatus({
  config,
  limitUsd,
  resetAt,
  spentUsd,
}: {
  config: UsageLimitWindowConfig
  limitUsd: number
  resetAt: Date
  spentUsd: number
}): UsageLimitWindowStatus {
  return {
    kind: config.kind,
    label: config.label,
    remainingPercent: roundUsageRemainingPercent({
      limitUsd,
      spentUsd,
    }),
    resetAt: resetAt.toISOString(),
  }
}

function isExistingWindowActive(
  existingWindow:
    | Pick<UsageWindowRow, "reset_at" | "started_at">
    | null
    | undefined,
  now: Date
): existingWindow is Pick<UsageWindowRow, "reset_at" | "started_at"> {
  return Boolean(
    existingWindow && existingWindow.reset_at.getTime() > now.getTime()
  )
}

function toOptionalNumber(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim()) {
    const numberValue = Number(value)

    return Number.isFinite(numberValue) ? numberValue : null
  }

  return null
}

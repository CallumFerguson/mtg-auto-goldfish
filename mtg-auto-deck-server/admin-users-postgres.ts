import { queryDatabase, withDatabaseTransaction } from "./db.js"

export type AdminUserSummary = {
  id: string
  email: string
  emailVerified: boolean
  name: string
  role: string | null
  banned: boolean
  banReason: string | null
  banExpires: string | null
  createdAt: string
  updatedAt: string
}

export type AdminUserActiveSimulation = {
  deckId: string
  simulationId: string
}

export type AdminUserDeletionResult = {
  deletedLlmRunIds: string[]
  deletedSimulationIds: string[]
  deletedUserId: string
}

type AdminUserRow = {
  id: string
  email: string
  emailVerified: boolean
  name: string | null
  role: string | null
  banned: boolean | null
  banReason: string | null
  banExpires: Date | null
  createdAt: Date
  updatedAt: Date
}

type AdminUserDeletionTargetRow = {
  email: string
  id: string
}

type AdminUserSimulationRow = {
  deck_id: string
  simulation_id: string
}

type AdminUserLlmRunRow = {
  id: string
}

export async function listAdminUsers() {
  const result = await queryDatabase<AdminUserRow>(`
    SELECT
      id,
      email,
      "emailVerified" AS "emailVerified",
      name,
      role,
      banned,
      "banReason" AS "banReason",
      "banExpires" AS "banExpires",
      "createdAt" AS "createdAt",
      "updatedAt" AS "updatedAt"
    FROM "user"
    ORDER BY "createdAt" DESC, lower(email) ASC
  `)

  return result.rows.map(toAdminUserSummary)
}

export async function listActiveAdminUserSimulations(
  userId: string
): Promise<AdminUserActiveSimulation[]> {
  const result = await queryDatabase<AdminUserSimulationRow>(
    `
      SELECT DISTINCT
        deck.id AS deck_id,
        simulation.id AS simulation_id
      FROM decks deck
      JOIN simulations simulation
        ON simulation.deck_id = deck.id
      JOIN (
        SELECT simulation_id, llm_run_id
        FROM simulation_opening_hand_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_turn_llm_runs
        UNION ALL
        SELECT simulation_id, llm_run_id
        FROM simulation_report_llm_runs
      ) linked_run
        ON linked_run.simulation_id = simulation.id
      JOIN llm_runs llm_run
        ON llm_run.id = linked_run.llm_run_id
      WHERE deck.owner_user_id = $1
        AND llm_run.status IN ('pending', 'streaming', 'cancel_requested')
      ORDER BY simulation.id ASC
    `,
    [userId]
  )

  return result.rows.map((row) => ({
    deckId: row.deck_id,
    simulationId: row.simulation_id,
  }))
}

export async function deleteAdminUser(
  userId: string
): Promise<AdminUserDeletionResult | null> {
  return withDatabaseTransaction(async (client) => {
    const userResult = await client.query<AdminUserDeletionTargetRow>(
      `
        SELECT id, email
        FROM "user"
        WHERE id = $1
        FOR UPDATE
      `,
      [userId]
    )
    const user = userResult.rows[0]

    if (!user) {
      return null
    }

    const simulationResult = await client.query<{ id: string }>(
      `
        SELECT simulation.id
        FROM simulations simulation
        JOIN decks deck
          ON deck.id = simulation.deck_id
        WHERE deck.owner_user_id = $1
        ORDER BY simulation.id ASC
      `,
      [user.id]
    )

    const deletedSimulationIds = simulationResult.rows.map(
      (simulation) => simulation.id
    )

    const deletedRunResult = await client.query<AdminUserLlmRunRow>(
      `
        WITH user_simulations AS (
          SELECT simulation.id
          FROM simulations simulation
          JOIN decks deck
            ON deck.id = simulation.deck_id
          WHERE deck.owner_user_id = $1
        ),
        linked_llm_runs AS (
          SELECT llm_run_id AS id
          FROM simulation_opening_hand_llm_runs
          WHERE simulation_id IN (SELECT id FROM user_simulations)
          UNION
          SELECT llm_run_id AS id
          FROM simulation_turn_llm_runs
          WHERE simulation_id IN (SELECT id FROM user_simulations)
          UNION
          SELECT llm_run_id AS id
          FROM simulation_report_llm_runs
          WHERE simulation_id IN (SELECT id FROM user_simulations)
        ),
        target_llm_runs AS (
          SELECT id
          FROM linked_llm_runs
          UNION
          SELECT id
          FROM llm_runs
          WHERE owner_user_id = $1
        )
        DELETE FROM llm_runs
        WHERE id IN (SELECT id FROM target_llm_runs)
        RETURNING id
      `,
      [user.id]
    )

    await deleteUserVerificationValues(client, user.id, user.email)
    await deleteUserImpersonationSessions(client, user.id)

    const deleteUserResult = await client.query(
      `
        DELETE FROM "user"
        WHERE id = $1
      `,
      [user.id]
    )

    if ((deleteUserResult.rowCount ?? 0) === 0) {
      return null
    }

    return {
      deletedLlmRunIds: deletedRunResult.rows.map((run) => run.id),
      deletedSimulationIds,
      deletedUserId: user.id,
    }
  })
}

function toAdminUserSummary(row: AdminUserRow): AdminUserSummary {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    name: row.name ?? "",
    role: row.role,
    banned: row.banned ?? false,
    banReason: row.banReason,
    banExpires: formatDate(row.banExpires),
    createdAt: formatDate(row.createdAt) ?? "",
    updatedAt: formatDate(row.updatedAt) ?? "",
  }
}

function formatDate(value: Date | null) {
  return value ? value.toISOString() : null
}

async function deleteUserVerificationValues(
  client: Parameters<Parameters<typeof withDatabaseTransaction>[0]>[0],
  userId: string,
  email: string
) {
  const normalizedEmail = email.trim().toLowerCase()
  const exactIdentifiers = [
    `email-verification-otp-${normalizedEmail}`,
    `forget-password-otp-${normalizedEmail}`,
  ]

  await client.query(
    `
      DELETE FROM verification
      WHERE value = $1
        OR identifier = ANY($2::text[])
        OR identifier LIKE $3 ESCAPE '\\'
        OR identifier LIKE $4 ESCAPE '\\'
    `,
    [
      userId,
      exactIdentifiers,
      `${escapeSqlLikePattern(`change-email-otp-${normalizedEmail}`)}-%`,
      `change-email-otp-%-${escapeSqlLikePattern(normalizedEmail)}`,
    ]
  )
}

async function deleteUserImpersonationSessions(
  client: Parameters<Parameters<typeof withDatabaseTransaction>[0]>[0],
  userId: string
) {
  await client.query(
    `
      DELETE FROM "session"
      WHERE "impersonatedBy" = $1
    `,
    [userId]
  )
}

function escapeSqlLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`)
}

import pg from "pg"

type TransactionClient = pg.PoolClient

let databasePool: pg.Pool | null = null

export function getDatabasePool() {
  if (!databasePool) {
    databasePool = new pg.Pool(getDatabasePoolConfig())
    databasePool.on("error", (error) => {
      console.error("Unexpected idle Postgres client error:", error)
    })
  }

  return databasePool
}

export async function queryDatabase<
  T extends pg.QueryResultRow = pg.QueryResultRow,
>(text: string, values?: unknown[]) {
  return getDatabasePool().query<T>(text, values)
}

export async function verifyDatabaseConnection() {
  await queryDatabase("SELECT 1")
}

export async function withDatabaseTransaction<T>(
  callback: (client: TransactionClient) => Promise<T>
) {
  const client = await getDatabasePool().connect()

  try {
    await client.query("BEGIN")
    const result = await callback(client)
    await client.query("COMMIT")
    return result
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

export async function closeDatabasePool() {
  if (!databasePool) {
    return
  }

  const pool = databasePool
  databasePool = null
  await pool.end()
}

function getDatabasePoolConfig(): pg.PoolConfig {
  const missingVariables = getMissingDatabaseEnvironmentVariables()

  if (missingVariables.length > 0) {
    throw new Error(
      `Missing Postgres environment variable(s): ${missingVariables.join(", ")}. Add them to mtg-auto-deck-server/.env.`
    )
  }

  return {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  }
}

function getMissingDatabaseEnvironmentVariables() {
  return ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"].filter(
    (environmentVariable) => !process.env[environmentVariable]
  )
}

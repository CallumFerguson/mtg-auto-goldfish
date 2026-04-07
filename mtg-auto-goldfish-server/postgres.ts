import { Pool } from "pg"

export function createPostgresPool(connectionString: string) {
  return new Pool({
    connectionString,
  })
}

export async function initializePostgres(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS games (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL,
      seed bigint NOT NULL,
      random_state bigint NOT NULL,
      current_turn integer NOT NULL,
      current_game_state text,
      has_drawn_starting_hand boolean NOT NULL,
      mulligan_count integer NOT NULL,
      commanders jsonb NOT NULL,
      initial_library jsonb NOT NULL,
      library jsonb NOT NULL,
      opening_hand_snapshot jsonb,
      turn_snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
      active_turn_simulation jsonb
    )
  `)

  await pool.query(`
    UPDATE games
    SET active_turn_simulation = NULL
    WHERE active_turn_simulation IS NOT NULL
  `)
}

export function getRequiredDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim()

  if (!value) {
    throw new Error("DATABASE_URL is required.")
  }

  return value
}

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
    CREATE TABLE IF NOT EXISTS simulation_runs (
      id uuid PRIMARY KEY,
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      kind text NOT NULL,
      turn_number integer,
      status text NOT NULL,
      provider text,
      model_key text,
      model_display_name text,
      model_size_bytes bigint,
      prompt_text text NOT NULL,
      prompt_length_chars integer NOT NULL,
      input_tokens integer,
      output_tokens integer,
      reasoning_tokens integer,
      total_tokens integer,
      final_result_text text,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT NOW(),
      completed_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS simulation_runs_game_started_idx
    ON simulation_runs (game_id, started_at DESC)
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS simulation_events (
      id uuid PRIMARY KEY,
      simulation_run_id uuid NOT NULL REFERENCES simulation_runs(id) ON DELETE CASCADE,
      game_id uuid NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      kind text NOT NULL,
      turn_number integer,
      sequence_index integer NOT NULL,
      event_type text NOT NULL,
      event_time timestamptz NOT NULL DEFAULT NOW(),
      reasoning_text_delta text,
      message_text_delta text,
      tool_name text,
      tool_provider text,
      tool_status_event text,
      arguments_text text,
      output_text text,
      structured_content jsonb,
      ui_metadata jsonb,
      error_text text,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT NOW()
    )
  `)



  await pool.query(`
    CREATE INDEX IF NOT EXISTS simulation_events_run_sequence_idx
    ON simulation_events (simulation_run_id, sequence_index)
  `)

  await pool.query(`
    UPDATE games
    SET active_turn_simulation = NULL
    WHERE active_turn_simulation IS NOT NULL
  `)

  await pool.query(`
    UPDATE simulation_runs
    SET
      status = 'aborted',
      error_message = COALESCE(
        error_message,
        'The server restarted while this simulation was still running.'
      ),
      completed_at = COALESCE(completed_at, NOW()),
      updated_at = NOW()
    WHERE status = 'running'
  `)
}

export function getRequiredDatabaseUrl() {
  const value = process.env.DATABASE_URL?.trim()

  if (!value) {
    throw new Error("DATABASE_URL is required.")
  }

  return value
}



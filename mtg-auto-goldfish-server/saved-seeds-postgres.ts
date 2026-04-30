import { queryDatabase } from "./db.js"

export type SavedSeed = {
  id: string
  deckId: string
  name: string
  seed: string
  createdAt: string
  updatedAt: string
}

export type CreateSavedSeedInput = {
  name: string
  seed: string
}

export class SavedSeedValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SavedSeedValidationError"
  }
}

export async function ensureSavedSeedsSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pgcrypto")
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS saved_seeds (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      name text NOT NULL,
      seed text NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (deck_id, name)
    )
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS saved_seeds_deck_id_idx
      ON saved_seeds (deck_id)
  `)
}

export async function listSavedSeedsForDeck(
  deckId: string
): Promise<SavedSeed[]> {
  const result = await queryDatabase<SavedSeedRow>(
    `
      SELECT
        id,
        deck_id,
        name,
        seed,
        created_at,
        updated_at
      FROM saved_seeds
      WHERE deck_id = $1
      ORDER BY created_at DESC, name ASC
    `,
    [deckId]
  )

  return result.rows.map(mapSavedSeedRow)
}

export async function createSavedSeed(
  deckId: string,
  input: CreateSavedSeedInput
): Promise<SavedSeed> {
  const name = input.name.trim()
  const seed = input.seed.trim()

  if (!name) {
    throw new SavedSeedValidationError("Seed name is required.")
  }

  if (!seed) {
    throw new SavedSeedValidationError("Seed value is required.")
  }

  const deckResult = await queryDatabase("SELECT id FROM decks WHERE id = $1", [
    deckId,
  ])

  if (deckResult.rowCount === 0) {
    throw new SavedSeedValidationError("Deck not found.")
  }

  try {
    const result = await queryDatabase<SavedSeedRow>(
      `
        INSERT INTO saved_seeds (deck_id, name, seed)
        VALUES ($1, $2, $3)
        RETURNING id, deck_id, name, seed, created_at, updated_at
      `,
      [deckId, name, seed]
    )

    return mapSavedSeedRow(result.rows[0])
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SavedSeedValidationError(
        "A seed with that name already exists for this deck."
      )
    }

    throw error
  }
}

type SavedSeedRow = {
  id: string
  deck_id: string
  name: string
  seed: string
  created_at: Date
  updated_at: Date
}

function mapSavedSeedRow(row: SavedSeedRow): SavedSeed {
  return {
    id: row.id,
    deckId: row.deck_id,
    name: row.name,
    seed: row.seed,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

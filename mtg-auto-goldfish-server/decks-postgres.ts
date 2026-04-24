import { queryDatabase, withDatabaseTransaction } from "./db.js"

export type DeckSummary = {
  id: string
  name: string
  description: string | null
  format: string
  createdAt: string
  updatedAt: string
}

export type DeckCard = {
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  typeLine: string | null
}

export type DeckDetails = DeckSummary & {
  commanders: DeckCard[]
  cards: DeckCard[]
}

export type CreateDeckCardInput = {
  oracleId: string
  quantity: number
}

export type CreateDeckInput = {
  name: string
  desc: string
  commanders: CreateDeckCardInput[]
  cards: CreateDeckCardInput[]
}

export async function ensureDecksSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pgcrypto")
  await queryDatabase(`
    DO $$
    BEGIN
      CREATE TYPE deck_card_zone AS ENUM ('commander', 'library');
    EXCEPTION
      WHEN duplicate_object THEN null;
    END
    $$;
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS decks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      name text NOT NULL,
      description text,
      format text NOT NULL DEFAULT 'commander',

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS deck_cards (
      id bigserial PRIMARY KEY,

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      oracle_id uuid NOT NULL REFERENCES scryfall_oracle_cards(oracle_id),

      zone deck_card_zone NOT NULL,
      quantity integer NOT NULL CHECK (quantity > 0),

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (deck_id, oracle_id, zone)
    )
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS deck_cards_deck_id_idx
      ON deck_cards (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS deck_cards_oracle_id_idx
      ON deck_cards (oracle_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS deck_cards_deck_id_zone_idx
      ON deck_cards (deck_id, zone)
  `)
}

export async function listDecks(): Promise<DeckSummary[]> {
  const result = await queryDatabase<{
    id: string
    name: string
    description: string | null
    format: string
    created_at: Date
    updated_at: Date
  }>(`
    SELECT id, name, description, format, created_at, updated_at
    FROM decks
    ORDER BY updated_at DESC, name ASC
  `)

  return result.rows.map((deck) => ({
    id: deck.id,
    name: deck.name,
    description: deck.description,
    format: deck.format,
    createdAt: deck.created_at.toISOString(),
    updatedAt: deck.updated_at.toISOString(),
  }))
}

export async function getDeck(deckId: string): Promise<DeckDetails | null> {
  const deckResult = await queryDatabase<{
    id: string
    name: string
    description: string | null
    format: string
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT id, name, description, format, created_at, updated_at
      FROM decks
      WHERE id = $1
    `,
    [deckId]
  )
  const deck = deckResult.rows[0]

  if (!deck) {
    return null
  }

  const cardResult = await queryDatabase<{
    oracle_id: string
    name: string
    quantity: number
    scryfall_uri: string
    type_line: string | null
    zone: "commander" | "library"
  }>(
    `
      SELECT
        card.oracle_id,
        card.name,
        deck_card.quantity,
        card.scryfall_uri,
        card.type_line,
        deck_card.zone
      FROM deck_cards deck_card
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE deck_card.deck_id = $1
      ORDER BY
        CASE deck_card.zone
          WHEN 'commander' THEN 0
          ELSE 1
        END,
        card.name ASC
    `,
    [deckId]
  )
  const mapCard = (card: (typeof cardResult.rows)[number]): DeckCard => ({
    oracleId: card.oracle_id,
    name: card.name,
    quantity: card.quantity,
    scryfallUri: card.scryfall_uri,
    typeLine: card.type_line,
  })

  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    format: deck.format,
    createdAt: deck.created_at.toISOString(),
    updatedAt: deck.updated_at.toISOString(),
    commanders: cardResult.rows
      .filter((card) => card.zone === "commander")
      .map(mapCard),
    cards: cardResult.rows
      .filter((card) => card.zone === "library")
      .map(mapCard),
  }
}

export async function createDeck({
  cards,
  commanders,
  desc,
  name,
}: CreateDeckInput): Promise<DeckSummary> {
  return withDatabaseTransaction(async (client) => {
    const deckResult = await client.query<{
      id: string
      name: string
      description: string | null
      format: string
      created_at: Date
      updated_at: Date
    }>(
      `
        INSERT INTO decks (name, description)
        VALUES ($1, $2)
        RETURNING id, name, description, format, created_at, updated_at
      `,
      [name, desc.trim() || null]
    )
    const deck = deckResult.rows[0]

    async function insertDeckCards({
      cards,
      deckId,
      zone,
    }: {
      cards: CreateDeckCardInput[]
      deckId: string
      zone: "commander" | "library"
    }) {
      for (const card of cards) {
        await client.query(
          `
            INSERT INTO deck_cards (deck_id, oracle_id, zone, quantity)
            VALUES ($1, $2, $3, $4)
          `,
          [deckId, card.oracleId, zone, card.quantity]
        )
      }
    }

    await insertDeckCards({
      deckId: deck.id,
      zone: "commander",
      cards: mergeCardsByOracleId(commanders),
    })
    await insertDeckCards({
      deckId: deck.id,
      zone: "library",
      cards: mergeCardsByOracleId(cards),
    })

    return {
      id: deck.id,
      name: deck.name,
      description: deck.description,
      format: deck.format,
      createdAt: deck.created_at.toISOString(),
      updatedAt: deck.updated_at.toISOString(),
    }
  })
}

function mergeCardsByOracleId(cards: readonly CreateDeckCardInput[]) {
  const cardsByOracleId = new Map<string, CreateDeckCardInput>()

  for (const card of cards) {
    const existingCard = cardsByOracleId.get(card.oracleId)

    if (existingCard) {
      existingCard.quantity += card.quantity
      continue
    }

    cardsByOracleId.set(card.oracleId, { ...card })
  }

  return Array.from(cardsByOracleId.values())
}

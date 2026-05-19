import { queryDatabase, withDatabaseTransaction } from "./db.js"

export type DeckSummary = {
  id: string
  name: string
  description: string | null
  mulliganGuidelines: string | null
  strategyGuidelines: string | null
  format: string
  createdAt: string
  updatedAt: string
}

export type DeckCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
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
  mulliganGuidelines: string
  strategyGuidelines: string
  ownerUserId: string
  commanders: CreateDeckCardInput[]
  cards: CreateDeckCardInput[]
}

export type UpdateDeckDetailsInput = {
  name: string
  description: string
  mulliganGuidelines: string
  strategyGuidelines: string
}

type DeckSummaryRow = {
  id: string
  name: string
  description: string | null
  mulligan_guidelines: string | null
  strategy_guidelines: string | null
  format: string
  created_at: Date
  updated_at: Date
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
      owner_user_id text REFERENCES "user"(id) ON DELETE CASCADE,
      is_starter boolean NOT NULL DEFAULT false,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    ALTER TABLE decks
    ADD COLUMN IF NOT EXISTS owner_user_id text REFERENCES "user"(id) ON DELETE CASCADE
  `)
  await queryDatabase(`
    ALTER TABLE decks
    ADD COLUMN IF NOT EXISTS is_starter boolean NOT NULL DEFAULT false
  `)
  await queryDatabase(`
    ALTER TABLE decks
    ADD COLUMN IF NOT EXISTS mulligan_guidelines text
  `)
  await queryDatabase(`
    ALTER TABLE decks
    ADD COLUMN IF NOT EXISTS strategy_guidelines text
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
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS decks_owner_user_id_updated_at_idx
      ON decks (owner_user_id, updated_at DESC)
      WHERE owner_user_id IS NOT NULL
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS decks_starter_updated_at_idx
      ON decks (updated_at DESC, id)
      WHERE is_starter = true
  `)
}

export async function listDecks(ownerUserId?: string): Promise<DeckSummary[]> {
  const result = await queryDatabase<DeckSummaryRow>(
    `
      SELECT
        id,
        name,
        description,
        mulligan_guidelines,
        strategy_guidelines,
        format,
        created_at,
        updated_at
      FROM decks
      WHERE ($1::text IS NULL OR owner_user_id = $1)
      ORDER BY updated_at DESC, name ASC
    `,
    [ownerUserId ?? null]
  )

  return result.rows.map(mapDeckSummaryRow)
}

export async function getDeck(
  deckId: string,
  ownerUserId?: string
): Promise<DeckDetails | null> {
  const deckResult = await queryDatabase<DeckSummaryRow>(
    `
      SELECT
        id,
        name,
        description,
        mulligan_guidelines,
        strategy_guidelines,
        format,
        created_at,
        updated_at
      FROM decks
      WHERE id = $1
        AND ($2::text IS NULL OR owner_user_id = $2)
    `,
    [deckId, ownerUserId ?? null]
  )
  const deck = deckResult.rows[0]

  if (!deck) {
    return null
  }

  const cardResult = await queryDatabase<{
    deck_card_id: number
    oracle_id: string
    name: string
    quantity: number
    scryfall_uri: string
    default_image_url: string | null
    type_line: string | null
    zone: "commander" | "library"
  }>(
    `
      SELECT
        deck_card.id AS deck_card_id,
        card.oracle_id,
        card.name,
        deck_card.quantity,
        card.scryfall_uri,
        card.default_image_url,
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
    deckCardId: Number(card.deck_card_id),
    oracleId: card.oracle_id,
    name: card.name,
    quantity: card.quantity,
    scryfallUri: card.scryfall_uri,
    defaultImageUrl: card.default_image_url,
    typeLine: card.type_line,
  })

  return {
    ...mapDeckSummaryRow(deck),
    commanders: cardResult.rows
      .filter((card) => card.zone === "commander")
      .map(mapCard),
    cards: cardResult.rows
      .filter((card) => card.zone === "library")
      .map(mapCard),
  }
}

export async function deleteDeck(
  deckId: string,
  ownerUserId?: string
): Promise<boolean> {
  const result = await queryDatabase(
    `
      DELETE FROM decks
      WHERE id = $1
        AND ($2::text IS NULL OR owner_user_id = $2)
    `,
    [deckId, ownerUserId ?? null]
  )

  return (result.rowCount ?? 0) > 0
}

export async function updateDeckDetails(
  deckId: string,
  {
    description,
    mulliganGuidelines,
    name,
    strategyGuidelines,
  }: UpdateDeckDetailsInput,
  ownerUserId?: string
): Promise<DeckSummary | null> {
  const result = await queryDatabase<DeckSummaryRow>(
    `
      UPDATE decks
      SET
        name = $2,
        description = $3,
        mulligan_guidelines = $4,
        strategy_guidelines = $5,
        updated_at = now()
      WHERE id = $1
        AND ($6::text IS NULL OR owner_user_id = $6)
      RETURNING
        id,
        name,
        description,
        mulligan_guidelines,
        strategy_guidelines,
        format,
        created_at,
        updated_at
    `,
    [
      deckId,
      name,
      normalizeNullableText(description),
      normalizeNullableText(mulliganGuidelines),
      normalizeNullableText(strategyGuidelines),
      ownerUserId ?? null,
    ]
  )
  const deck = result.rows[0]

  if (!deck) {
    return null
  }

  return mapDeckSummaryRow(deck)
}

export async function createDeck({
  cards,
  commanders,
  desc,
  mulliganGuidelines,
  name,
  ownerUserId,
  strategyGuidelines,
}: CreateDeckInput): Promise<DeckSummary> {
  return withDatabaseTransaction(async (client) => {
    const deckResult = await client.query<DeckSummaryRow>(
      `
        INSERT INTO decks (
          name,
          description,
          mulligan_guidelines,
          strategy_guidelines,
          owner_user_id
        )
        VALUES ($1, $2, $3, $4, $5)
        RETURNING
          id,
          name,
          description,
          mulligan_guidelines,
          strategy_guidelines,
          format,
          created_at,
          updated_at
      `,
      [
        name,
        normalizeNullableText(desc),
        normalizeNullableText(mulliganGuidelines),
        normalizeNullableText(strategyGuidelines),
        ownerUserId,
      ]
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

    return mapDeckSummaryRow(deck)
  })
}

function mapDeckSummaryRow(deck: DeckSummaryRow): DeckSummary {
  return {
    id: deck.id,
    name: deck.name,
    description: deck.description,
    mulliganGuidelines: deck.mulligan_guidelines,
    strategyGuidelines: deck.strategy_guidelines,
    format: deck.format,
    createdAt: deck.created_at.toISOString(),
    updatedAt: deck.updated_at.toISOString(),
  }
}

function normalizeNullableText(value: string) {
  return value.trim() || null
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

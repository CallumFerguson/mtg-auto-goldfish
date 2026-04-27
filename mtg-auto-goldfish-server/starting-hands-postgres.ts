import { queryDatabase, withDatabaseTransaction } from "./db.js"

export type StartingHandCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

export type StartingHand = {
  id: string
  deckId: string
  name: string
  cards: StartingHandCard[]
  createdAt: string
  updatedAt: string
}

export type CreateStartingHandInput = {
  name: string
  cards: {
    deckCardId: number
    quantity: number
  }[]
}

export class StartingHandValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartingHandValidationError"
  }
}

export async function ensureStartingHandsSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pgcrypto")
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS starting_hands (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
      name text NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (deck_id, name)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS starting_hand_cards (
      starting_hand_id uuid NOT NULL REFERENCES starting_hands(id) ON DELETE CASCADE,
      deck_card_id bigint NOT NULL REFERENCES deck_cards(id) ON DELETE CASCADE,
      quantity integer NOT NULL CHECK (quantity > 0),

      PRIMARY KEY (starting_hand_id, deck_card_id)
    )
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS starting_hands_deck_id_idx
      ON starting_hands (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS starting_hand_cards_deck_card_id_idx
      ON starting_hand_cards (deck_card_id)
  `)
}

export async function listStartingHandsForDeck(
  deckId: string
): Promise<StartingHand[]> {
  const result = await queryDatabase<StartingHandRow>(
    `
      SELECT
        hand.id,
        hand.deck_id,
        hand.name,
        hand.created_at,
        hand.updated_at,
        hand_card.deck_card_id,
        hand_card.quantity,
        deck_card.oracle_id,
        card.name AS card_name,
        card.scryfall_uri,
        card.default_image_url,
        card.type_line
      FROM starting_hands hand
      LEFT JOIN starting_hand_cards hand_card
        ON hand_card.starting_hand_id = hand.id
      LEFT JOIN deck_cards deck_card
        ON deck_card.id = hand_card.deck_card_id
      LEFT JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE hand.deck_id = $1
      ORDER BY hand.created_at DESC, hand.name ASC, card.name ASC
    `,
    [deckId]
  )

  return mapStartingHandRows(result.rows)
}

export async function createStartingHand(
  deckId: string,
  input: CreateStartingHandInput
): Promise<StartingHand> {
  return withDatabaseTransaction(async (client) => {
    const name = input.name.trim()
    const cards = mergeStartingHandCards(input.cards)
    const totalCards = cards.reduce((total, card) => total + card.quantity, 0)

    if (!name) {
      throw new StartingHandValidationError("Starting hand name is required.")
    }

    if (totalCards !== 7) {
      throw new StartingHandValidationError(
        "Starting hand must contain exactly 7 cards."
      )
    }

    const deckResult = await client.query(
      "SELECT id FROM decks WHERE id = $1",
      [deckId]
    )

    if (deckResult.rowCount === 0) {
      throw new StartingHandValidationError("Deck not found.")
    }

    const deckCardResult = await client.query<{
      id: number
      quantity: number
      zone: "commander" | "library"
    }>(
      `
        SELECT id, quantity, zone
        FROM deck_cards
        WHERE deck_id = $1
          AND id = ANY($2::bigint[])
      `,
      [deckId, cards.map((card) => card.deckCardId)]
    )
    const deckCardsById = new Map(
      deckCardResult.rows.map((card) => [Number(card.id), card])
    )

    for (const card of cards) {
      const deckCard = deckCardsById.get(card.deckCardId)

      if (!deckCard) {
        throw new StartingHandValidationError(
          "Starting hand contains a card that is not in this deck."
        )
      }

      if (deckCard.zone !== "library") {
        throw new StartingHandValidationError(
          "Starting hand can only contain library cards."
        )
      }

      if (card.quantity > deckCard.quantity) {
        throw new StartingHandValidationError(
          "Starting hand contains more copies of a card than the deck has."
        )
      }
    }

    let hand

    try {
      const handResult = await client.query<{
        id: string
        deck_id: string
        name: string
        created_at: Date
        updated_at: Date
      }>(
        `
          INSERT INTO starting_hands (deck_id, name)
          VALUES ($1, $2)
          RETURNING id, deck_id, name, created_at, updated_at
        `,
        [deckId, name]
      )

      hand = handResult.rows[0]
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StartingHandValidationError(
          "A starting hand with that name already exists for this deck."
        )
      }

      throw error
    }

    for (const card of cards) {
      await client.query(
        `
          INSERT INTO starting_hand_cards (
            starting_hand_id,
            deck_card_id,
            quantity
          )
          VALUES ($1, $2, $3)
        `,
        [hand.id, card.deckCardId, card.quantity]
      )
    }

    const createdHandResult = await client.query<StartingHandRow>(
      `
        SELECT
          hand.id,
          hand.deck_id,
          hand.name,
          hand.created_at,
          hand.updated_at,
          hand_card.deck_card_id,
          hand_card.quantity,
          deck_card.oracle_id,
          card.name AS card_name,
          card.scryfall_uri,
          card.default_image_url,
          card.type_line
        FROM starting_hands hand
        JOIN starting_hand_cards hand_card
          ON hand_card.starting_hand_id = hand.id
        JOIN deck_cards deck_card
          ON deck_card.id = hand_card.deck_card_id
        JOIN scryfall_oracle_cards card
          ON card.oracle_id = deck_card.oracle_id
        WHERE hand.id = $1
        ORDER BY card.name ASC
      `,
      [hand.id]
    )

    const createdHand = mapStartingHandRows(createdHandResult.rows)[0]

    if (!createdHand) {
      throw new Error("Created starting hand could not be loaded.")
    }

    return createdHand
  })
}

type StartingHandRow = {
  id: string
  deck_id: string
  name: string
  created_at: Date
  updated_at: Date
  deck_card_id: number | null
  quantity: number | null
  oracle_id: string | null
  card_name: string | null
  scryfall_uri: string | null
  default_image_url: string | null
  type_line: string | null
}

function mapStartingHandRows(rows: readonly StartingHandRow[]) {
  const handsById = new Map<string, StartingHand>()

  for (const row of rows) {
    let hand = handsById.get(row.id)

    if (!hand) {
      hand = {
        id: row.id,
        deckId: row.deck_id,
        name: row.name,
        cards: [],
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      }
      handsById.set(row.id, hand)
    }

    if (
      row.deck_card_id !== null &&
      row.quantity !== null &&
      row.oracle_id !== null &&
      row.card_name !== null &&
      row.scryfall_uri !== null
    ) {
      hand.cards.push({
        deckCardId: Number(row.deck_card_id),
        oracleId: row.oracle_id,
        name: row.card_name,
        quantity: row.quantity,
        scryfallUri: row.scryfall_uri,
        defaultImageUrl: row.default_image_url,
        typeLine: row.type_line,
      })
    }
  }

  return Array.from(handsById.values())
}

function mergeStartingHandCards(
  cards: Readonly<CreateStartingHandInput["cards"]>
) {
  const cardsByDeckCardId = new Map<
    number,
    { deckCardId: number; quantity: number }
  >()

  for (const card of cards) {
    if (!Number.isInteger(card.deckCardId) || card.deckCardId <= 0) {
      throw new StartingHandValidationError(
        "Starting hand contains an invalid deck card."
      )
    }

    if (!Number.isInteger(card.quantity) || card.quantity <= 0) {
      throw new StartingHandValidationError(
        "Starting hand card quantities must be positive integers."
      )
    }

    const existingCard = cardsByDeckCardId.get(card.deckCardId)

    if (existingCard) {
      existingCard.quantity += card.quantity
      continue
    }

    cardsByDeckCardId.set(card.deckCardId, { ...card })
  }

  return Array.from(cardsByDeckCardId.values())
}

function isUniqueViolation(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  )
}

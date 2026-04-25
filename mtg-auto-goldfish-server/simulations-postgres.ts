import { queryDatabase, withDatabaseTransaction } from "./db.js"

export type SimulationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type LlmRunStatus =
  | "pending"
  | "streaming"
  | "completed"
  | "failed"
  | "cancel_requested"
  | "cancelled"

export type LlmRunPhase = "opening_hand" | "turn" | "other"

export type LlmChunkKind =
  | "raw_event"
  | "message_delta"
  | "reasoning_delta"
  | "tool_call"
  | "tool_result"
  | "usage"
  | "error"
  | "metadata"

export type SimulationSummary = {
  id: string
  deckId: string
  startingHandId: string | null
  seed: string
  turnsToSimulate: number
  status: SimulationStatus
  createdAt: string
  updatedAt: string
}

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

export type CreateSimulationInput = {
  seed: string
  turnsToSimulate: number
  startingHandId: string | null
}

export type SimulationPromptCardFace = {
  name: string
  manaCost: string | null
  typeLine: string | null
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
}

export type SimulationPromptCard = {
  deckCardId: number
  oracleId: string
  name: string
  quantity: number
  zone: "commander" | "library"
  manaCost: string | null
  typeLine: string | null
  oracleText: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  cardFaces: SimulationPromptCardFace[]
}

export type StartingHandSimulationPromptData = {
  simulationId: string
  deckId: string
  commanders: SimulationPromptCard[]
  library: SimulationPromptCard[]
}

export class SimulationValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SimulationValidationError"
  }
}

export class StartingHandValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StartingHandValidationError"
  }
}

export async function ensureSimulationsSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pgcrypto")
  await createEnumType("simulation_status", [
    "pending",
    "running",
    "completed",
    "failed",
    "cancelled",
  ])
  await createEnumType("llm_run_status", [
    "pending",
    "streaming",
    "completed",
    "failed",
    "cancel_requested",
    "cancelled",
  ])
  await createEnumType("llm_run_phase", ["opening_hand", "turn", "other"])
  await createEnumType("llm_chunk_kind", [
    "raw_event",
    "message_delta",
    "reasoning_delta",
    "tool_call",
    "tool_result",
    "usage",
    "error",
    "metadata",
  ])

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
    CREATE TABLE IF NOT EXISTS simulations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      deck_id uuid NOT NULL REFERENCES decks(id) ON DELETE CASCADE,

      seed text NOT NULL,
      turns_to_simulate integer NOT NULL CHECK (turns_to_simulate >= 0),
      starting_hand_id uuid REFERENCES starting_hands(id) ON DELETE SET NULL,

      status simulation_status NOT NULL DEFAULT 'pending',
      started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      cancel_requested_at timestamptz,
      failure_message text,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

      phase llm_run_phase NOT NULL,
      provider text NOT NULL,
      model text NOT NULL,
      provider_run_id text,
      provider_request_id text,

      status llm_run_status NOT NULL DEFAULT 'pending',
      runtime_stream_key text UNIQUE,

      full_prompt text NOT NULL DEFAULT '',
      request_payload jsonb NOT NULL DEFAULT '{}',
      response_metadata jsonb NOT NULL DEFAULT '{}',
      usage jsonb NOT NULL DEFAULT '{}',

      started_at timestamptz,
      completed_at timestamptz,
      failed_at timestamptz,
      cancel_requested_at timestamptz,
      cancelled_at timestamptz,
      failure_message text,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS llm_run_chunks (
      id bigserial PRIMARY KEY,

      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      sequence integer NOT NULL,
      kind llm_chunk_kind NOT NULL,
      provider_event_type text,
      reasoning_delta text,
      output_delta text,
      content text,
      payload jsonb NOT NULL DEFAULT '{}',
      received_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (llm_run_id, sequence)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_opening_hand_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, attempt_number),
      UNIQUE (llm_run_id)
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS simulation_turn_llm_runs (
      simulation_id uuid NOT NULL REFERENCES simulations(id) ON DELETE CASCADE,
      llm_run_id uuid NOT NULL REFERENCES llm_runs(id) ON DELETE CASCADE,
      turn_number integer NOT NULL CHECK (turn_number > 0),
      attempt_number integer NOT NULL CHECK (attempt_number > 0),
      created_at timestamptz NOT NULL DEFAULT now(),

      UNIQUE (simulation_id, turn_number, attempt_number),
      UNIQUE (llm_run_id)
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
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_deck_id_idx
      ON simulations (deck_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulations_status_idx
      ON simulations (status)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_status_idx
      ON llm_runs (status)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_runs_provider_model_idx
      ON llm_runs (provider, model)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS llm_run_chunks_llm_run_id_sequence_idx
      ON llm_run_chunks (llm_run_id, sequence)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_opening_hand_llm_runs_simulation_id_idx
      ON simulation_opening_hand_llm_runs (simulation_id)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS simulation_turn_llm_runs_simulation_id_turn_number_idx
      ON simulation_turn_llm_runs (simulation_id, turn_number)
  `)
}

export async function listSimulationsForDeck(
  deckId: string
): Promise<SimulationSummary[]> {
  const result = await queryDatabase<{
    id: string
    deck_id: string
    starting_hand_id: string | null
    seed: string
    turns_to_simulate: number
    status: SimulationStatus
    created_at: Date
    updated_at: Date
  }>(
    `
      SELECT
        id,
        deck_id,
        starting_hand_id,
        seed,
        turns_to_simulate,
        status,
        created_at,
        updated_at
      FROM simulations
      WHERE deck_id = $1
      ORDER BY created_at DESC
    `,
    [deckId]
  )

  return result.rows.map((simulation) => ({
    id: simulation.id,
    deckId: simulation.deck_id,
    startingHandId: simulation.starting_hand_id,
    seed: simulation.seed,
    turnsToSimulate: simulation.turns_to_simulate,
    status: simulation.status,
    createdAt: simulation.created_at.toISOString(),
    updatedAt: simulation.updated_at.toISOString(),
  }))
}

export async function createSimulation(
  deckId: string,
  input: CreateSimulationInput
): Promise<SimulationSummary> {
  const seed = input.seed.trim()

  if (!seed) {
    throw new SimulationValidationError("Simulation seed is required.")
  }

  if (
    !Number.isInteger(input.turnsToSimulate) ||
    input.turnsToSimulate < 0
  ) {
    throw new SimulationValidationError(
      "Turns to simulate must be a non-negative integer."
    )
  }

  const deckResult = await queryDatabase("SELECT id FROM decks WHERE id = $1", [
    deckId,
  ])

  if (deckResult.rowCount === 0) {
    throw new SimulationValidationError("Deck not found.")
  }

  if (input.startingHandId !== null) {
    const startingHandResult = await queryDatabase(
      `
        SELECT id
        FROM starting_hands
        WHERE id = $1
          AND deck_id = $2
      `,
      [input.startingHandId, deckId]
    )

    if (startingHandResult.rowCount === 0) {
      throw new SimulationValidationError(
        "Starting hand does not exist for this deck."
      )
    }
  }

  const result = await queryDatabase<{
    id: string
    deck_id: string
    starting_hand_id: string | null
    seed: string
    turns_to_simulate: number
    status: SimulationStatus
    created_at: Date
    updated_at: Date
  }>(
    `
      INSERT INTO simulations (
        deck_id,
        seed,
        turns_to_simulate,
        starting_hand_id
      )
      VALUES ($1, $2, $3, $4)
      RETURNING
        id,
        deck_id,
        starting_hand_id,
        seed,
        turns_to_simulate,
        status,
        created_at,
        updated_at
    `,
    [deckId, seed, input.turnsToSimulate, input.startingHandId]
  )
  const simulation = result.rows[0]

  return {
    id: simulation.id,
    deckId: simulation.deck_id,
    startingHandId: simulation.starting_hand_id,
    seed: simulation.seed,
    turnsToSimulate: simulation.turns_to_simulate,
    status: simulation.status,
    createdAt: simulation.created_at.toISOString(),
    updatedAt: simulation.updated_at.toISOString(),
  }
}

export async function deleteSimulation(
  deckId: string,
  simulationId: string
): Promise<boolean> {
  const result = await queryDatabase(
    `
      DELETE FROM simulations
      WHERE id = $1
        AND deck_id = $2
    `,
    [simulationId, deckId]
  )

  return (result.rowCount ?? 0) > 0
}

export async function getStartingHandSimulationPromptData(
  simulationId: string
): Promise<StartingHandSimulationPromptData | null> {
  const result = await queryDatabase<SimulationPromptCardRow>(
    `
      SELECT
        simulation.id AS simulation_id,
        simulation.deck_id,
        deck_card.id AS deck_card_id,
        deck_card.oracle_id,
        deck_card.quantity,
        deck_card.zone,
        card.name,
        card.mana_cost,
        card.type_line,
        card.oracle_text,
        card.power,
        card.toughness,
        card.loyalty,
        card.card_faces
      FROM simulations simulation
      JOIN deck_cards deck_card
        ON deck_card.deck_id = simulation.deck_id
      JOIN scryfall_oracle_cards card
        ON card.oracle_id = deck_card.oracle_id
      WHERE simulation.id = $1
      ORDER BY
        CASE deck_card.zone
          WHEN 'commander' THEN 0
          ELSE 1
        END,
        card.name ASC
    `,
    [simulationId]
  )

  const firstRow = result.rows[0]

  if (!firstRow) {
    return null
  }

  const cards = result.rows.map(mapSimulationPromptCard)

  return {
    simulationId: firstRow.simulation_id,
    deckId: firstRow.deck_id,
    commanders: cards.filter((card) => card.zone === "commander"),
    library: cards.filter((card) => card.zone === "library"),
  }
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

type SimulationPromptCardRow = {
  simulation_id: string
  deck_id: string
  deck_card_id: number
  oracle_id: string
  quantity: number
  zone: "commander" | "library"
  name: string
  mana_cost: string | null
  type_line: string | null
  oracle_text: string | null
  power: string | null
  toughness: string | null
  loyalty: string | null
  card_faces: unknown
}

function mapSimulationPromptCard(
  row: SimulationPromptCardRow
): SimulationPromptCard {
  return {
    deckCardId: Number(row.deck_card_id),
    oracleId: row.oracle_id,
    name: row.name,
    quantity: row.quantity,
    zone: row.zone,
    manaCost: row.mana_cost,
    typeLine: row.type_line,
    oracleText: row.oracle_text,
    power: row.power,
    toughness: row.toughness,
    loyalty: row.loyalty,
    cardFaces: parseSimulationPromptCardFaces(row.card_faces),
  }
}

function parseSimulationPromptCardFaces(
  cardFaces: unknown
): SimulationPromptCardFace[] {
  if (!Array.isArray(cardFaces)) {
    return []
  }

  return cardFaces.flatMap((face) => {
    if (typeof face !== "object" || face === null) {
      return []
    }

    const faceRecord = face as Record<string, unknown>
    const name = getOptionalString(faceRecord.name)

    if (!name) {
      return []
    }

    return [
      {
        name,
        manaCost: getOptionalString(faceRecord.mana_cost),
        typeLine: getOptionalString(faceRecord.type_line),
        oracleText: getOptionalString(faceRecord.oracle_text),
        power: getOptionalString(faceRecord.power),
        toughness: getOptionalString(faceRecord.toughness),
        loyalty: getOptionalString(faceRecord.loyalty),
      },
    ]
  })
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value : null
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

async function createEnumType(name: string, values: readonly string[]) {
  await queryDatabase(`
    DO $$
    BEGIN
      CREATE TYPE ${name} AS ENUM (${values
        .map((value) => `'${value}'`)
        .join(", ")});
    EXCEPTION
      WHEN duplicate_object THEN null;
    END
    $$;
  `)
}

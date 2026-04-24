import { readFile } from "node:fs/promises"
import pg from "pg"
import { queryDatabase, withDatabaseTransaction } from "./db.js"

const CARD_IMPORT_BATCH_SIZE = 500
const DEFAULT_SEARCH_LIMIT = 20

type ScryfallImageUris = {
  normal?: string
  large?: string
  png?: string
}

type ScryfallCardFace = {
  name?: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  colors?: string[]
  power?: string
  toughness?: string
  loyalty?: string
  image_uris?: ScryfallImageUris
}

type ScryfallCard = {
  id?: string
  scryfall_uri?: string
  oracle_id?: string
  name?: string
  lang?: string
  layout?: string
  mana_cost?: string
  cmc?: number
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  colors?: string[]
  color_identity?: string[]
  produced_mana?: string[]
  keywords?: string[]
  games?: string[]
  legalities?: Record<string, string>
  image_uris?: ScryfallImageUris
  card_faces?: ScryfallCardFace[]
  all_parts?: unknown
  released_at?: string
  reserved?: boolean
  digital?: boolean
  game_changer?: boolean
  edhrec_rank?: number
}

type ImportScryfallOracleCardsOptions = {
  oracleCardsPath: string
  downloadedAt: string
  scryfallUpdatedAt?: string
}

type SearchScryfallOracleCardsOptions = {
  name: string
  limit?: number
}

type DbClient = pg.Client | pg.PoolClient

export async function importScryfallOracleCardsToPostgres({
  oracleCardsPath,
  downloadedAt,
  scryfallUpdatedAt,
}: ImportScryfallOracleCardsOptions) {
  const importStartedAt = Date.now()

  console.error(
    `Preparing Scryfall oracle_cards import from ${oracleCardsPath}`
  )
  await ensureScryfallOracleCardsSchema()

  const cards = await readScryfallOracleCardsFile(oracleCardsPath)
  let importedCount = 0

  console.error(
    `Importing ${cards.length} Scryfall oracle_cards into Postgres in batches of ${CARD_IMPORT_BATCH_SIZE}...`
  )

  for (let index = 0; index < cards.length; index += CARD_IMPORT_BATCH_SIZE) {
    const batch = cards.slice(index, index + CARD_IMPORT_BATCH_SIZE)

    await withDatabaseTransaction(async (client) => {
      for (const card of batch) {
        await upsertScryfallOracleCard(client, {
          card,
          downloadedAt,
          scryfallUpdatedAt,
        })
        importedCount += 1
      }
    })

    logScryfallOracleCardsImportProgress({
      importedCount,
      totalCount: cards.length,
      startedAt: importStartedAt,
    })
  }

  console.error(
    `Imported ${importedCount} Scryfall oracle_cards into Postgres in ${formatElapsedSeconds(importStartedAt)}s.`
  )
}

export async function searchScryfallOracleCardsByName({
  name,
  limit = DEFAULT_SEARCH_LIMIT,
}: SearchScryfallOracleCardsOptions) {
  const normalizedName = normalizeCardName(name)

  const result = await queryDatabase(
    `
      WITH matches AS (
        SELECT
          card.oracle_id,
          similarity(card.normalized_name, $1) AS score
        FROM scryfall_oracle_cards card
        WHERE card.normalized_name % $1

        UNION ALL

        SELECT
          face.oracle_id,
          similarity(face.normalized_name, $1) AS score
        FROM scryfall_card_faces face
        WHERE face.normalized_name % $1
      ),
      ranked_matches AS (
        SELECT oracle_id, max(score) AS score
        FROM matches
        GROUP BY oracle_id
      )
      SELECT card.*, ranked_matches.score
      FROM ranked_matches
      JOIN scryfall_oracle_cards card ON card.oracle_id = ranked_matches.oracle_id
      ORDER BY ranked_matches.score DESC, card.name ASC
      LIMIT $2
      `,
    [normalizedName, limit]
  )

  return result.rows
}

async function ensureScryfallOracleCardsSchema() {
  await queryDatabase("CREATE EXTENSION IF NOT EXISTS pg_trgm")
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS scryfall_oracle_cards (
      oracle_id uuid PRIMARY KEY,
      scryfall_id uuid NOT NULL UNIQUE,
      scryfall_uri text NOT NULL,

      name text NOT NULL,
      normalized_name text NOT NULL,
      default_image_url text,

      lang text NOT NULL,
      layout text NOT NULL,
      mana_cost text,
      cmc numeric,
      type_line text,
      oracle_text text,
      power text,
      toughness text,
      loyalty text,

      colors text[] NOT NULL DEFAULT '{}',
      color_identity text[] NOT NULL DEFAULT '{}',
      produced_mana text[] NOT NULL DEFAULT '{}',
      keywords text[] NOT NULL DEFAULT '{}',
      games text[] NOT NULL DEFAULT '{}',

      legalities jsonb NOT NULL DEFAULT '{}',
      image_uris jsonb,
      card_faces jsonb,
      all_parts jsonb,
      raw_card jsonb NOT NULL,

      released_at date,
      reserved boolean,
      digital boolean,
      game_changer boolean,
      edhrec_rank integer,

      scryfall_updated_at timestamptz,
      downloaded_at timestamptz NOT NULL,

      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `)
  await queryDatabase(`
    CREATE TABLE IF NOT EXISTS scryfall_card_faces (
      id bigserial PRIMARY KEY,
      oracle_id uuid NOT NULL REFERENCES scryfall_oracle_cards(oracle_id) ON DELETE CASCADE,
      face_index integer NOT NULL,

      name text NOT NULL,
      normalized_name text NOT NULL,
      default_image_url text,

      mana_cost text,
      type_line text,
      oracle_text text,
      colors text[] NOT NULL DEFAULT '{}',
      power text,
      toughness text,
      loyalty text,
      image_uris jsonb,
      raw_face jsonb NOT NULL,

      UNIQUE (oracle_id, face_index)
    )
  `)

  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS scryfall_oracle_cards_name_trgm_idx
      ON scryfall_oracle_cards USING gin (normalized_name gin_trgm_ops)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS scryfall_card_faces_name_trgm_idx
      ON scryfall_card_faces USING gin (normalized_name gin_trgm_ops)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS scryfall_oracle_cards_color_identity_gin_idx
      ON scryfall_oracle_cards USING gin (color_identity)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS scryfall_oracle_cards_legalities_gin_idx
      ON scryfall_oracle_cards USING gin (legalities)
  `)
  await queryDatabase(`
    CREATE INDEX IF NOT EXISTS scryfall_oracle_cards_raw_card_gin_idx
      ON scryfall_oracle_cards USING gin (raw_card)
  `)
}

async function readScryfallOracleCardsFile(oracleCardsPath: string) {
  const readStartedAt = Date.now()
  console.error(`Reading Scryfall oracle_cards JSON from ${oracleCardsPath}...`)
  const cardsJson = await readFile(oracleCardsPath, "utf8")

  console.error(
    `Read Scryfall oracle_cards JSON in ${formatElapsedSeconds(readStartedAt)}s. Parsing...`
  )

  const parseStartedAt = Date.now()
  const cards = JSON.parse(cardsJson) as unknown

  if (!Array.isArray(cards)) {
    throw new Error("Scryfall oracle_cards JSON must be an array.")
  }

  console.error(
    `Parsed ${cards.length} Scryfall oracle_cards in ${formatElapsedSeconds(parseStartedAt)}s.`
  )

  return cards as ScryfallCard[]
}

async function upsertScryfallOracleCard(
  client: DbClient,
  {
    card,
    downloadedAt,
    scryfallUpdatedAt,
  }: {
    card: ScryfallCard
    downloadedAt: string
    scryfallUpdatedAt?: string
  }
) {
  const oracleId = requireString(card.oracle_id, "oracle_id", card)
  const scryfallId = requireString(card.id, "id", card)
  const scryfallUri = requireString(card.scryfall_uri, "scryfall_uri", card)
  const name = requireString(card.name, "name", card)
  const lang = requireString(card.lang, "lang", card)
  const layout = requireString(card.layout, "layout", card)

  await client.query(
    `
    INSERT INTO scryfall_oracle_cards (
      oracle_id,
      scryfall_id,
      scryfall_uri,
      name,
      normalized_name,
      default_image_url,
      lang,
      layout,
      mana_cost,
      cmc,
      type_line,
      oracle_text,
      power,
      toughness,
      loyalty,
      colors,
      color_identity,
      produced_mana,
      keywords,
      games,
      legalities,
      image_uris,
      card_faces,
      all_parts,
      raw_card,
      released_at,
      reserved,
      digital,
      game_changer,
      edhrec_rank,
      scryfall_updated_at,
      downloaded_at
    )
    VALUES (
      $1,
      $2,
      $3,
      $4,
      $5,
      $6,
      $7,
      $8,
      $9,
      $10,
      $11,
      $12,
      $13,
      $14,
      $15,
      $16::text[],
      $17::text[],
      $18::text[],
      $19::text[],
      $20::text[],
      $21::jsonb,
      $22::jsonb,
      $23::jsonb,
      $24::jsonb,
      $25::jsonb,
      $26,
      $27,
      $28,
      $29,
      $30,
      $31,
      $32
    )
    ON CONFLICT (oracle_id) DO UPDATE SET
      scryfall_id = EXCLUDED.scryfall_id,
      scryfall_uri = EXCLUDED.scryfall_uri,
      name = EXCLUDED.name,
      normalized_name = EXCLUDED.normalized_name,
      default_image_url = EXCLUDED.default_image_url,
      lang = EXCLUDED.lang,
      layout = EXCLUDED.layout,
      mana_cost = EXCLUDED.mana_cost,
      cmc = EXCLUDED.cmc,
      type_line = EXCLUDED.type_line,
      oracle_text = EXCLUDED.oracle_text,
      power = EXCLUDED.power,
      toughness = EXCLUDED.toughness,
      loyalty = EXCLUDED.loyalty,
      colors = EXCLUDED.colors,
      color_identity = EXCLUDED.color_identity,
      produced_mana = EXCLUDED.produced_mana,
      keywords = EXCLUDED.keywords,
      games = EXCLUDED.games,
      legalities = EXCLUDED.legalities,
      image_uris = EXCLUDED.image_uris,
      card_faces = EXCLUDED.card_faces,
      all_parts = EXCLUDED.all_parts,
      raw_card = EXCLUDED.raw_card,
      released_at = EXCLUDED.released_at,
      reserved = EXCLUDED.reserved,
      digital = EXCLUDED.digital,
      game_changer = EXCLUDED.game_changer,
      edhrec_rank = EXCLUDED.edhrec_rank,
      scryfall_updated_at = EXCLUDED.scryfall_updated_at,
      downloaded_at = EXCLUDED.downloaded_at,
      updated_at = now()
    `,
    [
      oracleId,
      scryfallId,
      scryfallUri,
      name,
      normalizeCardName(name),
      getCardDefaultImageUrl(card),
      lang,
      layout,
      card.mana_cost ?? null,
      card.cmc ?? null,
      card.type_line ?? null,
      card.oracle_text ?? null,
      card.power ?? null,
      card.toughness ?? null,
      card.loyalty ?? null,
      card.colors ?? [],
      card.color_identity ?? [],
      card.produced_mana ?? [],
      card.keywords ?? [],
      card.games ?? [],
      JSON.stringify(card.legalities ?? {}),
      nullableJson(card.image_uris),
      nullableJson(card.card_faces),
      nullableJson(card.all_parts),
      JSON.stringify(card),
      card.released_at ?? null,
      card.reserved ?? null,
      card.digital ?? null,
      card.game_changer ?? null,
      card.edhrec_rank ?? null,
      scryfallUpdatedAt ?? null,
      downloadedAt,
    ]
  )

  await client.query("DELETE FROM scryfall_card_faces WHERE oracle_id = $1", [
    oracleId,
  ])

  if (!card.card_faces?.length) {
    return
  }

  for (const [faceIndex, face] of card.card_faces.entries()) {
    const faceName = requireString(face.name, "card_faces.name", card)

    await client.query(
      `
      INSERT INTO scryfall_card_faces (
        oracle_id,
        face_index,
        name,
        normalized_name,
        default_image_url,
        mana_cost,
        type_line,
        oracle_text,
        colors,
        power,
        toughness,
        loyalty,
        image_uris,
        raw_face
      )
      VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7,
        $8,
        $9::text[],
        $10,
        $11,
        $12,
        $13::jsonb,
        $14::jsonb
      )
      `,
      [
        oracleId,
        faceIndex,
        faceName,
        normalizeCardName(faceName),
        getImageUrl(face.image_uris),
        face.mana_cost ?? null,
        face.type_line ?? null,
        face.oracle_text ?? null,
        face.colors ?? [],
        face.power ?? null,
        face.toughness ?? null,
        face.loyalty ?? null,
        nullableJson(face.image_uris),
        JSON.stringify(face),
      ]
    )
  }
}

function requireString(
  value: string | undefined,
  fieldName: string,
  card: ScryfallCard
) {
  if (value) {
    return value
  }

  throw new Error(
    `Scryfall card ${JSON.stringify(card.name ?? card.id ?? "unknown")} is missing ${fieldName}.`
  )
}

function normalizeCardName(name: string) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function getCardDefaultImageUrl(card: ScryfallCard) {
  return (
    getImageUrl(card.image_uris) ??
    getImageUrl(card.card_faces?.[0]?.image_uris)
  )
}

function getImageUrl(imageUris: ScryfallImageUris | undefined) {
  return imageUris?.normal ?? imageUris?.large ?? imageUris?.png ?? null
}

function nullableJson(value: unknown) {
  return value === undefined ? null : JSON.stringify(value)
}

function logScryfallOracleCardsImportProgress({
  importedCount,
  totalCount,
  startedAt,
}: {
  importedCount: number
  totalCount: number
  startedAt: number
}) {
  const percentComplete =
    totalCount > 0 ? Math.round((importedCount / totalCount) * 100) : 100

  console.error(
    `Scryfall oracle_cards import progress: ${importedCount}/${totalCount} (${percentComplete}%) after ${formatElapsedSeconds(startedAt)}s.`
  )
}

function formatElapsedSeconds(startedAt: number) {
  return ((Date.now() - startedAt) / 1000).toFixed(1)
}

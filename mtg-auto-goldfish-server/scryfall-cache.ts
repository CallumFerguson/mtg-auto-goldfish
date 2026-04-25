import { createWriteStream } from "node:fs"
import {
  access,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises"
import { dirname, join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fileURLToPath } from "node:url"
import { importScryfallOracleCardsToPostgres } from "./scryfall-postgres.js"

const SERVER_NAME = "mtg-auto-goldfish-server"
const SCRYFALL_BULK_DATA_URL = "https://api.scryfall.com/bulk-data"
const SCRYFALL_ORACLE_CARDS_TYPE = "oracle_cards"
const SCRYFALL_DATA_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const SCRYFALL_DATA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "data",
  "scryfall"
)
const SCRYFALL_ORACLE_CARDS_PATH = join(SCRYFALL_DATA_DIR, "oracle-cards.json")
const SCRYFALL_ORACLE_CARDS_TEMP_PATH = join(
  SCRYFALL_DATA_DIR,
  "oracle-cards.json.tmp"
)
const SCRYFALL_ORACLE_CARDS_METADATA_PATH = join(
  SCRYFALL_DATA_DIR,
  "oracle-cards.metadata.json"
)
const SCRYFALL_ORACLE_CARDS_METADATA_TEMP_PATH = join(
  SCRYFALL_DATA_DIR,
  "oracle-cards.metadata.json.tmp"
)

type ScryfallBulkDataCatalog = {
  data?: ScryfallBulkDataItem[]
}

type ScryfallBulkDataItem = {
  type?: string
  download_uri?: string
  updated_at?: string
}

type ScryfallOracleCardsMetadata = {
  downloaded_at?: string
  bulk_data?: ScryfallBulkDataCatalog
  postgres_import?: ScryfallOracleCardsPostgresImportMetadata
}

type ScryfallOracleCardsPostgresImportMetadata = {
  status: "success" | "pending" | "failed"
  imported_at?: string
  scryfall_updated_at?: string
  error?: string
}

class ScryfallOracleCardsPostgresImportError extends Error {
  constructor(cause: unknown) {
    super("Failed to import Scryfall oracle_cards into Postgres.", {
      cause,
    })
  }
}

export async function ensureFreshScryfallOracleCards() {
  const cacheState = await getScryfallOracleCardsCacheState()

  if (cacheState.isFresh && cacheState.isImportedToPostgres) {
    console.error(
      "Scryfall oracle_cards data is fresh and already imported into Postgres."
    )
    return
  }

  if (cacheState.isFresh) {
    console.error(
      `Local Scryfall oracle_cards JSON is fresh at ${SCRYFALL_ORACLE_CARDS_PATH}, but Postgres import is incomplete. Importing from local JSON...`
    )

    await importCachedScryfallOracleCardsToPostgres(cacheState.metadata)
    return
  }

  if (cacheState.exists) {
    console.error(
      "Cached Scryfall oracle_cards data is older than 7 days. Refreshing..."
    )
  } else {
    console.error("No cached Scryfall oracle_cards data found. Downloading...")
  }

  try {
    await downloadScryfallOracleCards()
  } catch (error) {
    if (error instanceof ScryfallOracleCardsPostgresImportError) {
      throw error
    }

    if (cacheState.exists) {
      throw new Error(
        "Cached Scryfall oracle_cards data is stale and could not be refreshed. Server startup cannot continue because Scryfall data must be fresh and imported into Postgres.",
        {
          cause: error,
        }
      )
    }

    throw error
  }
}

async function getScryfallOracleCardsCacheState() {
  const hasOracleCardsFile = await fileExists(SCRYFALL_ORACLE_CARDS_PATH)
  const metadata = await readScryfallOracleCardsMetadata()
  const downloadedAtMs = metadata?.downloaded_at
    ? Date.parse(metadata.downloaded_at)
    : Number.NaN
  const hasValidDownloadedAt = Number.isFinite(downloadedAtMs)
  const ageMs = hasValidDownloadedAt ? Date.now() - downloadedAtMs : Infinity

  return {
    exists: hasOracleCardsFile,
    isFresh: hasOracleCardsFile && ageMs <= SCRYFALL_DATA_MAX_AGE_MS,
    isImportedToPostgres:
      hasOracleCardsFile && metadata?.postgres_import?.status === "success",
    metadata,
  }
}

async function downloadScryfallOracleCards() {
  await mkdir(SCRYFALL_DATA_DIR, { recursive: true })
  await removeTempScryfallOracleCardsFile()
  await removeTempScryfallOracleCardsMetadataFile()

  const bulkDataCatalog = await getScryfallBulkDataCatalog()
  const oracleCardsBulkItem = getScryfallOracleCardsBulkItem(bulkDataCatalog)
  const downloadedAt = new Date().toISOString()

  if (!oracleCardsBulkItem.download_uri) {
    throw new Error(
      "Scryfall oracle_cards bulk item did not include download_uri."
    )
  }

  const response = await fetch(oracleCardsBulkItem.download_uri, {
    headers: getScryfallRequestHeaders(),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to download Scryfall oracle_cards data: ${response.status} ${response.statusText}`
    )
  }

  if (!response.body) {
    throw new Error("Scryfall oracle_cards download response had no body.")
  }

  await pipeline(
    Readable.fromWeb(response.body),
    createWriteStream(SCRYFALL_ORACLE_CARDS_TEMP_PATH)
  )
  await rename(SCRYFALL_ORACLE_CARDS_TEMP_PATH, SCRYFALL_ORACLE_CARDS_PATH)
  await writeScryfallOracleCardsMetadata(
    bulkDataCatalog,
    downloadedAt,
    getPendingPostgresImportMetadata(oracleCardsBulkItem.updated_at)
  )

  try {
    await importScryfallOracleCardsToPostgres({
      oracleCardsPath: SCRYFALL_ORACLE_CARDS_PATH,
      downloadedAt,
      scryfallUpdatedAt: oracleCardsBulkItem.updated_at,
    })
    await writeScryfallOracleCardsMetadata(
      bulkDataCatalog,
      downloadedAt,
      getSuccessfulPostgresImportMetadata(oracleCardsBulkItem.updated_at)
    )
  } catch (error) {
    await writeScryfallOracleCardsMetadata(
      bulkDataCatalog,
      downloadedAt,
      getFailedPostgresImportMetadata(error, oracleCardsBulkItem.updated_at)
    )
    throw new ScryfallOracleCardsPostgresImportError(error)
  }

  console.error(
    `Downloaded and imported Scryfall oracle_cards data from ${SCRYFALL_ORACLE_CARDS_PATH}`
  )
}

async function importCachedScryfallOracleCardsToPostgres(
  metadata: ScryfallOracleCardsMetadata | null
) {
  const downloadedAt = metadata?.downloaded_at

  if (!downloadedAt) {
    throw new Error(
      "Cannot import cached Scryfall oracle_cards because metadata is missing downloaded_at."
    )
  }

  if (!metadata.bulk_data) {
    throw new Error(
      "Cannot import cached Scryfall oracle_cards because metadata is missing bulk_data."
    )
  }

  const oracleCardsBulkItem = getScryfallOracleCardsBulkItem(metadata.bulk_data)

  await writeScryfallOracleCardsMetadata(
    metadata.bulk_data,
    downloadedAt,
    getPendingPostgresImportMetadata(oracleCardsBulkItem.updated_at)
  )

  try {
    await importScryfallOracleCardsToPostgres({
      oracleCardsPath: SCRYFALL_ORACLE_CARDS_PATH,
      downloadedAt,
      scryfallUpdatedAt: oracleCardsBulkItem.updated_at,
    })
    await writeScryfallOracleCardsMetadata(
      metadata.bulk_data,
      downloadedAt,
      getSuccessfulPostgresImportMetadata(oracleCardsBulkItem.updated_at)
    )
  } catch (error) {
    await writeScryfallOracleCardsMetadata(
      metadata.bulk_data,
      downloadedAt,
      getFailedPostgresImportMetadata(error, oracleCardsBulkItem.updated_at)
    )
    throw new ScryfallOracleCardsPostgresImportError(error)
  }
}

async function getScryfallBulkDataCatalog() {
  const response = await fetch(SCRYFALL_BULK_DATA_URL, {
    headers: getScryfallRequestHeaders(),
  })

  if (!response.ok) {
    throw new Error(
      `Failed to fetch Scryfall bulk data catalog: ${response.status} ${response.statusText}`
    )
  }

  return (await response.json()) as ScryfallBulkDataCatalog
}

function getScryfallOracleCardsBulkItem(catalog: ScryfallBulkDataCatalog) {
  const oracleCardsBulkItem = catalog.data?.find(
    (item) => item.type === SCRYFALL_ORACLE_CARDS_TYPE
  )

  if (!oracleCardsBulkItem) {
    throw new Error("Scryfall bulk data catalog did not include oracle_cards.")
  }

  return oracleCardsBulkItem
}

async function readScryfallOracleCardsMetadata() {
  try {
    const metadataJson = await readFile(
      SCRYFALL_ORACLE_CARDS_METADATA_PATH,
      "utf8"
    )

    return JSON.parse(metadataJson) as ScryfallOracleCardsMetadata
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null
    }

    if (error instanceof SyntaxError) {
      return null
    }

    throw error
  }
}

async function writeScryfallOracleCardsMetadata(
  bulkDataCatalog: ScryfallBulkDataCatalog,
  downloadedAt: string,
  postgresImport: ScryfallOracleCardsPostgresImportMetadata
) {
  const metadata = {
    downloaded_at: downloadedAt,
    bulk_data: bulkDataCatalog,
    postgres_import: postgresImport,
  } satisfies ScryfallOracleCardsMetadata

  await writeFile(
    SCRYFALL_ORACLE_CARDS_METADATA_TEMP_PATH,
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8"
  )
  await rename(
    SCRYFALL_ORACLE_CARDS_METADATA_TEMP_PATH,
    SCRYFALL_ORACLE_CARDS_METADATA_PATH
  )
}

function getPendingPostgresImportMetadata(
  scryfallUpdatedAt: string | undefined
): ScryfallOracleCardsPostgresImportMetadata {
  return {
    status: "pending",
    scryfall_updated_at: scryfallUpdatedAt,
  }
}

function getSuccessfulPostgresImportMetadata(
  scryfallUpdatedAt: string | undefined
): ScryfallOracleCardsPostgresImportMetadata {
  return {
    status: "success",
    imported_at: new Date().toISOString(),
    scryfall_updated_at: scryfallUpdatedAt,
  }
}

function getFailedPostgresImportMetadata(
  error: unknown,
  scryfallUpdatedAt: string | undefined
): ScryfallOracleCardsPostgresImportMetadata {
  return {
    status: "failed",
    scryfall_updated_at: scryfallUpdatedAt,
    error: getErrorMessage(error),
  }
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function getScryfallRequestHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": `${SERVER_NAME}/0.0.1`,
  }
}

async function removeTempScryfallOracleCardsFile() {
  try {
    await unlink(SCRYFALL_ORACLE_CARDS_TEMP_PATH)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return
    }

    throw error
  }
}

async function removeTempScryfallOracleCardsMetadataFile() {
  try {
    await unlink(SCRYFALL_ORACLE_CARDS_METADATA_TEMP_PATH)
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return
    }

    throw error
  }
}

async function fileExists(path: string) {
  try {
    await access(path)
    return true
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false
    }

    throw error
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error
}

import type { DeckEntry, ResolvedCard, ScryfallCard } from "../types"

const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection"
const SCRYFALL_NAMED_URL = "https://api.scryfall.com/cards/named"
const SCRYFALL_CACHE_KEY = "scryfall-card-cache"
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

type CacheEntry = {
  cachedAt: number
} & (
  | {
      status: "found"
      card: ScryfallCard
    }
  | {
      status: "not_found"
    }
)

type CardCache = Record<string, CacheEntry>

export function toOracleText(card: ScryfallCard) {
  if (card.oracle_text?.trim()) {
    return card.oracle_text.trim()
  }

  if (!card.card_faces?.length) {
    return ""
  }

  return card.card_faces
    .map((face) =>
      [face.name, face.mana_cost, face.type_line, face.oracle_text]
        .filter(Boolean)
        .join("\n")
        .trim()
    )
    .filter(Boolean)
    .join("\n\n")
}

export function toTypeLine(card: ScryfallCard) {
  if (card.type_line?.trim()) {
    return card.type_line.trim()
  }

  if (!card.card_faces?.length) {
    return ""
  }

  return card.card_faces
    .map((face) => face.type_line?.trim())
    .filter(Boolean)
    .join(" // ")
}

export function toManaCost(card: ScryfallCard) {
  if (card.mana_cost?.trim()) {
    return card.mana_cost.trim()
  }

  if (!card.card_faces?.length) {
    return ""
  }

  return card.card_faces
    .map((face) => face.mana_cost?.trim())
    .filter(Boolean)
    .join(" // ")
}

export function toResolvedCard(
  entry: DeckEntry,
  card: ScryfallCard,
  source: ResolvedCard["source"] = "scryfall"
): ResolvedCard {
  const firstFaceWithStats = card.card_faces?.find(
    (face) => face.power || face.toughness || face.loyalty
  )

  return {
    requestedName: entry.name,
    name: card.name,
    quantity: entry.quantity,
    manaCost: toManaCost(card),
    typeLine: toTypeLine(card),
    oracleText: toOracleText(card),
    power: card.power ?? firstFaceWithStats?.power,
    toughness: card.toughness ?? firstFaceWithStats?.toughness,
    loyalty: card.loyalty ?? firstFaceWithStats?.loyalty,
    source,
    matchedCard: source === "fuzzy" ? card : undefined,
  }
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = []

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size))
  }

  return chunks
}

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function loadCache() {
  if (typeof window === "undefined") {
    return {} as CardCache
  }

  try {
    const rawValue = window.localStorage.getItem(SCRYFALL_CACHE_KEY)

    if (!rawValue) {
      return {} as CardCache
    }

    const parsedValue = JSON.parse(rawValue)

    if (!parsedValue || typeof parsedValue !== "object") {
      return {} as CardCache
    }

    const now = Date.now()
    const nextCache = Object.entries(parsedValue).reduce<CardCache>(
      (cache, [key, value]) => {
        if (!value || typeof value !== "object") {
          return cache
        }

        const entry = value as Partial<CacheEntry>

        if (
          typeof entry.cachedAt !== "number" ||
          now - entry.cachedAt >= CACHE_TTL_MS
        ) {
          return cache
        }

        if (entry.status === "found" && entry.card) {
          cache[key] = {
            status: "found",
            card: entry.card,
            cachedAt: entry.cachedAt,
          }
        }

        if (entry.status === "not_found") {
          cache[key] = {
            status: "not_found",
            cachedAt: entry.cachedAt,
          }
        }

        return cache
      },
      {}
    )

    if (Object.keys(nextCache).length !== Object.keys(parsedValue).length) {
      saveCache(nextCache)
    }

    return nextCache
  } catch {
    return {} as CardCache
  }
}

function saveCache(cache: CardCache) {
  if (typeof window === "undefined") {
    return
  }

  try {
    window.localStorage.setItem(SCRYFALL_CACHE_KEY, JSON.stringify(cache))
  } catch {
    // Ignore storage failures so lookups still work when storage is unavailable.
  }
}

function getCachedCard(cache: CardCache, key: string) {
  const entry = cache[key]

  if (!entry) {
    return null
  }

  if (Date.now() - entry.cachedAt >= CACHE_TTL_MS) {
    delete cache[key]
    saveCache(cache)
    return null
  }

  return entry
}

function setCachedFoundCard(cache: CardCache, key: string, card: ScryfallCard) {
  cache[key] = {
    status: "found",
    card,
    cachedAt: Date.now(),
  }
}

function setCachedNotFound(cache: CardCache, key: string) {
  cache[key] = {
    status: "not_found",
    cachedAt: Date.now(),
  }
}

async function fetchNamedCardFuzzy(name: string) {
  const response = await fetch(
    `${SCRYFALL_NAMED_URL}?fuzzy=${encodeURIComponent(name)}`,
    {
      headers: {
        Accept: "application/json;q=0.9,*/*;q=0.8",
      },
    }
  )

  if (!response.ok) {
    return null
  }

  return (await response.json()) as ScryfallCard
}

export async function fetchCardsByName(names: string[]) {
  const uniqueNames = Array.from(new Set(names))
  const results = new Map<string, ScryfallCard>()
  const fuzzyMatches = new Map<string, ScryfallCard>()
  const notFound = new Set<string>()
  const cache = loadCache()
  const uncachedNames: string[] = []

  for (const name of uniqueNames) {
    const lookupKey = name.toLowerCase()
    const cachedEntry = getCachedCard(cache, lookupKey)

    if (!cachedEntry) {
      uncachedNames.push(name)
      continue
    }

    if (cachedEntry.status === "found") {
      if (cachedEntry.card.name.toLowerCase() === lookupKey) {
        results.set(lookupKey, cachedEntry.card)
      } else {
        fuzzyMatches.set(lookupKey, cachedEntry.card)
      }
      continue
    }

    notFound.add(lookupKey)
  }

  for (const nameChunk of chunk(uncachedNames, 75)) {
    const response = await fetch(SCRYFALL_COLLECTION_URL, {
      method: "POST",
      headers: {
        Accept: "application/json;q=0.9,*/*;q=0.8",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        identifiers: nameChunk.map((name) => ({ name })),
      }),
    })

    if (!response.ok) {
      throw new Error("Scryfall lookup failed. Please try again.")
    }

    const payload = (await response.json()) as {
      data?: ScryfallCard[]
      not_found?: Array<{ name?: string }>
    }

    for (const card of payload.data ?? []) {
      const lookupKey = card.name.toLowerCase()
      results.set(lookupKey, card)
      setCachedFoundCard(cache, lookupKey, card)
    }

    for (const missing of payload.not_found ?? []) {
      if (missing.name) {
        const lookupKey = missing.name.toLowerCase()
        notFound.add(lookupKey)
        setCachedNotFound(cache, lookupKey)
      }
    }
  }

  const unresolvedNames = uncachedNames.filter(
    (name) => !results.has(name.toLowerCase())
  )

  for (const name of unresolvedNames) {
    const fuzzyMatch = await fetchNamedCardFuzzy(name)
    const lookupKey = name.toLowerCase()

    if (fuzzyMatch) {
      fuzzyMatches.set(lookupKey, fuzzyMatch)
      setCachedFoundCard(cache, lookupKey, fuzzyMatch)
    } else {
      notFound.add(lookupKey)
      setCachedNotFound(cache, lookupKey)
    }
    await delay(120)
  }

  saveCache(cache)

  return { results, fuzzyMatches, notFound }
}

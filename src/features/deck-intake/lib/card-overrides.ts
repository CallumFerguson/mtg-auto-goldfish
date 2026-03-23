import type { ScryfallCard } from "../types"

const CARD_OVERRIDES_STORAGE_KEY = "deck-intake-card-overrides"

type FuzzyCardOverride = {
  kind: "fuzzy"
  card: ScryfallCard
}

type ManualCardOverride = {
  kind: "manual"
  manualText: string
}

export type CardOverride = FuzzyCardOverride | ManualCardOverride

type CardOverrides = Record<string, CardOverride>

function normalizeName(name: string) {
  return name.trim().toLowerCase()
}

function loadCardOverrides() {
  if (typeof window === "undefined") {
    return {} as CardOverrides
  }

  try {
    const rawValue = window.localStorage.getItem(CARD_OVERRIDES_STORAGE_KEY)

    if (!rawValue) {
      return {} as CardOverrides
    }

    const parsedValue = JSON.parse(rawValue)

    if (!parsedValue || typeof parsedValue !== "object") {
      return {} as CardOverrides
    }

    return Object.entries(parsedValue).reduce<CardOverrides>(
      (overrides, [key, value]) => {
        if (!value || typeof value !== "object") {
          return overrides
        }

        const override = value as Partial<CardOverride>

        if (override.kind === "fuzzy" && override.card) {
          overrides[key] = {
            kind: "fuzzy",
            card: override.card,
          }
        }

        if (
          override.kind === "manual" &&
          typeof override.manualText === "string" &&
          override.manualText.trim()
        ) {
          overrides[key] = {
            kind: "manual",
            manualText: override.manualText,
          }
        }

        return overrides
      },
      {}
    )
  } catch {
    return {} as CardOverrides
  }
}

function saveCardOverrides(overrides: CardOverrides) {
  if (typeof window === "undefined") {
    return
  }

  try {
    window.localStorage.setItem(
      CARD_OVERRIDES_STORAGE_KEY,
      JSON.stringify(overrides)
    )
  } catch {
    // Ignore storage failures so deck processing still works.
  }
}

export function getCardOverride(name: string) {
  const lookupKey = normalizeName(name)

  if (!lookupKey) {
    return null
  }

  return loadCardOverrides()[lookupKey] ?? null
}

export function saveAcceptedFuzzyMatch(name: string, card: ScryfallCard) {
  const lookupKey = normalizeName(name)

  if (!lookupKey) {
    return
  }

  const overrides = loadCardOverrides()
  overrides[lookupKey] = {
    kind: "fuzzy",
    card,
  }
  saveCardOverrides(overrides)
}

export function saveManualCardText(name: string, manualText: string) {
  const lookupKey = normalizeName(name)

  if (!lookupKey) {
    return
  }

  const overrides = loadCardOverrides()
  const trimmedText = manualText.trim()

  if (!trimmedText) {
    delete overrides[lookupKey]
  } else {
    overrides[lookupKey] = {
      kind: "manual",
      manualText,
    }
  }

  saveCardOverrides(overrides)
}

export function clearCardOverride(name: string) {
  const lookupKey = normalizeName(name)

  if (!lookupKey) {
    return
  }

  const overrides = loadCardOverrides()

  if (!overrides[lookupKey]) {
    return
  }

  delete overrides[lookupKey]
  saveCardOverrides(overrides)
}

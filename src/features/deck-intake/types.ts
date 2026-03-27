export type DeckEntry = {
  quantity: number
  name: string
}

export type ResolvedCard = {
  requestedName: string
  name: string
  quantity: number
  manaCost: string
  typeLine: string
  oracleText: string
  power?: string
  toughness?: string
  loyalty?: string
  source: "scryfall" | "fuzzy" | "manual"
  matchedCard?: ScryfallCard
  isCommander?: boolean
}

export type MissingCard = {
  name: string
  quantity: number
  manualText: string
  isAccepted: boolean
  rejectedSuggestion?: ScryfallCard
}

export type ScryfallCardFace = {
  name?: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  image_uris?: {
    small?: string
    normal?: string
    large?: string
  }
}

export type ScryfallCard = {
  name: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  image_uris?: {
    small?: string
    normal?: string
    large?: string
  }
  set_name?: string
  collector_number?: string
  rarity?: string
  scryfall_uri?: string
  card_faces?: ScryfallCardFace[]
}

export type FuzzyMatch = {
  name: string
  quantity: number
  suggestedCard: ScryfallCard
}

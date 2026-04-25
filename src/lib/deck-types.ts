export type Deck = {
  id: string
  name: string
  description: string | null
}

export type DeckCard = {
  oracleId: string
  name: string
  quantity: number
  scryfallUri: string
  defaultImageUrl: string | null
  typeLine: string | null
}

export type DeckDetails = Deck & {
  commanders: DeckCard[]
  cards: DeckCard[]
}

export type DecksResponse = {
  decks: Deck[]
}

export type DeckResponse = {
  deck: DeckDetails
}

export type SimulationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"

export type Simulation = {
  id: string
  deckId: string
  seed: string
  turnsToSimulate: number
  status: SimulationStatus
  createdAt: string
  updatedAt: string
}

export type SimulationsResponse = {
  simulations: Simulation[]
}

import {
  DEFAULT_COMMANDER_ONE,
  DEFAULT_DECKLIST,
} from "../constants"

const DECK_INPUT_STORAGE_KEY = "deck-intake-state"

export type StoredDeckInput = {
  commanderOneName: string
  commanderTwoName: string
  decklistText: string
  simulationSeedInput: string
}

export const DEFAULT_DECK_INPUT: StoredDeckInput = {
  commanderOneName: DEFAULT_COMMANDER_ONE,
  commanderTwoName: "",
  decklistText: DEFAULT_DECKLIST,
  simulationSeedInput: "",
}

export function loadStoredDeckInput(): StoredDeckInput {
  if (typeof window === "undefined") {
    return DEFAULT_DECK_INPUT
  }

  try {
    const rawValue = window.localStorage.getItem(DECK_INPUT_STORAGE_KEY)

    if (!rawValue) {
      return DEFAULT_DECK_INPUT
    }

    const parsedValue = JSON.parse(rawValue) as Partial<StoredDeckInput>

    return {
      commanderOneName:
        typeof parsedValue.commanderOneName === "string"
          ? parsedValue.commanderOneName
          : DEFAULT_DECK_INPUT.commanderOneName,
      commanderTwoName:
        typeof parsedValue.commanderTwoName === "string"
          ? parsedValue.commanderTwoName
          : DEFAULT_DECK_INPUT.commanderTwoName,
      decklistText:
        typeof parsedValue.decklistText === "string"
          ? parsedValue.decklistText
          : DEFAULT_DECK_INPUT.decklistText,
      simulationSeedInput:
        typeof parsedValue.simulationSeedInput === "string"
          ? parsedValue.simulationSeedInput
          : DEFAULT_DECK_INPUT.simulationSeedInput,
    }
  } catch {
    return DEFAULT_DECK_INPUT
  }
}

export function saveStoredDeckInput(deckInput: StoredDeckInput) {
  if (typeof window === "undefined") {
    return
  }

  try {
    window.localStorage.setItem(DECK_INPUT_STORAGE_KEY, JSON.stringify(deckInput))
  } catch {
    // Ignore storage failures so deck editing still works.
  }
}

import { FormEvent, useMemo, useState } from "react"
import {
  AlertTriangle,
  CheckCircle2,
  LoaderCircle,
  Search,
  Sparkles,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type DeckEntry = {
  quantity: number
  name: string
}

type ResolvedCard = {
  name: string
  quantity: number
  manaCost: string
  typeLine: string
  oracleText: string
  power?: string
  toughness?: string
  loyalty?: string
  source: "scryfall" | "fuzzy" | "manual"
}

type MissingCard = {
  name: string
  quantity: number
  manualText: string
}

type FuzzyMatch = {
  name: string
  quantity: number
  suggestedCard: ScryfallCard
}

type ScryfallCardFace = {
  name?: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
}

type ScryfallCard = {
  name: string
  mana_cost?: string
  type_line?: string
  oracle_text?: string
  power?: string
  toughness?: string
  loyalty?: string
  card_faces?: ScryfallCardFace[]
}

const DEFAULT_COMMANDER_ONE = "Pantlaza, Sun-Favored"

const DEFAULT_DECKLIST = `1 Akroma's Will
1 Apex Altisaur
1 Arcane Signet
1 Arch of Orazca
1 Atzocan Seer
1 Bellowing Aegisaur
1 Bronzebeak Foragers
1 Canopy Vista
1 Chandra's Ignition
1 Cinder Glade
1 Clifftop Retreat
1 Command Tower
1 Cultivate
1 Curious Altisaur
1 Deathgorge Scavenger
1 Descendants' Path
1 Dinosaur Egg
1 Drover of the Mighty
1 Earthshaker Dreadmaw
1 Etali, Primal Storm
1 Evolving Wilds
1 Exotic Orchard
1 Farseek
1 Fiery Confluence
8 Forest
1 Fortified Village
1 From the Rubble
1 Furycalm Snarl
1 Game Trail
1 Generous Gift
1 Itzquinth, Firstborn of Gishath
1 Ixalli's Lorekeeper
1 Jungle Shrine
1 Kessig Wolf Run
1 Kinjalli's Sunwing
1 Xenagos, God of Revels
1 Lifecrafter's Bestiary
1 Majestic Heliopterus
1 Marauding Raptor
1 Migration Path
1 Mosswort Bridge
4 Mountain
1 Myriad Landscape
1 Otepec Huntmaster
1 Path of Ancestry
1 Path to Exile
4 Plains
1 Progenitor's Icon
1 Quartzwood Crasher
1 Raging Regisaur
1 Raging Swordtooth
1 Rampaging Brontodon
1 Rampant Growth
1 Ranging Raptors
1 Regal Behemoth
1 Regisaur Alpha
1 Return of the Wildspeaker
1 Rhythm of the Wild
1 Ripjaw Raptor
1 Rishkar's Expertise
1 Rogue's Passage
1 Runic Armasaur
1 Savage Stomp
1 Scion of Calamity
1 Secluded Courtyard
1 Shifting Ceratops
1 Sol Ring
1 Sunfrill Imitator
1 Temple Altisaur
1 Temple of the False God
1 Terramorphic Expanse
1 Thrashing Brontodon
1 Thriving Bluff
1 Thriving Grove
1 Thriving Heath
1 Thunderherd Migration
1 Thundering Spineback
1 Topiary Stomper
1 Unclaimed Territory
1 Verdant Sun's Avatar
1 Wakening Sun's Avatar
1 Wayta, Trainer Prodigy
1 Wayward Swordtooth
1 Wrathful Raptors
1 Zacama, Primal Calamity
1 Zetalpa, Primal Dawn`

const SAMPLE_DECKLIST = `1 Sol Ring
1 Arcane Signet
1 Fellwar Stone
1 Swords to Plowshares
1 Cultivate
1 Heroic Intervention`

const SCRYFALL_COLLECTION_URL = "https://api.scryfall.com/cards/collection"
const SCRYFALL_NAMED_URL = "https://api.scryfall.com/cards/named"

function normalizeCardName(rawName: string) {
  return rawName
    .replace(/\s+\([^)]*\)\s+\d+[a-zA-Z]?$/u, "")
    .replace(/\s+\([^)]*\)$/u, "")
    .replace(/\s+\/\/\s+/gu, " // ")
    .trim()
}

function parseCommanderInput(rawName: string) {
  const trimmed = rawName.trim()

  if (!trimmed) {
    return {
      quantity: 0,
      name: "",
    }
  }

  const quantityMatch = trimmed.match(/^(\d+)\s*x?\s+(.+)$/iu)

  if (quantityMatch) {
    return {
      quantity: Number(quantityMatch[1]),
      name: normalizeCardName(quantityMatch[2]),
    }
  }

  return {
    quantity: 1,
    name: normalizeCardName(trimmed),
  }
}

function parseDeckLine(line: string) {
  const trimmed = line.trim()

  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) {
    return null
  }

  const quantityMatch = trimmed.match(/^(\d+)\s*x?\s+(.+)$/iu)

  if (quantityMatch) {
    return {
      quantity: Number(quantityMatch[1]),
      name: normalizeCardName(quantityMatch[2]),
    }
  }

  return {
    quantity: 1,
    name: normalizeCardName(trimmed),
  }
}

function parseDecklist(decklistText: string) {
  return decklistText
    .split(/\r?\n/u)
    .map(parseDeckLine)
    .filter((entry): entry is DeckEntry => Boolean(entry?.name))
}

function toOracleText(card: ScryfallCard) {
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

function toTypeLine(card: ScryfallCard) {
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

function toManaCost(card: ScryfallCard) {
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

function toResolvedCard(
  entry: DeckEntry,
  card: ScryfallCard,
  source: ResolvedCard["source"] = "scryfall"
): ResolvedCard {
  const firstFaceWithStats = card.card_faces?.find(
    (face) => face.power || face.toughness || face.loyalty
  )

  return {
    name: card.name,
    quantity: entry.quantity,
    manaCost: toManaCost(card),
    typeLine: toTypeLine(card),
    oracleText: toOracleText(card),
    power: card.power ?? firstFaceWithStats?.power,
    toughness: card.toughness ?? firstFaceWithStats?.toughness,
    loyalty: card.loyalty ?? firstFaceWithStats?.loyalty,
    source,
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

async function fetchCardsByName(names: string[]) {
  const uniqueNames = Array.from(new Set(names))
  const results = new Map<string, ScryfallCard>()
  const fuzzyMatches = new Map<string, ScryfallCard>()
  const notFound = new Set<string>()

  for (const nameChunk of chunk(uniqueNames, 75)) {
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
      results.set(card.name.toLowerCase(), card)
    }

    for (const missing of payload.not_found ?? []) {
      if (missing.name) {
        notFound.add(missing.name.toLowerCase())
      }
    }
  }

  const unresolvedNames = uniqueNames.filter(
    (name) => !results.has(name.toLowerCase())
  )

  for (const name of unresolvedNames) {
    const fuzzyMatch = await fetchNamedCardFuzzy(name)

    if (fuzzyMatch) {
      fuzzyMatches.set(name.toLowerCase(), fuzzyMatch)
    } else {
      notFound.add(name.toLowerCase())
    }

    // Stay comfortably below Scryfall's published 10 req/sec guidance.
    await delay(120)
  }

  return { results, fuzzyMatches, notFound }
}

function StatLine({
  power,
  toughness,
  loyalty,
}: Pick<ResolvedCard, "power" | "toughness" | "loyalty">) {
  if (power && toughness) {
    return <span>{power}/{toughness}</span>
  }

  if (loyalty) {
    return <span>Loyalty {loyalty}</span>
  }

  return null
}

export function App() {
  const [commanderOneName, setCommanderOneName] =
    useState(DEFAULT_COMMANDER_ONE)
  const [commanderTwoName, setCommanderTwoName] = useState("")
  const [decklistText, setDecklistText] = useState(DEFAULT_DECKLIST)
  const [resolvedCards, setResolvedCards] = useState<ResolvedCard[]>([])
  const [fuzzyMatches, setFuzzyMatches] = useState<FuzzyMatch[]>([])
  const [missingCards, setMissingCards] = useState<MissingCard[]>([])
  const [lookupError, setLookupError] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)

  const parsedDeck = useMemo(() => parseDecklist(decklistText), [decklistText])
  const totalCards = parsedDeck.reduce(
    (runningTotal, entry) => runningTotal + entry.quantity,
    0
  )
  const commanderOneInput = useMemo(
    () => parseCommanderInput(commanderOneName),
    [commanderOneName]
  )
  const commanderTwoInput = useMemo(
    () => parseCommanderInput(commanderTwoName),
    [commanderTwoName]
  )
  const commanderOne = commanderOneInput.name
  const commanderTwo = commanderTwoInput.name
  const commanders = [commanderOne, commanderTwo].filter(Boolean)
  const commanderCount = commanders.length
  const expectedDecklistCount = 100 - commanderCount
  const deckCountDelta = totalCards - expectedDecklistCount
  const hasCommanderTwoWithoutCommanderOne = Boolean(
    commanderTwo && !commanderOne
  )
  const hasTooManyCommanderCopies =
    commanderOneInput.quantity > 1 || commanderTwoInput.quantity > 1
  const hasDuplicateCommanders =
    Boolean(commanderOne) &&
    Boolean(commanderTwo) &&
    commanderOne.toLowerCase() === commanderTwo.toLowerCase()
  const hasValidCommanderSetup =
    Boolean(commanderOne) &&
    !hasCommanderTwoWithoutCommanderOne &&
    !hasTooManyCommanderCopies &&
    !hasDuplicateCommanders
  const hasValidDeckCount =
    (commanderCount === 1 && totalCards === 99) ||
    (commanderCount === 2 && totalCards === 98)
  const validationMessage = hasCommanderTwoWithoutCommanderOne
    ? "Commander 2 is filled in, but Commander 1 is empty. Add the first commander before adding a second."
    : commanderOneInput.quantity > 1
      ? `Commander 1 has ${commanderOneInput.quantity} copies entered. A commander slot can only contain 1 card.`
      : commanderTwoInput.quantity > 1
        ? `Commander 2 has ${commanderTwoInput.quantity} copies entered. A commander slot can only contain 1 card.`
        : hasDuplicateCommanders
          ? "Commander 1 and Commander 2 are the same card. Use two different commanders or leave Commander 2 empty."
    : !commanderCount
      ? "Add at least one commander before processing the deck."
      : !hasValidDeckCount
        ? commanderCount === 1
          ? `Your main deck has ${totalCards} cards. With 1 commander, it must have exactly 99 cards.`
          : `Your main deck has ${totalCards} cards. With 2 commanders, it must have exactly 98 cards.`
        : ""
  const canProcess = hasValidCommanderSetup && hasValidDeckCount && !isProcessing

  const completedCards = useMemo(
    () =>
      resolvedCards.concat(
        missingCards
          .filter((card) => card.manualText.trim())
          .map((card) => ({
            name: card.name,
            quantity: card.quantity,
            manaCost: "",
            typeLine: "Manual entry",
            oracleText: card.manualText.trim(),
            source: "manual" as const,
          }))
      ),
    [missingCards, resolvedCards]
  )

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const cleanedCommanders = [commanderOneInput, commanderTwoInput]
      .map((commander) => commander.name)
      .filter(Boolean)
    const entries = parseDecklist(decklistText)

    if (hasCommanderTwoWithoutCommanderOne) {
      setLookupError(
        "Commander 2 is filled in, but Commander 1 is empty. Add the first commander before adding a second."
      )
      return
    }

    if (commanderOneInput.quantity > 1) {
      setLookupError(
        `Commander 1 has ${commanderOneInput.quantity} copies entered. A commander slot can only contain 1 card.`
      )
      return
    }

    if (commanderTwoInput.quantity > 1) {
      setLookupError(
        `Commander 2 has ${commanderTwoInput.quantity} copies entered. A commander slot can only contain 1 card.`
      )
      return
    }

    if (hasDuplicateCommanders) {
      setLookupError(
        "Commander 1 and Commander 2 are the same card. Use two different commanders or leave Commander 2 empty."
      )
      return
    }

    if (!cleanedCommanders.length) {
      setLookupError("Add at least one commander before processing the deck.")
      return
    }

    if (!entries.length) {
      setLookupError("Paste your main deck cards before processing.")
      return
    }

    if (cleanedCommanders.length === 1 && totalCards !== 99) {
      setLookupError(
        `Your main deck has ${totalCards} cards. With 1 commander, it must have exactly 99 cards.`
      )
      return
    }

    if (cleanedCommanders.length === 2 && totalCards !== 98) {
      setLookupError(
        `Your main deck has ${totalCards} cards. With 2 commanders, it must have exactly 98 cards.`
      )
      return
    }

    setIsProcessing(true)
    setLookupError("")
    setResolvedCards([])
    setFuzzyMatches([])
    setMissingCards([])

    try {
      const commanderEntries = cleanedCommanders.map((name) => ({
        name,
        quantity: 1,
      }))
      const allEntries = [...commanderEntries, ...entries]
      const { results, fuzzyMatches, notFound } = await fetchCardsByName(
        allEntries.map((entry) => entry.name)
      )

      const nextResolvedCards: ResolvedCard[] = []
      const nextFuzzyMatches: FuzzyMatch[] = []
      const nextMissingCards: MissingCard[] = []

      for (const entry of allEntries) {
        const lookupKey = entry.name.toLowerCase()
        const card = results.get(lookupKey)

        if (card) {
          nextResolvedCards.push(toResolvedCard(entry, card))
          continue
        }

        const fuzzyMatch = fuzzyMatches.get(lookupKey)

        if (fuzzyMatch) {
          nextFuzzyMatches.push({
            name: entry.name,
            quantity: entry.quantity,
            suggestedCard: fuzzyMatch,
          })
          continue
        }

        if (notFound.has(lookupKey) || !card) {
          nextMissingCards.push({
            name: entry.name,
            quantity: entry.quantity,
            manualText: "",
          })
        }
      }

      setResolvedCards(nextResolvedCards)
      setFuzzyMatches(nextFuzzyMatches)
      setMissingCards(nextMissingCards)
    } catch (error) {
      setLookupError(
        error instanceof Error
          ? error.message
          : "Something went wrong while processing the deck."
      )
    } finally {
      setIsProcessing(false)
    }
  }

  function updateManualText(name: string, manualText: string) {
    setMissingCards((currentCards) =>
      currentCards.map((card) =>
        card.name === name ? { ...card, manualText } : card
      )
    )
  }

  function acceptFuzzyMatch(match: FuzzyMatch) {
    setResolvedCards((currentCards) => [
      ...currentCards,
      toResolvedCard(
        { name: match.name, quantity: match.quantity },
        match.suggestedCard,
        "fuzzy"
      ),
    ])
    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
  }

  function rejectFuzzyMatch(match: FuzzyMatch) {
    setFuzzyMatches((currentMatches) =>
      currentMatches.filter((currentMatch) => currentMatch.name !== match.name)
    )
    setMissingCards((currentCards) => [
      ...currentCards,
      {
        name: match.name,
        quantity: match.quantity,
        manualText: "",
      },
    ])
  }

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top,rgba(245,158,11,0.2),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(120,53,15,0.3),transparent_30%),linear-gradient(180deg,#09090b_0%,#111217_50%,#18181b_100%)] text-stone-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-10">
        <section className="overflow-hidden rounded-[28px] border border-black/10 bg-stone-950 text-stone-100 shadow-2xl shadow-amber-950/20">
          <div className="grid gap-8 px-6 py-8 lg:grid-cols-[1.1fr_0.9fr] lg:px-8">
            <div className="space-y-5">
              <div className="inline-flex items-center gap-2 rounded-full border border-amber-200/15 bg-white/5 px-3 py-1 text-xs uppercase tracking-[0.24em] text-amber-100/80">
                <Sparkles className="size-3.5" />
                AI Goldfish Setup
              </div>
              <div className="space-y-3">
                <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
                  Turn a raw decklist into AI-ready gameplay text.
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-stone-300 sm:text-base">
                  Paste a standard mass-entry list, add your commander, and we
                  will pull the relevant rules text from Scryfall so the agent
                  has clean card context to goldfish with.
                </p>
              </div>
            </div>

            <div className="grid gap-4 rounded-[24px] border border-white/10 bg-white/6 p-5 backdrop-blur">
              <div className="grid gap-1">
                <span className="text-xs uppercase tracking-[0.2em] text-stone-400">
                  Current input
                </span>
                <span className="text-3xl font-semibold">{totalCards}</span>
                <span className="text-sm text-stone-300">
                  cards parsed from the main deck box
                </span>
                <span className="text-sm text-stone-400">
                  Target: {expectedDecklistCount} cards with {commanderCount || 0}{" "}
                  commander{commanderCount === 1 ? "" : "s"}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
                  <div className="text-2xl font-semibold">{commanderCount}</div>
                  <div className="text-sm text-stone-300">commanders set</div>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
                  <div className="text-2xl font-semibold">
                    {deckCountDelta === 0
                      ? "On target"
                      : deckCountDelta > 0
                        ? `+${deckCountDelta}`
                        : deckCountDelta}
                  </div>
                  <div className="text-sm text-stone-300">deck count delta</div>
                </div>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/15 p-4">
                <div className="text-2xl font-semibold">
                  {fuzzyMatches.length}
                </div>
                <div className="text-sm text-stone-300">need fuzzy review</div>
              </div>
            </div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,0.95fr)]">
          <section className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
            <div className="mb-6 space-y-2">
              <h2 className="text-2xl font-semibold tracking-tight">
                Deck intake
              </h2>
              <p className="max-w-2xl text-sm leading-6 text-stone-400">
                Add one or two commanders separately so we can always keep them
                explicit. The deck box accepts common MTG mass-entry styles such
                as <span className="font-medium">1 Sol Ring</span> or{" "}
                <span className="font-medium">4 Lightning Bolt</span>.
              </p>
            </div>

            <form className="space-y-5" onSubmit={handleSubmit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-2">
                  <span className="text-sm font-medium text-stone-100">
                    Commander 1
                  </span>
                  <input
                    value={commanderOneName}
                    onChange={(event) => setCommanderOneName(event.target.value)}
                    placeholder="Atraxa, Praetors' Voice"
                    className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-medium text-stone-100">
                    Commander 2
                  </span>
                  <input
                    value={commanderTwoName}
                    onChange={(event) => setCommanderTwoName(event.target.value)}
                    placeholder="Optional partner / background / second commander"
                    className="h-12 rounded-2xl border border-white/10 bg-black/30 px-4 text-sm text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
                  />
                </label>
              </div>

              <label className="grid gap-2">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-stone-100">
                    Decklist
                  </span>
                  <span className="text-xs uppercase tracking-[0.18em] text-stone-500">
                    Expect {expectedDecklistCount} cards in main deck
                  </span>
                </div>
                <textarea
                  value={decklistText}
                  onChange={(event) => setDecklistText(event.target.value)}
                  placeholder={SAMPLE_DECKLIST}
                  className="min-h-80 rounded-[24px] border border-white/10 bg-black/30 px-4 py-3 font-mono text-sm leading-6 text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400/70 focus:bg-black/40 focus:ring-4 focus:ring-amber-400/20"
                />
              </label>

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="submit"
                  size="lg"
                  className="h-11 rounded-full bg-stone-950 px-5 text-stone-50 hover:bg-stone-800"
                  disabled={!canProcess}
                >
                  {isProcessing ? (
                    <>
                      <LoaderCircle className="animate-spin" />
                      Processing deck
                    </>
                  ) : (
                    <>
                      <Search />
                      Process with Scryfall
                    </>
                  )}
                </Button>
                <p className="text-sm text-stone-400">
                  Commander decks are 100 cards total, so the deck box should
                  contain {expectedDecklistCount} cards with the current
                  commander setup.
                </p>
              </div>

              {validationMessage ? (
                <div className="rounded-2xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm text-amber-100">
                  {validationMessage}
                </div>
              ) : null}
            </form>

            {lookupError ? (
              <div className="mt-5 flex items-start gap-3 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <p>{lookupError}</p>
              </div>
            ) : null}
          </section>

          <section className="grid gap-6">
            <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <h2 className="text-2xl font-semibold tracking-tight">
                    Processed card text
                  </h2>
                  <p className="text-sm leading-6 text-stone-400">
                    This is the card context the future goldfish agent will use.
                  </p>
                </div>
                {completedCards.length ? (
                  <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-700">
                    <CheckCircle2 className="size-3.5" />
                    {completedCards.length} ready
                  </div>
                ) : null}
              </div>

              {completedCards.length ? (
                <div className="grid max-h-[42rem] gap-3 overflow-y-auto pr-1">
                  {completedCards.map((card) => (
                    <article
                      key={`${card.source}-${card.name}`}
                      className="rounded-2xl border border-white/10 bg-black/20 p-4"
                    >
                      <div className="mb-3 flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-stone-950 px-2.5 py-1 text-xs font-medium text-stone-50">
                          {card.quantity}x
                        </span>
                        <h3 className="text-base font-semibold text-stone-100">
                          {card.name}
                        </h3>
                        <span
                          className={cn(
                            "rounded-full px-2.5 py-1 text-xs font-medium",
                            card.source === "manual"
                              ? "bg-amber-100 text-amber-800"
                              : card.source === "fuzzy"
                                ? "bg-sky-100 text-sky-800"
                              : "bg-emerald-100 text-emerald-800"
                          )}
                        >
                          {card.source === "manual"
                            ? "Manual text"
                            : card.source === "fuzzy"
                              ? "Accepted fuzzy match"
                            : "Scryfall"}
                        </span>
                      </div>

                      <div className="space-y-2 text-sm leading-6 text-stone-300">
                        {card.manaCost ? (
                          <p>
                            <span className="font-medium text-stone-100">
                              Mana cost:
                            </span>{" "}
                            {card.manaCost}
                          </p>
                        ) : null}
                        {card.typeLine ? (
                          <p>
                            <span className="font-medium text-stone-100">
                              Type:
                            </span>{" "}
                            {card.typeLine}
                          </p>
                        ) : null}
                        <StatLine
                          power={card.power}
                          toughness={card.toughness}
                          loyalty={card.loyalty}
                        />
                        <p className="whitespace-pre-wrap">{card.oracleText}</p>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
                  Process a deck to preview the final gameplay text package.
                </div>
              )}
            </div>

            <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
              <div className="mb-5 space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">
                  Review fuzzy matches
                </h2>
                <p className="text-sm leading-6 text-stone-400">
                  Exact matches are included automatically. If Scryfall only
                  finds a fuzzy match, confirm it here before it gets used.
                </p>
              </div>

              {fuzzyMatches.length ? (
                <div className="grid gap-4">
                  {fuzzyMatches.map((match) => (
                    <article
                      key={match.name}
                      className="rounded-2xl border border-amber-400/25 bg-amber-400/8 p-4"
                    >
                      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                        <span className="rounded-full bg-amber-400/20 px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em] text-amber-100">
                          Review
                        </span>
                        <span className="font-semibold text-stone-100">
                          {match.quantity}x {match.name}
                        </span>
                        <span className="text-stone-400">suggested as</span>
                        <span className="font-semibold text-amber-100">
                          {match.suggestedCard.name}
                        </span>
                      </div>

                      <div className="space-y-2 text-sm leading-6 text-stone-300">
                        {toManaCost(match.suggestedCard) ? (
                          <p>
                            <span className="font-medium text-stone-100">
                              Mana cost:
                            </span>{" "}
                            {toManaCost(match.suggestedCard)}
                          </p>
                        ) : null}
                        {toTypeLine(match.suggestedCard) ? (
                          <p>
                            <span className="font-medium text-stone-100">
                              Type:
                            </span>{" "}
                            {toTypeLine(match.suggestedCard)}
                          </p>
                        ) : null}
                        <p className="whitespace-pre-wrap">
                          {toOracleText(match.suggestedCard)}
                        </p>
                      </div>

                      <div className="mt-4 flex flex-wrap gap-3">
                        <Button
                          type="button"
                          className="bg-emerald-600 text-white hover:bg-emerald-500"
                          onClick={() => acceptFuzzyMatch(match)}
                        >
                          Accept match
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="border-white/10 bg-black/20 text-stone-100 hover:bg-black/35"
                          onClick={() => rejectFuzzyMatch(match)}
                        >
                          Reject and enter manually
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
                  Any non-exact matches will show up here for review.
                </div>
              )}
            </div>

            <div className="rounded-[28px] border border-white/10 bg-white/5 p-5 shadow-lg shadow-black/30 backdrop-blur sm:p-6">
              <div className="mb-5 space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">
                  Missing cards
                </h2>
                <p className="text-sm leading-6 text-stone-400">
                  If Scryfall cannot find a card, you can paste its rules text
                  manually and it will be included above right away.
                </p>
              </div>

              {missingCards.length ? (
                <div className="grid gap-4">
                  {missingCards.map((card) => (
                    <label
                      key={card.name}
                      className="grid gap-2 rounded-2xl border border-amber-200 bg-amber-50/80 p-4"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm text-amber-900">
                        <span className="rounded-full bg-amber-200 px-2.5 py-1 text-xs font-medium uppercase tracking-[0.18em]">
                          Missing
                        </span>
                        <span className="font-semibold">
                          {card.quantity}x {card.name}
                        </span>
                      </div>
                      <textarea
                        value={card.manualText}
                        onChange={(event) =>
                          updateManualText(card.name, event.target.value)
                        }
                        placeholder="Paste oracle text, type line notes, or any gameplay-relevant reminder text here."
                        className="min-h-32 rounded-2xl border border-amber-400/30 bg-black/25 px-4 py-3 text-sm leading-6 text-stone-100 placeholder:text-stone-500 outline-none transition focus:border-amber-400 focus:ring-4 focus:ring-amber-400/20"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <div className="rounded-[24px] border border-dashed border-white/10 bg-black/20 px-5 py-10 text-center text-sm leading-6 text-stone-500">
                  Any cards Scryfall misses will show up here for manual entry.
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </main>
  )
}

export default App

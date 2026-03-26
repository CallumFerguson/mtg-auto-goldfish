export const DRAW_STARTING_HAND_PROMPT = `
You are goldfishing a Commander / EDH deck.

Your job in this step is ONLY to draw the starting hand, decide whether to mulligan, and decide what to bottom if needed.
Do not simulate any turns yet.

GENERAL ASSUMPTIONS
- Format: Commander / EDH.
- The commander starts in the command zone.

CARD KNOWLEDGE
- Use only the provided card reference and the visible opening hand information.
- Do not invent card text.
- If a card’s rules text is missing or unclear, make the safest conservative interpretation.

MANA COSTS AND MANA SYMBOLS
Interpret mana costs using normal MTG rules, because the provided card reference uses mana symbols in braces.

- A number in braces means generic mana.
  - Example: {1} = one mana of any type
  - Example: {2} = two mana of any type
- Colored symbols require that exact color.
  - {W} = one white mana
  - {U} = one blue mana
  - {B} = one black mana
  - {R} = one red mana
  - {G} = one green mana
- {C} means one colorless mana specifically.
- {X} means a variable generic amount chosen when the spell or ability is cast or activated.

Example conversions:
- {1}{G} = total cost 2 mana: 1 generic + 1 green
- {2}{R}{R} = total cost 4 mana: 2 generic + 2 red
- {3}{G}{W} = total cost 5 mana: 3 generic + 1 green + 1 white
- {X}{G} = X generic + 1 green, where X is chosen as the spell or ability is cast or activated

- Generic mana can be paid with colored or colorless mana.
- Colored requirements must still be satisfied exactly.
  - To cast a spell costing {1}{G}, you need at least one green mana plus one other mana of any type.
  - One green mana alone is NOT enough.
- When checking whether a card is realistically castable, consider both:
  1. total mana available
  2. whether the available colors satisfy the colored symbols
- Cost reduction changes the total cost, but cannot remove specific color requirements unless the rules explicitly allow that.
- Lands and mana sources only produce the mana their text allows.
- Do not confuse mana value with mana cost paid.
- Do not confuse a card’s color with the colors of mana required to cast it.

WHAT MATTERS IN THIS STEP
Evaluate whether the hand is functional for the first few turns and likely to develop well.

Prioritize:
- enough lands or fast mana to function
- access to the colors the hand needs
- the ability to make early land drops
- a plausible early or midgame plan
- good curve and sequencing
- reliable hands over greedy hands

Do not spend tokens on details that do not matter for the opening-hand decision, such as:
- combat patterns
- stack battles
- turn-by-turn tactical lines
- phases and steps
- attack decisions
- triggers that only matter once the game is being played

MULLIGAN RULES
Use Commander mulligan rules:
- Initial hand: draw 7.
- First mulligan: shuffle and draw a fresh 7. This first mulligan is free.
- After that, use London mulligan:
  - each additional mulligan draws 7 cards
  - once you keep, put a number of cards from your hand on the bottom of your library equal to the number of mulligans taken beyond the original hand

Examples:
- Keep opening 7: keep all 7
- Mulligan once, then keep: keep all 7
- Mulligan twice, then keep: draw 7, then bottom 1
- Mulligan three times, then keep: draw 7, then bottom 2

PRACTICAL MULLIGAN LIMITS FOR THIS SIMULATION
- Do NOT keep mulliganing indefinitely in search of a perfect hand.
- Use a hard cap of 4 total mulligans.
- Usually stop earlier if you find a hand that is functional, even if it is not ideal.
- After 2 total mulligans, become noticeably more willing to keep a mediocre but functional hand.
- After 3 total mulligans, strongly prefer keeping any hand that can reasonably play Magic and develop at all.
- Never exceed 4 total mulligans.
- If you reach the hard cap, you must keep the best available hand, even if it is weak.

KEEP / MULLIGAN HEURISTICS
Be disciplined but not greedy.
Usually keep the first decent, functional hand rather than chase a perfect one.

A hand is generally keepable if it has most of these:
- about 2-4 usable lands or equivalent fast mana
- access to at least the most important early colors
- something meaningful to do in the early turns, or a very reliable setup hand
- a reasonable path to casting ramp, card draw, setup pieces, or the commander

Hands are more likely to be mulligans if they are:
- mana-light
- mana-flooded
- missing critical colors
- too slow to function
- full of expensive spells with no early development
- dependent on drawing perfectly to do anything

Heuristic guidance:
- 3 lands is usually a strong baseline keep if colors are reasonable.
- 2 lands can be keepable if the hand has good colors, cheap plays, ramp, or draw.
- 1-land hands are usually mulligans unless the hand has unusually strong cheap fixing, draw, or ramp and a very clear path to function.
- 5+ land hands are usually mulligans unless the spell quality and curve make the hand clearly functional.

COMMANDER AWARENESS
Always consider the commander when judging the hand.
Ask:
- does this hand develop toward casting the commander on a reasonable timeline?
- if the deck heavily depends on the commander, does the hand support that plan?
- if the commander is expensive, does the hand still function before casting it?

BOTTOMING RULES AFTER A NON-FREE MULLIGAN
If you keep after taking extra mulligans and must bottom cards:
- keep the cards that best preserve lands, color access, and early function
- bottom the weakest, clunkiest, most redundant, or least castable cards
- prefer keeping a coherent hand over keeping individually powerful but awkward cards

DECISION STYLE
- Maximize consistency, not high-roll potential.
- Prefer stable, reliable hands.
- If two decisions are close, choose the simpler and safer keep.
- Do not chase an ideal hand past the point where the reduced hand size is likely to be worse than a merely mediocre keep.

OUTPUT
Return only:
1. the final starting hand
2. whether you kept or mulliganed
3. how many mulligans you took
4. if you mulliganed, a brief reason for each mulligan
5. if you bottomed cards, which cards you put on the bottom and why
6. a brief explanation of why the final hand was kept
7. if you hit the hard cap, explicitly say that you kept because the mulligan limit was reached
`;

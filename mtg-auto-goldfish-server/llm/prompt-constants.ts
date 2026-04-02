export const DRAW_STARTING_HAND_PROMPT = `
You are goldfishing a Commander / EDH deck.

In this step, your job is ONLY to:
- draw the starting hand
- decide whether to mulligan
- decide what to bottom if needed

Do not simulate any turns yet.

GENERAL ASSUMPTIONS
- Format: Commander / EDH.
- The commander starts in the command zone.
- The commander is listed separately and should usually not appear in the decklist or opening hand. Do not treat that as a problem.

CORE DECISION RULE
Before every tool call after seeing a hand, first decide:
- KEEP or MULLIGAN
- why

Tool calls cannot be undone.

FINALITY RULE
- Every hand-resolution run has exactly one final decision.
- That final decision is represented by exactly one keep_hand call.
- Once you call keep_hand, the step is over.
- A keep decision is irreversible.
- Never reconsider, revise, or undo a keep.
- Never mulligan after deciding to keep.
- Never call mulligan after keep_hand.
- Never call return_cards_to_library after keep_hand.
- Never call keep_hand more than once.
- Never continue hand analysis after keep_hand except for the required final short summary.
- Treat keep_hand as the lock-in point for the entire step.

COMPLETION AND OUTPUT LOCK
- A completed run for this step must end with exactly one keep_hand call.
- Never finish this step without calling keep_hand.
- keep_hand must be the final game-tool call of the entire step.
- Do not call keep_hand until the final kept hand is completely finalized.
- If any cards must be put on the bottom after mulligans, that bottoming must happen first.
- Once keep_hand is called, the decision is locked.
- After keep_hand, do not reevaluate the hand, do not change your mind, and do not call any more game tools.
- After keep_hand, return exactly one final summary message and nothing else.

RESPONSE TIMING
- Do not produce any user-facing output until all thinking, decisions, and tool calls for this step are complete.
- Do not stream partial conclusions, partial summaries, or incremental narration while still evaluating or calling tools.
- First finish the full hand-resolution process for this step: evaluate hands, make mulligan decisions, perform any needed bottoming, and finalize the kept hand.
- Only after the entire process is complete and keep_hand is called should you return the final short summary.
- The only visible output for this step should be the final completed summary after all tool usage is finished.

TOOL USAGE RULES
- Call draw_starting_hand exactly once to get the very first opening hand.
- Do not call draw_starting_hand again after that.
- If you decide a hand is not keepable, and only then, call mulligan.
- Do not mulligan just because mulligan is available as a tool.
- mulligan already shuffles and draws the new seven-card hand for you.
- After any mulligan call, stop and evaluate only the newly returned hand before deciding anything else.
- Once a new hand is returned from mulligan, the previous hand is no longer relevant except as history for the final summary.
- Every mulligan tool call must include a short reason argument explaining why the current hand is not keepable.
- If a hand is keepable, keep it and do not call mulligan.
- If you keep after a non-free mulligan and must put cards on the bottom, first decide the full set of cards you will bottom, then call return_cards_to_library once with that full set.
- return_cards_to_library must happen before keep_hand whenever bottoming is required.
- Do not call keep_hand until all required bottoming is already finished.
- keep_hand must always be the last game-tool call.
- Once your final kept hand is fully determined, call keep_hand exactly once with the exact list of cards you are keeping.
- Never call draw_starting_hand after mulligan, because that would incorrectly draw an extra hand.
- Never call keep_hand before required bottoming is finished.
- Never call keep_hand, then continue reasoning and call more tools.
- Never output a draft verdict before the final keep_hand call.

CARD KNOWLEDGE RULES
- Use only the provided card reference and the visible opening hand information.
- Do not invent card text.
- Follow the exact wording of the provided card text, especially for lands and mana.
- Do not blur together different conditions such as reveal from hand, control on the battlefield, enters tapped unless, or choose a color.
- For lands, read the actual condition carefully before judging whether the land enters tapped or what colors it can produce.
- Do not say a spell is castable on a given turn unless the exact mana and colors are actually available on that turn.
- If a card's rules text is missing or unclear, make the safest conservative interpretation.
- Trust the tool output for the current hand. Do not waste time recounting cards unless the tool output is actually malformed.

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
- Do not confuse a card's color with the colors of mana required to cast it.
- When using mana cost as part of your reasoning, do one quick arithmetic check before finalizing the judgment:
  - total cost = generic symbols + all required colored/colorless symbols
  - colored requirements must still be met separately

WHAT MATTERS IN THIS STEP
Use a deliberately simple mulligan heuristic, but do NOT treat lands and nonland acceleration as interchangeable.

The PRIMARY keep / mulligan decision should be based on:
1. land count
2. early acceleration count
3. mulligan phase

LANDS are the main baseline.
EARLY ACCELERATION is support for the land count, not a direct replacement for lands.

Count separately:
- Lands
- Early acceleration

CASTABILITY RULE FOR ACCELERATION
Only count a nonland card as EARLY ACCELERATION if it is realistically usable in this hand and actually helps your mana development.
To count, it must satisfy all of the following:
- it is realistically castable or usable with the current hand's mana and colors
- it improves mana development by turn 4
- it provides lasting development rather than a one-shot burst

This can include:
- cheap mana rocks
- mana dorks
- land-ramp spells
- slower but still relevant ramp costing up to 4 mana, if it is realistically castable in this hand and meaningfully improves mana development

Do NOT count:
- ramp that is not realistically castable with the current lands and colors
- one-shot rituals that do not provide lasting development
- generic setup cards that do not actually ramp mana
- cards that technically make mana later but are not realistic early development for this hand
- slow cards that only matter much later and do not help stabilize the opening keep

IMPORTANT INTERPRETATION
- Do NOT treat 1 land and 1 mana rock as the same as 2 lands.
- Do NOT treat 4 lands + 1 ramp piece as the same as 5 lands with no acceleration.
- Lands are the primary measure of stability.
- Early acceleration can upgrade a borderline land count.
- Early acceleration usually does NOT rescue 0- or 1-land hands.
- Early acceleration can make 2-land hands keepable.
- Early acceleration can make 5-land hands less bad.
- Even with acceleration, 6- or 7-land hands are usually too flooded early.
- Ramp that costs 3 or 4 mana can count, but it is weaker support than 1- or 2-mana acceleration in close calls.
- Do not count a ramp card just because it is a ramp card in general; count it only if this hand can realistically use it.

Do NOT override the heuristic at this stage just because:
- the spells look strong
- the spells look weak
- the hand has synergy
- the hand lacks synergy
- the commander is powerful
- the commander is awkward
- the curve looks pretty
- the curve looks clunky

Use land count first and early acceleration second.

Only use card-specific detail for:
- confirming whether something really counts as early acceleration
- checking whether a land actually enters untapped or produces the needed color
- checking whether a ramp card is actually castable in this hand
- deciding what to bottom after a keep on a non-free mulligan
- breaking very close ties, especially after several mulligans

HAND EVALUATION PROCEDURE
For every hand:
1. Count lands in hand.
2. Count early acceleration in hand.
3. Identify the current mulligan phase:
   - opening 7
   - after 1 mulligan
   - after 2 mulligans
   - after 3 mulligans
   - after 4 total mulligans
4. Use the phase-specific guidance below as your default framework.
5. Decide KEEP or MULLIGAN before making any tool call.
6. Give a short reason tied to lands, early acceleration, castability if relevant, and phase.
7. If the verdict is MULLIGAN, use that short reason as the reason argument in the mulligan tool call.
8. If the verdict is KEEP and bottoming is required, decide the full bottoming plan before any finalizing tool call.
9. Only after the hand is fully finalized should you call keep_hand.

PHASE-SPECIFIC KEEP / MULLIGAN GUIDELINES
Use these as strong defaults, not as absolute rules. Prefer following them in most cases, but treat them as guidance rather than a rigid script. Once you have mulliganed a few times, become more willing to keep a merely acceptable hand instead of chasing a perfect one.

1. Opening 7
Usually KEEP if:
- lands = 3 or 4
- lands = 2 and early acceleration >= 1

Usually MULLIGAN if:
- lands = 0 or 1
- lands = 2 and early acceleration = 0
- lands = 5 and early acceleration = 0
- lands = 6 or 7

Borderline guidance:
- lands = 5 and early acceleration >= 1 is usually still a mulligan, but can be treated as a close call rather than an automatic ship
- lands = 2 with only slower 4-mana acceleration is weaker than lands = 2 with cheap acceleration; use castability and color stability to break the tie

2. After 1 mulligan
Usually KEEP if:
- lands = 3, 4, or 5
- lands = 2 and early acceleration >= 1

Usually MULLIGAN if:
- lands = 0 or 1
- lands = 2 and early acceleration = 0
- lands = 6 or 7

Borderline guidance:
- lands = 5 and early acceleration = 0 is acceptable more often here than on the opening 7
- when in doubt after one mulligan, lean a bit more toward keeping than you would on the opener
- lands = 2 with only slower 4-mana acceleration is acceptable more often here than on the opener if the mana works

3. After 2 mulligans
Usually KEEP if:
- lands = 2, 3, 4, or 5
- lands = 6 and early acceleration >= 1

Usually MULLIGAN if:
- lands = 0
- lands = 1 and early acceleration <= 1
- lands = 7

Borderline guidance:
- lands = 1 and early acceleration >= 2 can be considered a keep if the acceleration is realistic and the mana works
- lands = 6 and early acceleration = 0 is clunky, but often acceptable this deep
- at this point, favor a functional hand over continuing to search for an ideal one

4. After 3 mulligans
Strongly prefer KEEP if:
- lands = 2, 3, 4, 5, or 6
- lands = 1 and early acceleration >= 2

Only seriously consider another MULLIGAN if:
- lands = 0
- lands = 1 and early acceleration <= 1 and the hand is still clearly nonfunctional

Guidance:
- by this stage, a mediocre but playable hand is usually better than going even lower
- do not chase small upgrades

5. After 4 total mulligans
- Treat this as the practical hard cap for this simulation
- KEEP the hand you have
- If the hand is reasonable, keep it confidently
- If the hand is weak, keep it anyway because going deeper is no longer worth it here

PRACTICAL INTERPRETATION
- 0 to 1 lands: usually a mulligan until the hand is deep enough that you should stop chasing improvement
- 2 lands: risky by itself, but often acceptable with early acceleration
- 3 to 4 lands: ideal default range
- 5 lands: often clunky, but increasingly acceptable after mulligans
- 6 lands: usually too flooded on the first hand, but more keepable once you are deep
- 7 lands: almost always a mulligan unless the practical cap forces a keep
- Do not chase a perfect hand
- Do not assume the next hand will be better
- Once the guidance points toward keeping, especially after the opener, strongly prefer keeping

MULLIGAN RULES
Use Commander mulligan rules:
- Initial hand: draw 7.
- First mulligan: shuffle and draw a fresh 7. This first mulligan is free.
- After that, use London mulligan:
  - each additional mulligan draws 7 cards
  - once you keep, put a number of cards from your hand on the bottom of your library equal to the number of mulligans taken beyond the free mulligan

Examples:
- Keep opening 7: keep all 7
- Mulligan once, then keep: keep all 7
- Mulligan twice, then keep: draw 7, then bottom 1
- Mulligan three times, then keep: draw 7, then bottom 2

PRACTICAL MULLIGAN LIMITS FOR THIS SIMULATION
- Do NOT keep mulliganing indefinitely in search of a perfect hand.
- Treat 4 total mulligans as the practical cap for this simulation.
- Usually stop earlier if the phase-based guidance says the hand is good enough to keep.
- Treat mulligan as the fallback for bad hands, not the default action after seeing a merely imperfect hand.
- Never exceed 4 total mulligans.
- If you reach the cap, keep the best available hand, even if it is weak.

DECISION FLOW
- Start by calling draw_starting_hand once to see the opening hand.
- After seeing a hand, decide whether it is a keep or a mulligan before using any further tool.
- If the hand is not keepable and you are below the mulligan cap, call mulligan with a short reason.
- After a mulligan returns a new hand, stop and evaluate that hand on its own merits.
- If the hand is keepable and no cards must be bottomed, call keep_hand with the full kept hand.
- If the hand is keepable and cards must be bottomed, first decide the full set of cards to bottom, then call return_cards_to_library once with all of them, then call keep_hand with the final kept hand.
- Do not treat the hand as finalized until any required return_cards_to_library call has already happened.
- keep_hand is the final action of the hand-resolution process.
- If you reach the practical cap, keep the hand rather than mulliganing again.

COMMANDER AWARENESS
You may briefly identify what kind of deck this appears to be from the commander and decklist, but do not let that override the simple land-plus-acceleration heuristic.
Commander and deck context matter more for later gameplay than for this step.

BOTTOMING RULES AFTER A NON-FREE MULLIGAN
If you keep after taking extra mulligans and must bottom cards:
- Bottoming is part of finalizing the kept hand, so it must be completed before keep_hand is called.
- decide whether you are keeping before you call return_cards_to_library
- decide the entire set of cards to bottom before making the tool call
- use one return_cards_to_library call with all cards you are bottoming unless order would meaningfully matter
- do not call keep_hand until the bottoming decision is fully complete
- keep enough lands first
- keep early acceleration next
- then keep the cheapest and easiest-to-cast functional spells
- bottom the weakest, clunkiest, most redundant, or least castable cards
- prefer keeping a coherent mana base over keeping individually powerful but awkward cards
- if choosing between similar nonland cards, keep the cheaper and easier-to-cast ones first

DECISION STYLE
- Maximize consistency, not high-roll potential.
- Prefer stable, reliable hands.
- Follow the phase-specific land-plus-acceleration guidance rather than chasing ideal card quality.
- If two decisions are close, choose the safer keep once you are past the opening hand.
- Evaluate the hand in front of you, not an imagined better hand.
- Be concise and decisive. Do not narrate long speculative lines.
- Once you have decided to keep, stop looking for reasons to mulligan.
- Once you have decided to mulligan, do not keep that same hand.

OUTPUT
Return only one short final summary after all thinking and tool usage is complete:
1. whether you kept or mulliganed at each decision point and why
2. how many mulligans you took
3. if you bottomed cards, which cards you put on the bottom and why
4. why the final hand was kept
5. if you hit the practical cap, explicitly say that you kept because the mulligan limit was reached

Do not restate the full final hand in the final answer, because that information is provided through the keep_hand tool call.
Do not output multiple summaries.
Do not output a summary before the final keep_hand call.

While reasoning about each hand before the final answer, keep your internal checklist compact:
- Lands:
- Early acceleration:
- Phase:
- Verdict:
- Short reason:

Before the final keep_hand call, do one last silent procedural check:
- Did I already decide KEEP?
- If yes, have I finished all required bottoming first?
- Am I calling keep_hand exactly once?
- Will keep_hand be the last game-tool call?
- After this, will I stop and give only the final short summary?
`;

export const SIMULATE_TURN_PROMPT = `
Play exactly one full turn of a Commander / EDH goldfish game from the provided game state, then return the updated game state.

Your visible response must contain ONLY the updated game state contents.

CORE OBJECTIVE
- Make the strongest legal play available.
- Play tightly, conservatively, and correctly.
- Do not cheat.
- Do not use hidden information unless it has been legally revealed.
- Do not invent unknown library order.
- Preserve exact zone and board-state accuracy.

THIS STEP ONLY
- This prompt is only for playing one turn.
- Do NOT do opening-hand procedure here.
- Do NOT do mulligans here.
- Do NOT bottom cards for London mulligan here.
- Do NOT use any opening-hand or mulligan tools in this step.
- Use the provided game state as the current real state of the game.

GENERAL ASSUMPTIONS
- Format is Commander / EDH.
- This is a goldfish simulation: no opponents take actions, no opponent interaction happens, and no unknown opposing permanents or cards exist unless explicitly shown in the game state.
- If life total is omitted, assume 40 life.
- The commander starts in the command zone unless the game state says otherwise.
- Ignore politics and bluffing.
- If a spell or ability requires a legal target and none exists, you cannot cast or activate it unless the rules allow it without a target.
- If information about opponents would matter for a card or permanent, use only what the game state actually provides. Do not invent opponent lands, colors, permanents, cards, or choices.

DRAW STEP RULE
- Follow normal Commander turn structure.
- Take the normal draw step each turn, including turn 1, unless an effect says otherwise.
- Never add a card to hand unless the rules and current turn state actually require it.

LIBRARY / MCP TOOL RULES
- The library is external state managed by MCP tools.
- MCP tools are mechanical only. They do NOT enforce legality, timing, visibility, targeting, sequencing, or MTG rules.
- You are responsible for all legality and state correctness.
- Whenever an effect interacts with an unknown part of the library, you MUST use the MCP tools rather than inventing a result.
- This includes, when applicable:
  - drawing
  - looking at the top card
  - scry
  - surveil that touches the library
  - mill
  - reveal-from-top effects
  - cascade / discover style effects
  - searching the library
  - taking a specific named card from the library for tutor or search effects
  - shuffling / randomizing
  - putting cards on top or bottom
  - any effect that depends on unknown library order
- Use take_cards_from_library when an effect searches for a specific card by name. It may return no card if nothing if the card cannot be found.
- Resolve multi-card library effects one card at a time in the correct order unless the effect clearly moves a known set together.
- If a card becomes known and that knowledge still matters, track it in comments.
- If that knowledge stops being valid because of a shuffle, draw, or other change, update or remove the stale comment.
- Do not start writing the visible response until all reasoning and all required tool calls are finished.

TOOL BOUNDARY
- Use tools only for library interactions.
- Do not use tools for actions like:
  - playing a land
  - tapping permanents
  - casting a visible spell
  - attacking
  - moving a visible card between visible zones when no hidden library information is involved
- Handle those by reasoning from the game state and then updating the game state directly.

HIDDEN INFORMATION RULES
Use only:
1. the provided game state,
2. the known rules text of visible cards,
3. information legally revealed through tool use.
- Never guess unknown cards.
- Never assume the top of the library.
- Never assume a shuffle outcome.
- Never pretend to know the order of cards that should be unknown.

RULES DISCIPLINE
Follow normal MTG rules as closely as possible, including:
- phases and steps
- timing restrictions
- summoning sickness
- mana costs and color requirements
- lands being played, not cast
- one land play per turn unless an effect allows more
- activated abilities and tap requirements
- commander casting from the command zone
- commander tax
- ETB, upkeep, draw-step, attack, end-step, and death triggers
- optional vs mandatory triggers
- replacement effects
- state-based actions
- the legend rule
- until-end-of-turn effects ending during cleanup

MANA DISCIPLINE
Interpret mana costs exactly.
- {1}, {2}, etc. are generic mana, not colored mana.
- {W}{U}{B}{R}{G} require those exact colors.
- {C} is colorless specifically.
- Generic mana may be paid with colored or colorless mana unless a rule says otherwise.
- Colored requirements must be satisfied exactly.
- Total available mana and color access must both be checked before casting.
- Do not confuse mana value with what can actually be paid now.
- Do not assume a land or permanent can produce mana it does not currently have access to produce.
- If a mana source depends on opponents or game objects not present in the game state, it produces only what is actually supported by the shown state.

COMMANDER RULES
- Always consider the commander as an available option if it is in the command zone and can legally be cast.
- Do not overlook the commander during planning.
- The commander’s current cost is its mana cost plus commander tax.
- Commander tax is {2} for each previous time that commander was cast from the command zone this game.
- Track commander cast count if relevant to future turns.
- Respect any once-per-turn text on the commander exactly.

DECISION PRIORITIES
Choose the best legal line for long-term game strength.
Usually prefer:
- making a land drop
- good color development
- efficient ramp
- card advantage
- strong sequencing
- setting up future turns
- deploying the commander when that is one of the best legal lines
Avoid:
- flashy but weaker lines
- unnecessary risk
- wasting mana or cards for no gain
- casting spells with poor targets or no meaningful payoff
If several lines are close, choose the simpler and more reliable one.

TURN PROCEDURE
Play exactly one full turn using this structure:
1. Untap
2. Upkeep
3. Draw
4. Precombat main
5. Combat
6. Postcombat main
7. End step
8. Cleanup

During that turn:
- Resolve all mandatory triggers.
- For optional choices, choose the strongest legal option.
- Attack only if legal and beneficial.
- Under goldfish assumptions, attacks are unblocked unless the game state says otherwise.
- Respect summoning sickness and haste.
- Remove damage and until-end-of-turn effects during cleanup.

ZONE ACCOUNTING
Visible zones must always be correct:
- hand
- battlefield
- graveyard
- exile
- command zone

Non-negotiable zone rules:
- A card can exist in exactly one visible zone at a time.
- Whenever a card changes zones, remove it from the old zone and add it to the new one.
- Do not leave a played land in hand.
- Do not leave a cast spell in hand.
- Do not duplicate cards across zones.
- If a visible card goes back into the library, remove it from the visible zone and note any still-relevant knowledge in comments if appropriate.
- After any library interaction, update the visible zones to reflect what actually became visible.

STATE TRACKING
Use comments aggressively to keep the state accurate and future-proof.

Track on permanents as needed:
- tapped / untapped
- summoning sickness if relevant
- counters
- Auras / Equipment / other attachments
- chosen colors, creature types, or modes
- copied status
- linked or exiled cards
- whether something entered this turn if that matters

Track at player / game level as needed:
- life total
- commander cast count
- floating mana during a sequence if it matters
- known top or bottom cards of the library
- library size if the state is tracking it
- once-per-turn abilities already used this turn
- persistent notes from prior turns

COMMENT HYGIENE
- Keep comments accurate.
- Update stale comments when the state changes.
- Remove comments that are no longer true.
Examples:
- If a permanent untaps, remove “tapped.”
- If a known top card is drawn or shuffled away, remove or update that note.
- If damage wears off in cleanup, do not leave it marked.
- If a temporary effect ends, do not leave it in the state.

TURN COMMENTS
- End-of-turn comments are part of the game state.
- Preserve prior end-of-turn comments unless the input explicitly says otherwise.
- Append this turn’s end-of-turn note at the bottom of the game state.
- Keep all comments inside the game state, not outside it.

CARD TEXT UNCERTAINTY
- Do not invent rules text.
- If a card’s exact text is unknown or ambiguous, use the safest conservative interpretation and note that briefly in a comment.

OUTPUT FORMAT
- Output ONLY the updated game state contents.
- No explanation outside the game state.
- No preface.
- No conclusion.
- No markdown fences.
- Do not print markers like “start game state” or “end game state.”
- Keep the same general structure and headings as the input game state.
- Update only what changed.
- Comments using // are encouraged.
- The short end-of-turn note must be inside the game state at the bottom.

FINAL SELF-CHECK BEFORE RESPONDING
Verify all of the following before producing the visible response:
- I played exactly one turn.
- I followed the correct turn structure.
- I took the normal Commander draw step unless an effect changed it.
- I did not add any card to hand unless a real draw / reveal / move required it.
- I used tools only when hidden library information was involved.
- I made only legal plays.
- I counted mana correctly, including colors and generic costs.
- I considered the commander if it was legally castable.
- I updated every visible zone correctly.
- No card exists in two visible zones at once.
- No played land remains in hand.
- No cast spell remains in hand.
- Tapped / untapped status is consistent everywhere.
- I preserved or updated relevant comments correctly.
- I removed stale comments that stopped being true.
- I did not use hidden information I should not know.
- My response contains only the updated game state contents.

Return only the updated game state contents.
`;

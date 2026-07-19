# Testing Contract

The game (`index.html`) MUST implement the hooks below so automated Playwright tests can drive and inspect it. These hooks are tiny, have no gameplay effect, and ship in production (they are harmless).

> **v2:** the contract is extended for the 4-fighter roster, stages, and character select. All extensions are **backward compatible** — every v1 field keeps its exact name, type, and semantics; `__SF.start('medium')` with no second argument still works and produces the default matchup (KAZAN vs VOLT on HARBOR). v2 additions are marked **(v2)** below.

## 1. Global test API: `window.__SF`

Available as soon as the page has loaded (title screen visible).

```js
window.__SF = {
  // Read-only JSON-serializable snapshot of the whole game state.
  state(): {
    scene: 'title' | 'select' | 'fight' | 'roundEnd' | 'matchEnd',
    paused: boolean,
    muted: boolean,
    difficulty: 'easy' | 'medium' | 'hard' | null,
    round: number,            // 1-based, only meaningful during/after a fight
    timer: number,            // seconds remaining in round
    roundWins: [number, number],
    p1: { hp: number, maxHp: number, x: number, y: number, facing: 1|-1, action: string,
          char: string },                       // (v2) 'kazan'|'volt'|'tetsu'|'sable'
    p2: { hp: number, maxHp: number, x: number, y: number, facing: 1|-1, action: string,
          char: string },                       // (v2)
    touchControlsVisible: boolean,
    stage: 'harbor'|'market'|'temple'|null,     // (v2) null outside a fight
    roster: string[],                           // (v2) ['kazan','volt','tetsu','sable'] — static
    stages: string[],                           // (v2) ['harbor','market','temple'] — static
    select: null | {                            // (v2) non-null only while scene === 'select'
      phase: 0|1|2,          // 0 = pick fighter, 1 = pick rival, 2 = stage/difficulty/FIGHT
      cursor: number,        // index of the highlighted card / menu row
      p1: string,            // current P1 pick
      p2: string,            // current rival pick, or 'random'
      stage: string,         // current stage pick, or 'random'
    },
  },

  // Jump straight into round 1 of a fight, skipping title/select.
  // (v2) opts is optional: { p1?: string, p2?: string, stage?: string }.
  // Missing or unrecognized values silently fall back to defaults:
  // p1 'kazan', p2 'volt', stage 'harbor'. No console output on fallback.
  start(difficulty: 'easy'|'medium'|'hard', opts?: {p1?, p2?, stage?}): void,

  setAI(enabled: boolean): void,   // freeze/unfreeze CPU decision-making (fighter still obeys physics)
  setHP(player: 1|2, hp: number): void,   // clamp applied; triggers KO flow naturally if <= 0 after next hit resolution or immediately
  setTimer(seconds: number): void, // set round timer
  version: string,                 // (v2) '2.x'
}
```

`state()` must never throw, in any scene.

**Per-character max HP (harness reference table, v2):** kazan 1000, volt 920, tetsu 1150, sable 950. The default `__SF.start('medium')` fight therefore reports `p1.maxHp === 1000` and `p2.maxHp === 920`, both starting at full (`hp === maxHp`). Harnesses must assert `hp === maxHp` per fighter, not a hardcoded 1000 for both.

## 2. Input

- **Keyboard**: listen for `keydown`/`keyup` on `window` using `e.code` (e.g. `ArrowLeft`, `KeyJ`). Synthetic `KeyboardEvent`s dispatched by tests must work (do not require `isTrusted`).
- **Touch controls**: DOM elements (not canvas-drawn) with these stable ids, present in the DOM always but only *visible* on touch devices:
  - `#touch-controls` — container
  - `#dpad` — movement pad (its sub-zones may be internal)
  - `#btn-lp`, `#btn-hp`, `#btn-lk`, `#btn-hk` — attack buttons
  - `#btn-sp1`, `#btn-sp2` — special-move buttons (if the design uses dedicated special buttons)
  - `#btn-pause` — pause
  - Buttons must respond to Pointer Events or Touch Events (WebKit `hasTouch` emulation sends touch events).
- Touch-device detection must be capability-based (`'ontouchstart' in window || navigator.maxTouchPoints > 0`) so Playwright contexts created with `hasTouch: true` show the touch controls.
- **(v2)** No new DOM ids. The character-select screen is canvas-drawn and driven by keyboard AND canvas taps (existing `menuTap` path). Touch-button restyling must not change ids, geometry, hit areas, or visibility rules.

## 3. Menus must be drivable

Title screen and the select flow (all three v2 phases: fighter → rival → stage/difficulty) must be operable by BOTH keyboard (arrows + Enter, Esc = back) and tap/click on the canvas. `__SF.start(difficulty, opts?)` exists as the deterministic shortcut for tests. The victory screen's first menu item must remain REMATCH → immediately into a new fight with the same characters/stage on a single Enter press.

## 4. No console errors

Zero uncaught exceptions and zero `console.error` calls during: load, menu navigation (including the full select flow), a full fight on each difficulty, each character matchup, each stage, pause/resume, resize, and repeated rematches. Tests fail on any.

## 5. Running the tests

Test harness lives in `test/run-tests.mjs` (Node + Playwright, no test framework needed):

```bash
node test/smoke.mjs              # quick load check
node test/run-tests.mjs          # full suite, Chromium + WebKit, screenshots to test/screenshots/
node test/probe-ai.mjs           # AI difficulty-ladder + turtle-lock probe (protects DESIGN.md §11.8)
node test/repro-jumpattack.mjs   # air-hit float regression (exit 0 = bug absent)
```

`node test/probe-ai.mjs` (default, all three blocks) takes ~10–15 min wall-clock — the per-character block dominates that cost. Pass `turtle`, `ladder`, or `chars` as an argument (e.g. `node test/probe-ai.mjs chars`) to run just one block for faster iteration.

The harness must exercise, in BOTH engines (WebKit ≈ iOS Safari):

1. Load `index.html` via `file://` — no console/page errors, title scene reached.
2. `__SF.start('medium')` — scene becomes `fight`, both fighters at full HP (`hp === maxHp` each; p1 1000/kazan, p2 920/volt), stage `harbor`.
3. With AI frozen (`setAI(false)`): dispatch attack keys next to the opponent — p2 HP decreases; combo of movement keys moves p1.
4. With AI on (`setAI(true)`), Hard: within 10 s the CPU moves and attacks (p2 x changes; p1 takes damage or blocks).
5. `setHP(2, 1)` + one player attack → KO → `roundEnd` → eventually next round or `matchEnd`; win a match, `matchEnd` reached, rematch works (one Enter → fresh fight, same matchup).
6. `setTimer(1)` → time-over resolution works (higher-HP fighter wins round).
7. Pause/resume via keyboard and `#btn-pause`.
8. Touch context (`hasTouch: true`, iPad viewport 1024×768 and 820×1180): touch controls visible, tapping `#btn-lp` attacks, holding dpad zones moves the fighter, multi-touch (move + attack simultaneously) works via two concurrent touch points.
9. Resize window mid-fight — canvas rescales, no errors, aspect preserved (letterboxing, sampled letterbox pixel stays dark).
10. **(v2) Select flow:** from title, keyboard-drive the full select flow (Enter → select; arrows + Enter through phase 0 pick `tetsu`, phase 1 pick `sable`, phase 2 set stage `market` + difficulty + FIGHT!) — `state().select` reflects each phase; the resulting fight reports `p1.char === 'tetsu'`, `p2.char === 'sable'`, `stage === 'market'`. Also verify Esc steps back a phase and a canvas-tap path can confirm a card in a touch context.
11. **(v2) Per-character differences:** for each roster character c: `__SF.start('medium', {p1: c, p2: 'kazan'})` → `p1.char === c`, `p1.maxHp` matches the §1 table; with AI frozen, 600 ms of held forward-walk moves each character a distance consistent with its walk speed (volt > kazan > tetsu, ±20% tolerance); pressing Down+SP produces that character's unique down-slot special (distinct `action`/observable effect per character — e.g. volt leaves the ground, tetsu spawns a ground projectile, sable spawns a rising projectile).
12. **(v2) Stage variety:** `__SF.start('medium', {stage: s})` for each of the three stages — `state().stage === s`, zero console errors, a sampled in-world pixel differs across the three stages, resize mid-fight rebakes cleanly on each.
13. **(v2) Air-reset regression** (adapted from `test/repro-jumpattack.mjs`): scripted jump-in attacks against the Hard CPU for ≥ 15 s, topping up HP/timer via `setHP`/`setTimer` so no round ends; at no point may EITHER fighter report a grounded-state `action` (idle/walk/attack/block) while `y < 615` for more than 30 consecutive frames; after any mid-air hit, the struck fighter must return to `y ≥ 615` within 2 s.
14. Screenshots: title, select (each phase), fight on each stage, at least one non-default character matchup, touch-controls view — saved to `test/screenshots/`.

Exit code 0 with `ALL TESTS PASSED` plus a per-test PASS/FAIL summary; non-zero otherwise.

## 6. AI calibration guard (unchanged, frozen)

`test/probe-ai.mjs` pins DESIGN.md §11.8 on the **default matchup**: a jab-mash bot must beat Easy and lose to Medium and Hard, and whiff-poking must not turtle-lock the CPU. Medium going ~50/50 vs a masher is BY DESIGN — never "fixed". This default-matchup bot never blocks (zero-defense dummy) and is frozen byte-for-byte; because it can't guard at all, Medium is expected to dominate it outright, so the ladder guard only asserts the CPU takes ≥ 1 round rather than a literal 50/50 split. Easy is sampled best-of-3 matches (majority) rather than a single match, since it sits close to its own pass/fail boundary by design and a lone sample can flip on harness timing noise — no in-game value changes with this sampling.

**(v2)** the probe additionally checks each roster character as the Medium CPU vs the mash bot and requires the bot to win at least 2 and at most 10 of 12 sampled rounds ("roughly comparable", ~17–83%); tuning to stay in band happens in per-character role maps / special frame data only, never in the §11.6 `AI_TUNE` table. This is a wide anti-domination *smoke band*, not a precision calibration gate: at n=12, a character in the tuned 30–50% true-winrate family passes with >99% probability, while a genuinely dominated matchup (true rate ≤5% — the original defect, 0% across the whole roster) fails with >95% probability; precision steering within a character's tuned family is DESIGN.md §15.4 role-map methodology, not this check's job. This check runs a *separate* masher instance from the frozen default-matchup bot above: it adds one minimal, probabilistic block reaction (guard briefly when the CPU visibly swings) so it approximates the "few-hours player" DESIGN.md §11.8 actually describes, closely enough that the band is reachable by a well-tuned Medium rather than measured against a bot that can never win a round. Each sampled round is capped via `__SF.setTimer(25)` right after it's confirmed started, so a round costs ~25–30s wall-clock instead of ~100s (time-over still decides by HP lead — already game behavior); a round whose `roundWins` sum is still 0 after its own 60s wait-loop budget is discarded as a timeout, and if timeouts drop the sampled total below 12 the win thresholds scale proportionally (at least 8 non-discarded samples required). The four characters are sampled concurrently, one Playwright page per character in the same browser instance, bringing this block to ~6–8 min wall-clock.

# Testing Contract

The game (`index.html`) MUST implement the hooks below so automated Playwright tests can drive and inspect it. These hooks are tiny, have no gameplay effect, and ship in production (they are harmless).

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
    p1: { hp: number, maxHp: number, x: number, y: number, facing: 1|-1, action: string },
    p2: { hp: number, maxHp: number, x: number, y: number, facing: 1|-1, action: string },
    touchControlsVisible: boolean,
  },

  start(difficulty: 'easy'|'medium'|'hard'): void,  // jump straight into round 1 of a fight
  setAI(enabled: boolean): void,                     // freeze/unfreeze CPU decision-making (fighter still obeys physics)
  setHP(player: 1|2, hp: number): void,              // clamp applied; triggers KO flow naturally if <= 0 after next hit resolution or immediately
  setTimer(seconds: number): void,                   // set round timer
  version: string,
}
```

`state()` must never throw, in any scene.

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

## 3. Menus must be drivable

Title screen and difficulty select must be operable by BOTH keyboard (arrows + Enter) and tap/click on DOM elements or the canvas. `__SF.start(difficulty)` exists as the deterministic shortcut for tests.

## 4. No console errors

Zero uncaught exceptions and zero `console.error` calls during: load, menu navigation, a full fight on each difficulty, pause/resume, resize, and repeated rematches. Tests fail on any.

## 5. Running the tests

Test harness lives in `test/run-tests.mjs` (Node + Playwright, no test framework needed):

```bash
node test/run-tests.mjs            # runs in Chromium + WebKit, writes screenshots to test/screenshots/
```

The harness must exercise, in BOTH engines (WebKit ≈ iOS Safari):

1. Load `index.html` via `file://` — no console/page errors, title scene reached.
2. `__SF.start('medium')` — scene becomes `fight`, both fighters at full HP.
3. With AI frozen (`setAI(false)`): dispatch attack keys next to the opponent — p2 HP decreases; combo of movement keys moves p1.
4. With AI on (`setAI(true)`), Hard: within 10 s the CPU moves and attacks (p2 x changes; p1 takes damage or blocks).
5. `setHP(2, 1)` + one player attack → KO → `roundEnd` → eventually next round or `matchEnd`; win a match, `matchEnd` reached, rematch works.
6. `setTimer(1)` → time-over resolution works (higher-HP fighter wins round).
7. Pause/resume via keyboard and `#btn-pause`.
8. Touch context (`hasTouch: true`, iPad viewport 1024×768 and 820×1180): touch controls visible, tapping `#btn-lp` attacks, holding dpad zones moves the fighter, multi-touch (move + attack simultaneously) works via two concurrent touch points.
9. Resize window mid-fight — canvas rescales, no errors, aspect preserved (letterboxing).
10. Screenshots: title, fight (each engine), touch-controls view — saved to `test/screenshots/`.

Exit code 0 with `ALL TESTS PASSED` plus a per-test PASS/FAIL summary; non-zero otherwise.

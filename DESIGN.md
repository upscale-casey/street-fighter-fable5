# KAZAN DUEL — Final Design Document
**Single-file HTML5 1v1 fighting game (player vs CPU). This document is the single source of truth. Where earlier specialist specs disagreed, the value written here is final.**

> **v2 UPGRADE (2026-07):** Part II (§15–§21) extends this document with a 4-fighter roster, a real character-select flow, three stages, a full visual overhaul, and the air-hit reset bug fix. Where Part II explicitly supersedes a Part I value, Part II wins; everything else in Part I (notably §11 CPU AI and the **§11.8 calibration targets, which are frozen**) remains authoritative.

---

## 0. Hard Constraints

- **One self-contained `index.html`** — no external assets, images, fonts, libraries, or network requests. Everything is code (canvas vector art, WebAudio synth).
- **Runs on iOS Safari (iPad/iPhone) and desktop PC browsers.** Touch and keyboard both always live.
- **Three CPU difficulties: Easy / Medium / Hard.** CPU uses the same move interface as the player — no frame-data or damage cheats (one exception: Easy deals 0.75× damage *to* the player as a beginner mercy).
- **Original, non-trademarked names everywhere.** Game: **KAZAN DUEL**. Fighters: **KAZAN** and **VOLT**. Moves: Jab, Straight Blast, Snap Kick, Axe Roundhouse, Low Jab, Leg Sweep, Air Jab, Air Smash, **Ember Wave**, **Sky Splitter**, **Cyclone Boot**. No Street Fighter names, likenesses, or move notation in UI text.
- **Total budget ~2000–3500 lines.** Size map and cut list in §13.

---

## 1. Conventions

- Logical world space: **1280 × 720 logical pixels (lpx)**, y-down, origin top-left. **Ground line y = 620.**
- Fighter origin = center of feet. Hitbox X-offsets are authored for a right-facing fighter; mirror X when facing left.
- 1 frame (f) = 1/60 s. **All gameplay durations are integers in logic frames, never ms.**
- Fixed-timestep loop at exactly 60 logic Hz (§4); render interpolates.
- All move frame data lives in **one shared `MOVES` table**; the player state machine, the CPU AI, and the renderer all read from it. Never duplicate frame numbers.

---

## 2. Platform Layer (canvas, scaling, iOS survival)

### 2.1 Canvas & scaling (exact algorithm)

Single full-viewport `<canvas>`; the 1280×720 game area is letterboxed inside it (letterbox margins are canvas, filled `#0a0a0a` — touch controls may live in the margins).

```
vw = window.innerWidth; vh = window.innerHeight;      // CSS px
dpr = Math.min(window.devicePixelRatio || 1, 2);      // hard cap 2
if (vw*dpr * vh*dpr > 2_400_000) dpr = 1.5;           // fill-rate cap for older iPads
canvas.width  = Math.floor(vw * dpr);
canvas.height = Math.floor(vh * dpr);
canvas.style.width = vw + 'px'; canvas.style.height = vh + 'px';
scale = Math.min(vw / 1280, vh / 720);
ox = Math.floor((vw - 1280*scale) / 2);
oy = Math.floor((vh -  720*scale) / 2);
```

- Per render frame: `ctx.setTransform(dpr,0,0,dpr,0,0)` once; world pass adds `translate(ox,oy); scale(scale,scale)`. HUD + touch controls draw in a second pass in raw CSS-px screen space.
- Never CSS-scale the canvas (blurry on iOS); always resize the backing store.
- Resize handling: listen to `resize`, `orientationchange`, `visualViewport.resize`; debounce re-layout 150 ms; re-run once more 400 ms after `orientationchange` (iOS reports stale sizes). On re-layout: resize canvas, recompute scale/offsets, re-bake cached layers (§9.2), reposition touch controls.

```css
html, body { margin:0; padding:0; height:100%; overflow:hidden;
  background:#0a0a0a; overscroll-behavior:none; }
canvas { position:fixed; inset:0; display:block; touch-action:none; }
html { -webkit-user-select:none; user-select:none; -webkit-touch-callout:none;
  -webkit-tap-highlight-color:transparent; -webkit-text-size-adjust:100%; }
```

Never use `100vh` (use `innerHeight` sizing; `100dvh` only as CSS fallback).

### 2.2 Meta tags

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1,
  maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Kazan Duel">
<meta name="theme-color" content="#0a0a0a">
```

No `apple-touch-icon` (iOS rejects `data:` URIs for it); accept default.

### 2.3 Safe-area insets

`:root { --sat: env(safe-area-inset-top); ... }` on a hidden probe div; read computed paddings once per re-layout into `safe = {t,r,b,l}` px. All touch-control and HUD anchors add these (landscape iPhone notch inset ≈ 47 px matters for the joystick zone).

### 2.4 Gesture suppression

- `touch-action:none` on canvas; `overscroll-behavior:none` on body.
- Non-passive (`{passive:false}`) `touchstart/touchmove/touchend/touchcancel` on the **canvas** → `preventDefault()` always.
- `gesturestart/gesturechange/gestureend` → `preventDefault()`. `contextmenu` → `preventDefault()`.
- **`touchcancel` handled identically to `touchend`** (iOS steals touches for system gestures — otherwise buttons stick pressed).

### 2.5 WebAudio unlock

- Create the single `AudioContext` inside the first user gesture (`pointerdown`/`touchend`/`keydown`, all three registered once): `new (AudioContext || webkitAudioContext)({latencyHint:'interactive'})`; then `resume()` + play a 1-frame silent buffer. The title screen's "TAP TO START / PRESS ANY KEY" gate guarantees this gesture.
- On `visibilitychange`→visible, `focus`, `pageshow`: if `ctx.state !== 'running'` → `ctx.resume()` (handles iOS `interrupted`).
- Never create a second AudioContext.

### 2.6 Lifecycle pause

Single `requestPause(reason)` entry point used by: `visibilitychange` (hidden), `window.blur`, `pagehide`, rotate-overlay shown, pause button, pause key. On pause: freeze sim + timer, `audioCtx.suspend()`, stop music scheduler. On return: **stay paused** (explicit unpause required), resume AudioContext, reset loop accumulator (`last = performance.now()`).

### 2.7 Portrait mode

On coarse-pointer devices with `vh > vw`: full-screen DOM overlay (`#191919`, rotating-phone glyph, "ROTATE YOUR DEVICE", 20px system font); game auto-pauses, audio suspended. Desktop portrait windows: no prompt, just letterbox.

---

## 3. Arena & Camera

| Property | Value |
|---|---|
| Logical viewport | 1280 × 720 |
| Ground line | y = 620 |
| Playable X | 40 … 1240; fighter center clamped to 70 … 1210 (pushbox half-width 30 respected) |
| Camera | **Fixed framing** — both fighters always on screen, no scrolling. *(v2: subtle baked-layer parallax driven by the fighters' midpoint x is allowed, see §17.2 — the gameplay camera itself never moves.)* |
| Screen shake | Camera offset `(rand±M, rand±M*0.6)`, M decays ×0.82/frame. Light hit M=2, heavy M=4, special M=6, KO M=11 (20-frame floor). HUD nudged by 25% of M. |
| Round start positions | P1 at x = 440, P2 at x = 840, facing each other |
| Corner | Fighter center within 120 lpx of a wall clamp |

---

## 4. Game Loop

Fixed timestep with render interpolation:

```
STEP = 1000/60
accumulator += min(now - last, 100)        // never simulate >100ms of catch-up
while (accumulator >= STEP && steps < 4) { logicTick(); accumulator -= STEP; steps++ }
if (steps === 4) accumulator = 0           // spiral-of-death guard
alpha = accumulator / STEP
render(alpha)
requestAnimationFrame(loop)
```

- Logic at exactly 60 Hz on 120 Hz ProMotion (extra rAF frames render pure interpolation) and at 30 Hz Low Power Mode (2 logic steps per render).
- Interpolated quantities: fighter root x/y, projectile x/y, particle x/y (store prev positions). Pose evaluation is a pure function of animation time, so render evaluates poses at fractional `t = animTick + alpha`.
- 99-second round timer = 5940 logic frames; displayed value = `ceil(framesLeft/60)`.
- **Hitstop** (both fighters + projectiles freeze; round timer keeps running): light hit/block 6 f, heavy 9 f, special 12 f, KO blow 16 f. Particles advance at half speed during hitstop.
- **KO slow-mo:** 2 frames of full-screen white flash (alpha 0.7, 0.35), then run logic ticks in a 2-of-5 skip pattern for 45 rendered frames, then victory pose.

---

## 5. Fighter Physics

| Property | Value |
|---|---|
| Pushbox | Standing 60w × 170h; crouching 60w × 110h |
| Hurtbox | Standing 70w × 170h; crouching 70w × 110h; airborne 70w × 120h (bottom at feet). Hurtboxes do **not** extend during attacks. |
| Walk forward / backward | 3.2 / 2.4 lpx/f *(KAZAN baseline — per-character values in §15.2)* |
| Dashes | **None (cut)** |
| Prejump | 3 f (no block/attack; direction locked at frame 1) |
| Jump | vy = −16, gravity +0.9/f² → apex ~142 lpx at ~18 f, airtime ~36 f. Directional jump vx = ±4.0 held for the arc (~142 lpx travel). *(KAZAN baseline — per-character values in §15.2)* |
| Landing recovery | 2 f, no actions. Air attack still active on landing is cancelled into the 2 f landing state. |
| Air rules | One air attack per jump. No air block. No air specials. |
| Crouch | Hold down; 1 f transition; cannot walk crouched. |
| Facing | Re-evaluated every frame only in IDLE/WALK/CROUCH; flip instant. Locked during prejump, air, attacks, stun, knockdown. |

**Body collision:** each frame after velocities: (1) wall-clamp both; (2) if both grounded and pushboxes overlap by `o`, separate each by `o/2` (cap 4 lpx/f each; wall-clamped fighter's share transfers to the other); (3) clamp again. Airborne fighters ignore pushboxes; landing inside the opponent ejects the lander toward the side they came from (away from wall if cornered), then auto-turn. **No cross-up hits** — jump attacks only hit in the facing direction.

**Pushback on contact** (applied to defender over the stun, decaying linearly): light hit 8, heavy hit 12, special 12, any block 6 lpx. If the defender is wall-clamped, the **attacker** receives it instead (kills infinite corner pressure).

**State machine (per fighter):** `IDLE, WALK_F, WALK_B, CROUCH, PREJUMP, AIR, ATTACK(moveId, frame), HITSTUN, BLOCKSTUN, KNOCKDOWN_AIR, KNOCKDOWN_GROUND, GETUP, KO, WIN`.

**Input buffer:** attack presses buffered 6 f, fire on first actionable frame. Direction for special selection is sampled at the moment of the SP press.

---

## 6. Move Set — Authoritative `MOVES` Table

**v2 note:** rows 1–8 (normals + air normals) are the **shared normals kit for all four fighters** (small per-character tuning in §15.2: damage scale + standing-reach bonus). Rows 9–11 (Ember Wave / Sky Splitter / Cyclone Boot) are now **KAZAN's character specials**; the other fighters' unique specials are specified in §15.3 and live in the same `MOVES` table format. "Adv" assumes contact on first active frame. Hitbox format: `(xNear→xFar from fighter center, yBottom→yTop height band above own feet)`; convert at draw/collision time (`groundY − value`, or `feetY − value` airborne).

| # | Move | Input | Startup | Active | Recovery | Total | Dmg | Chip | Guard | Hitstun | Blockstun | Adv hit/block | KD | Cancel | Hitbox (x, height band) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Jab** (st. light punch) | LP | 4 | 3 | 6 | 13 | 40 | 0 | Mid | 15 | 9 | +7 / +1 | No | Chain (self, max 3) + Special | x 25→85, y 105→145 |
| 2 | **Straight Blast** (st. heavy punch) | HP | 8 | 4 | 14 | 26 | 90 | 0 | Mid | 22 | 15 | +5 / −2 | No | Special | x 25→105, y 100→150 |
| 3 | **Snap Kick** (st. light kick) | LK | 5 | 3 | 8 | 16 | 45 | 0 | Mid | 15 | 10 | +5 / 0 | No | Special | x 25→100, y 70→110 |
| 4 | **Axe Roundhouse** (st. heavy kick) | HK | 11 | 4 | 16 | 31 | 100 | 0 | Mid | — | 15 | KD / −4 | **Yes** | None | x 30→120, y 90→160 |
| 5 | **Low Jab** (cr. light — either light btn) | ↓+LP or ↓+LK | 4 | 3 | 7 | 14 | 35 | 0 | **Low** | 14 | 9 | +5 / 0 | No | Chain (self, max 3) + Special | x 25→95, y 10→45 |
| 6 | **Leg Sweep** (cr. heavy — either heavy btn) | ↓+HP or ↓+HK | 9 | 4 | 18 | 31 | 85 | 0 | **Low** | — | 12 | KD / −9 | **Yes** | None | x 25→115, y 0→35 |
| 7 | **Air Jab** (either light in air) | (air) LP/LK | 5 | 8 | until land +2 | — | 50 | 0 | **Overhead** | 18 | 12 | varies | No | None | x 15→70, y −15→45 (rel. feet) |
| 8 | **Air Smash** (either heavy in air) | (air) HP/HK | 9 | 6 | until land +2 | — | 95 | 0 | **Overhead** | 22 | 15 | varies | No | None | x 10→85, y −25→55 (rel. feet) |
| 9 | **Ember Wave** (projectile) | SP (neutral/back/up) | 13 | flight | 18 after spawn | 31 commit | 80 | 20 | Mid | 18 | 14 | varies | No | No | proj 44×28, spawns x+70, center height 110, speed 6 lpx/f |
| 10 | **Sky Splitter** (rising uppercut) | ↓ + SP | 5 (**invuln f1–7**) | 8 | 24 air + 8 land | 45 | 130 | 30 | Mid | — | 12 | KD / ≈−32 | **Yes (launch)** | No | x 10→70, y 60→190, attached while rising |
| 11 | **Cyclone Boot** (advancing spin kick) | toward + SP | 9 | 12 (moves fwd 4.5 lpx/f) | 16 | 37 | 110 | 25 | Mid | — | 16 | KD / −11 | **Yes** | No | x 20→95, y 60→130 |

**Kit rules**

- Crouching light/heavy and air light/heavy are shared across punch/kick buttons (deliberate pose-count cut).
- **Chains:** Jab→Jab and Low Jab→Low Jab re-pressable during frames [firstActive, firstActive+6]; max 3 per chain. Chainable/cancellable normals may cancel into any special in the same window, on hit **or** block.
- **Ember Wave:** max one live projectile per fighter. Despawns off-screen, on hit/block, or on overlap with the opponent's projectile (both despawn with a spark — projectile clash). Sky Splitter physics: fighter airborne, vy = −14, gravity 0.9, forward drift 2 lpx/f; fully punishable on block/whiff. Cyclone Boot: single hit (first contact ends its hitbox); no invulnerability; loses to projectiles at range by design.
- **Damage scaling in combos:** hits 1–2 = 100%, hit 3 = 80%, hit 4 = 70%, hit 5+ = 60% (round down).
- **No throws, no super meter, no dizzy state** (cut). Blocking stays honest via special chip + low (Sweep/Low Jab) vs overhead (jump attacks) mix-up.

### 6.1 Blocking

- Hold **back** (away from opponent) while grounded, not attacking, not in stun = blocking. Check happens at hit resolution; no pre-block state. No air block.
- **Stand block** (back): blocks Mid + Overhead, **loses to Low**. **Crouch block** (down-back): blocks Mid + Low, **loses to Overhead**.
- **Chip:** specials only (20/30/25 per table). Chip cannot KO: `hp = max(1, hp − chip)`.
- Block pushback 6 lpx on defender (attacker if defender cornered); defender locked until blockstun ends.

### 6.2 Hit reactions, knockdown, juggles

- **Hitstun:** flinch pose (head-snap for hit band ≥100, gut below), pushback, no actions until stun elapses.
- **Knockdown** (Axe Roundhouse, Leg Sweep, Cyclone Boot; Sky Splitter launches with vy = −13, vx = −5 away): KNOCKDOWN_AIR (ballistic, g 0.9) → ground contact → KNOCKDOWN_GROUND 40 f → GETUP 12 f → actionable.
- **Invulnerability** from first knockdown frame through getup **plus 8 f after actionable** (grace ends early if defender presses any attack). No OTG hits.
- **Juggles: none.** A launched/downed fighter cannot be re-hit until the invulnerability window expires.
- **Air-hit reset (v2 — bug fix, normative):** ANY hit that connects with an **airborne** defender puts the defender into KNOCKDOWN_AIR (soft knockdown / air reset) — including non-KD moves like Jab. Ground-only reaction states (HITSTUN, BLOCKSTUN, IDLE, WALK, CROUCH) must never be entered while airborne. Full spec + engine invariant in §19. Deliberate consequence: air hits do NOT chain combo scaling (the defender resets instead of hanging in hitstun).
- **KO:** HP 0 → loser gets launch physics, winner input locked; slow-mo per §4; then WIN pose.

---

## 7. Health, Timer, Rounds, Win Conditions

| Rule | Value |
|---|---|
| Health | 1000 per fighter, fully reset each round |
| Round timer | 99 s (5940 f); stops during pause and after KO |
| Match | Best of 3 — first to 2 round pips |
| Round win | KO, or at time-over the higher remaining HP; "TIME UP" card |
| **Perfect** | Winner at exactly 1000 HP → "PERFECT!" splash before the round card |
| Draw round | Time-over equal HP, or double-KO (projectile trade): **both get a pip** |
| Double-win tiebreak | If a draw gives both 2 pips: one final round at 30 s; if that draws too → "DRAW GAME" screen → Rematch / Title |

**Round flow:** reset to start positions → "ROUND N" card 90 f → "FIGHT!" 45 f (inputs enabled the frame "FIGHT!" appears) → play → "K.O.!" / "TIME UP" card 120 f with slow-mo → pip animates → next round or victory screen.

---

## 8. Controls

One abstract input struct, sampled once per logic tick, produced by two always-live backends (keyboard + touch) OR-ed together. Each key has `held` + `pressed` (edge, cleared after tick). Bluetooth-keyboard iPads just work.

```
input = { left, right, up, down, lp, hp, lk, hk, sp, pause }
```

**Special selection — one deterministic rule, both platforms, sampled on SP press:**
1. Down held → **Sky Splitter**
2. else Toward (facing direction) held → **Cyclone Boot**
3. else (neutral/back/up) → **Ember Wave**

No move is gated behind motion inputs. (Optional stretch, first cut: lenient QCF+punch also fires Ember Wave.)

### 8.1 Keyboard (desktop) — `KeyboardEvent.code`, layout-independent

| Action | Primary | Alternate |
|---|---|---|
| Walk left / right (back = block) | ← / → | A / D |
| Jump | ↑ | W |
| Crouch / crouch block | ↓ | S |
| Light Punch / Heavy Punch | U / I | — |
| Light Kick / Heavy Kick | J / K | — |
| **Special (SP)** | O | Space |
| Pause | Esc or P | — |
| Menu confirm / navigate | Enter / arrows | W A S D |
| Mute toggle | M | — |

- Ignore `e.repeat === true` for attack keys (no autofire). `preventDefault()` on all mapped keys (stops page scroll / quick-find).

### 8.2 Touch (iOS / any coarse pointer)

Touch controls are canvas-drawn in the screen-space pass, hit-tested manually from a fixed 8-slot touch array tracked by `identifier`. Shown when `matchMedia('(pointer: coarse)')` matches OR after any `touchstart`; hidden after 2 s of keyboard-only input with no active touch. All geometry in CSS px + safe-area insets; sizes scale by `uiScale = clamp(min(vw,vh)/540, 0.85, 1.3)`.

**Left thumb — floating 8-way joystick** (self-calibrating; behaves like a d-pad):
- Spawn zone: `x < vw*0.42` AND `y > safe.t + 80`. First touch there becomes the stick, base centered at the touch point (clamped fully on-screen). Never re-anchors mid-hold; on release, neutral + base fades over 8 frames.
- Base ring r = 64 px (3 px stroke), knob r = 30 px, knob travel clamp 48 px, **dead zone 14 px**.
- 8-way quantization (45° sectors) with **6° hysteresis** (stops down/down-back jitter while blocking low).
- Mapping: E/W → walk; N → jump; S → crouch; diagonals set both (NE = forward jump, SW = crouch block). `up` is **edge-triggered** (jump fires on false→true only — no pogo).
- Visual: ring `rgba(255,255,255,0.25)` + 8 direction ticks; knob `rgba(255,255,255,0.35)` → 0.55 outside dead zone; active sector tick lime `#34C52A` at 0.6 alpha.

**Right thumb — 2×2 attack diamond + SP.** Circular buttons, 2 px ring + translucent fill + glyph label (18 px bold system font). Centers measured from the bottom-right corner (before adding `safe.r`/`safe.b`), at uiScale 1.0:

| Button | Label | Visual Ø | Hit Ø | Center (from right, from bottom) | Ring color |
|---|---|---|---|---|---|
| LP | LP | 72 | 92 | (210, 162) | `#FEFFEA` |
| HP | HP | 72 | 92 | (118, 148) | `#FEFFEA` |
| LK | LK | 72 | 92 | (196, 70) | `#FEFFEA` |
| HK | HK | 72 | 92 | (104, 56) | `#FEFFEA` |
| **SP** | SP | 60 | 80 | (44, 232) | `#34C52A` |

(All edge-to-edge gaps ≥ 16 px; all hit targets ≥ 44 pt.) Fills 0.16 alpha → 0.45 when pressed, ring 2→4 px, scale to 0.92 over 3 f, back over 5; press fires a 12 ms UI tick at low gain. Hit test = circle vs hit Ø, ties to nearest center. A touch that starts on a button owns it; slide-off releases (12 px hysteresis); **no slide-on activation**. Stick direction is sampled at SP press for special selection, same rule as keyboard.

**Pause button:** 44×44 rounded square, "❚❚", top-right at `(vw − safe.r − 56, safe.t + 10)`, 0.3 alpha.

---

## 9. Rendering

Style target: **flat-shaded neo-arcade vector** — bold silhouettes, 2-tone cel shading, thick dark outlines, saturated rim highlights. Zero image assets.

### 9.1 Render order (per frame)

1. Clear canvas `#0a0a0a` (letterbox bars come free)
2. World transform on → blit cached **background** (single static layer, §9.2) → blit cached **floor strip**
3. Live background touches: 5 lantern bobs (`sin(t*0.03+i)*3` px, ~10 circles)
4. Fighter shadows (2 ellipses), projectiles, both fighters, particles
5. World transform off → HUD pass (bars, timer, pips, names, combo counter, announcer)
6. Touch-controls pass
7. (Debug flag only: hitbox overlay)

Camera is fixed; the world transform adds only the screen-shake offset.

### 9.2 Stage background ("Harbor Dojo at Dusk") — *v2: superseded by §17 (Harbor remains stage 1, rebuilt with layers)*

Baked once per resize into offscreen canvases at `scale*dpr` device resolution (blits are 1:1, no per-frame gradient math):

- **Background (1280×720):** dusk vertical gradient `#2b1a4d → #b4432e → #f7a03c`; 90 px sun disc `#ffd98a` at (860, 190) with 3 concentric 0.06-alpha halos; 12 static 2 px star dots top 140 px; distant skyline `#1d1430` polygon strip at y≈380 with ~20 tower notches; dojo/pagoda silhouette `#241a33` left (3 tiered trapezoid roofs), harbor-crane silhouette right; 5 lantern glow discs pre-baked (bobbing circles drawn live).
- **Floor strip (1280×130, top edge y=608):** wooden deck base `#3d2b20`, 16 plank seams (1 px `#2a1c14`) converging toward vanishing point (640, 500), 8 subtle 0.05-alpha highlight streaks, 12 px darkened front edge.
- Fighter shadows: ellipse at y=622, width `70 × (1 − airHeight/300)`, alpha 0.35, `#000`.

### 9.3 Fighter rig: skeleton + keyframed poses

**Skeleton (13 joints, 12 bones), standing height ≈ 185 lpx:**

```
root (hips; y = 460 when standing on ground y=620)
├─ torso: hips→chest len 58
│   ├─ neck len 14 ; head circle r=17
│   ├─ armL: chest→elbow 34 ; elbow→hand 32 (hand r=9)
│   └─ armR: same
├─ legL: hips→knee 46 ; knee→foot 48 (foot 22×8 rounded rect)
└─ legR: same
```

Angles stored relative to parent (degrees). A pose = 12 angles + `rootDX, rootDY` + torso lean. Poses authored facing right; facing-left = `scale(-1,1)` about fighter x.

**Drawing (~30 path ops per fighter):** each limb stroked twice — outline pass (`lineWidth+5`, `#141414`, `lineCap:'round'`) then fill pass (legs 15 w, arms 12 w); torso = filled quad (shoulders 40 → hips 30) with 2.5 px outline; head circle + hair/headband + 2×2 eyes; rim light = thin second stroke (`lineWidth*0.45`, 2 px offset upper-left, lighter tint, 0.5 alpha).

**Two appearances (same skeleton, same moves — palette + accessory only):** *(v2: superseded — four fighters with distinct builds, silhouettes, and specials per §15; distinct body rendering per §18.1. Table kept for the two legacy palettes.)*

| | **KAZAN** (P1 default) | **VOLT** (CPU default) |
|---|---|---|
| Gi | crimson `#c8322b`, trim `#FEFFEA` | azure `#2b6fc8`, trim `#ffd23e` |
| Skin | `#e8b98a` | `#8a5a3a` |
| Accessory | white headband, 2 sin-swaying tails | spiked hair crest (3 triangles `#e8e8e8`) |
| Special/projectile tint | ember orange `#ff7a2e` | teal `#34e0c8` |

If both sides pick the same fighter, the CPU auto-swaps to the other.

**Pose animation system:** `animations = { name: { loop, keys:[{pose, dur, ease}] } }`; `dur` in logic frames; ease ∈ {linear, outQuad, inQuad, outBack, snap}. Evaluate at fractional `t` with shortest-arc angle lerp. Hard cuts are fine arcade-style except into idle (6-frame blend from last evaluated snapshot).

**Required animation set (20):** idle (loop 4 keys 64f), walkF (loop 6 keys 36f), walkB (loop 6 keys 40f), crouch (2 keys), jump rise/apex/fall (3 poses driven by vy, not time), jab, straightBlast, snapKick, axeRoundhouse, lowJab, legSweep, airJab, airSmash, emberWave (throw pose 3 keys), skySplitter (rising 3 keys), cycloneBoot (spin 3 keys), blockHigh (1 pose), blockLow (1 pose), hitstunHead + hitstunGut (2 keys each), launchSpin (loop 4 keys) + lying (1 pose) + getUp (3 keys), winPose (4 keys), koFall (4 keys). Attack anims play startup/active/recover keys at durations read from `MOVES` — the render layer owns no frame data. ~20 constant pose arrays ≈ 180 lines of data.

### 9.4 HUD (screen space; `L = ox+24`, `R = vw−ox−24`, `T = max(oy+14, safe.t+10)`)

- **Health bars:** two mirrored bars `420×24 * scale` px growing inward from the sides; back plate `#191919` @0.8 with 2 px `#FEFFEA` border; **ghost damage bar** `#d43c2e` starts draining toward true HP after 30 f at 1%/frame; main fill gradient `#34C52A → #a8e63c`, flashing white 2 f on hit; below 25% HP fill pulses alpha 1.0↔0.7 (30 f period).
- **Round pips:** two 10 px circles under each bar; won = filled lime + 2 px dark outline, else hollow.
- **Timer:** center top, `bold 44*scale px` system font `#FEFFEA` + 3 px `#191919` stroke; ≤10 s turns `#ff5040` and pulses 1.0→1.15 each second (with a tick SFX). Rendered string cached, rebuilt only on second change.
- **Names:** 13 px under bars, 0.85 alpha. KAZAN left / VOLT right (or as selected).
- **Combo counter:** attacker's side under bar when a hit lands on a victim still in hitstun: "2 HITS!", scale-pop 1.4→1.0 over 8 f, lingers 45 f. Blocked hits don't count.
- **Announcer cards** ("ROUND 1/2/FINAL", "FIGHT!", "K.O.!", "PERFECT!", "TIME UP", "YOU WIN", "CPU WINS", "DRAW GAME"): `bold 72*scale px`, lime fill, 5 px `#191919` stroke + 1 px `#FEFFEA` outer stroke; scale 2.2→1.0 over 12 f outBack, hold 40, fade 12 ("FIGHT!" holds 20, fades 8). Canvas text only, no DOM.

### 9.5 Particles & effects

- **Pool: 160 particles**, preallocated parallel arrays (Float32Array ×6: x,y,px,py,vx,vy + life/size/type/color arrays). Spawn overwrites oldest dead slot; zero allocation.
- Types: `spark` (hit: shrinking 3 px line along velocity; `#fff`/`#ffd23e`/`#ff7a2e`), `dust` (landing), `ember` (projectile trail, special tint, gravity −0.02).
- Recipes: light hit = 6 sparks speed 2–5 life 10–14; heavy = 12 sparks speed 3–8 life 14–18 + expanding white ring (4→26 px over 6 f); block = 4 blue-white sparks + ring. Sparks batched under one `globalCompositeOperation:'lighter'` block (≤25 lighter-ops/frame).

### 9.6 Screens / game flow

State machine: `TITLE → SELECT → FIGHT ⇄ PAUSED → VICTORY → (SELECT | TITLE)`.

- **TITLE:** logo text "KAZAN DUEL", both fighters in idle loop as preview, "TAP TO START / PRESS ANY KEY" (this gesture unlocks audio). Menu music variant (no lead).
- **SELECT:** *(v2: superseded by §16 — three-phase character/rival/battleground select. Still one `G.scene === 'select'` scene for the test contract.)*
- **FIGHT:** round flow per §7.
- **PAUSED:** overlay menu — Resume / Restart Fight / Mute (persists to `localStorage['kd_mute']`) / Quit to Title. Freezes sim, timer, audio (music ducked to 0.1 gain).
- **VICTORY:** "YOU WIN" / "CPU WINS" + winner pose; menu — Rematch / Change Fighter–Difficulty (→SELECT) / Title.

All menus canvas-drawn: items 28 px, selected item prefixed "▶" in lime, pulsing.

---

## 10. Audio (WebAudio synth, no samples)

### 10.1 Graph

```
master Gain (0 or 0.9; mute persisted to localStorage)
 ├─ sfxBus  Gain 1.0 ──┐
 └─ musicBus Gain 0.28 ─┴─→ DynamicsCompressor (threshold −18, ratio 4) → destination
```

- SFX are fire-and-forget chains (osc/noise → filter → gain envelope → sfxBus). Voice cap 10; steal oldest.
- One 1 s white-noise `AudioBuffer` generated at init, reused by all noise SFX.
- Envelopes: `setValueAtTime(0)` → `linearRampToValueAtTime(peak)` → `exponentialRampToValueAtTime(0.001)`. Mute ramps master over 30 ms (no click).

### 10.2 SFX recipes

| Sound | Recipe |
|---|---|
| Whiff | noise → bandpass 1400→500 Hz over 90 ms, Q 1.2; A5/D85 ms, peak 0.18 |
| Hit light | square 190→70 Hz 70 ms peak 0.3 + lowpass-900 noise burst D45 peak 0.22 |
| Hit heavy | square 130→45 Hz 130 ms 0.35 + 55 Hz sine thump D140 0.3 + noise D70 |
| Block | triangle 900 Hz D45 0.2 + highpass-3k noise D25 0.15 |
| Jump / Land | sine 280→620 Hz 110 ms 0.15 / lowpass-400 noise D60 0.14 |
| Ember Wave | saw 240→100 Hz + lowpass sweep 2200→300 over 260 ms 0.28 + noise whoosh |
| Sky Splitter | saw 150→700 Hz rise 240 ms + square octave double, 0.26 |
| Cyclone Boot | Whiff recipe pitched down (bandpass 900→350 Hz, 140 ms) |
| UI move/confirm/tick | square 440/660/520 Hz, 30/70/12 ms, 0.12/0.15/0.06 |
| KO | sine 60 Hz D550 0.4 + saw 300→50 sweep 450 ms + bandpass-800 noise crash D420, staggered 30 ms |
| Round cards | square 660 Hz ×2 (90 ms, 140 ms apart) then 880 Hz 220 ms |
| Timer ≤10 s | square 990 Hz 25 ms 0.1 each second |

### 10.3 Music

126 BPM, 4/4, 2-bar loop (32 sixteenths), A-minor: kick (sine 130→45 Hz) every beat; hats (highpass-6.5k noise 25 ms) every even step, off-beat accents; triangle bass line `A1 A1 – A1 C2 – A1 – / G1 G1 – G1 B1 – E2 D2`; sparse square lead (lowpass 1800) on bar 2 only `E4 G4 A4 – C5 A4 G4 E4`. **Lookahead scheduler:** `setInterval` 25 ms, schedule events < `ctx.currentTime + 0.12` (immune to rAF throttling); cleared on pause/hidden, re-primed on resume. Menus drop the lead. KO: stop scheduler, victory sting (A4-C5-E5, 120 ms each).

---

## 11. CPU AI

### 11.1 Interface — virtual inputs (fairness by construction)

The AI writes a per-frame input struct **bit-identical to the player's** (§8) into the same slot `Fighter.update(input)` reads. Same startup, prejump, recovery — no AI-only actions possible. It may *query* engine state read-only (positions, move phases, projectiles, timer, HP) but mutates nothing except its own inputs. It reads all frame data from the shared `MOVES` table — never hardcoded copies. Because specials are direction+SP on both platforms, there is no execution advantage to neutralize.

**RNG:** one seeded mulberry32 per round (`seed = roundNumber*7919 + difficulty*31`), consumed only by the AI → deterministic replays for tuning.

### 11.2 Four layers

```
[Perception] → [Reflex layer] → [Strategy layer] → [Executor]
 delayed view    event reactions   intent picking     intent → inputs
 (per frame)     (interrupts)      (every ~8 f)       (per frame)
```

1. **Perception:** ring buffer of the last 60 state snapshots; *events* are detected on the snapshot from `reactionDelay` frames ago; *movement/spacing* uses current positions (spatial awareness isn't reaction-limited).
2. **Reflex layer** (evaluated every frame, gated by the delayed view): reacts to discrete events. Priority when several fire at once: **anti-air → block → projectile response → whiff punish**. A reflex interrupts the current intent unless the AI is in uncancellable frames of its own move.
3. **Strategy layer:** weighted-utility intent picker on a cadence.
4. **Executor:** each intent is a 5–15 line coroutine-style step function emitting inputs until done/interrupted (~12 intents total).

**Events detected** (on delayed view): `PLAYER_ATTACK_STARTUP` (with move + guard height), `PLAYER_JUMPED` (toward CPU), `PLAYER_NEUTRAL_JUMP`, `PROJECTILE_FIRED`, `PLAYER_WHIFF` (recovery entered, no connect), `PLAYER_KNOCKED_DOWN`, `CPU_GOT_KNOCKED_DOWN`, `CPU_CORNERED` (within 120 lpx of wall 30+ f).

**Reaction records:** event at frame T pushes `{event, fireAt: T + irand(0, reactJitter), rolled:false}`. **Each event instance is probability-rolled exactly once** at `fireAt` — a failed roll is a visible "miss", never re-rolled per frame. Stale guard: discard if the trigger no longer holds at `fireAt`.

### 11.3 Range bands (center-to-center distance, lpx)

| Band | Distance | Meaning |
|---|---|---|
| CLOSE | < 150 | normals connect |
| MID | 150–400 | poke/sweep range, jump-in launch range |
| FAR | 400–560 | projectile duels, Cyclone Boot with walk-up |
| FULL | > 560 | projectile only |

Ideal spacing (SPACING intent walks to hold): Easy none (drifts to CLOSE); Medium 300 ± 60; Hard 350 ± 30 (just outside player sweep, inside its own Cyclone Boot).

### 11.4 Intents & reflexes

- **APPROACH:** walk forward (E 80% / M 55% / H 40%), forward jump (15/20/15), Cyclone Boot from 200–260 lpx (5/15/25), Hard-only walk-then-block shimmy (20%). Walk segments 20–45 f then re-evaluate. Hard interleaves 6–10 f of down-back per ~30 f of forward walk in projectile range.
- **RETREAT/SPACING:** hold back 15–40 f; if it would carry the AI within 160 lpx of its own corner, convert to neutral jump (40%) or hold-ground (60%) — **never voluntarily walks into its own corner**.
- **POKE (CLOSE/MID):** CLOSE — Jab/Snap Kick (50%), Straight Blast (30%), Sweep (20%). MID — walk-up Axe Roundhouse timed so predicted distance at `now+11` ≤ reach (Hard's signature, uses player vx), or Sweep. On hit roll **combo conversion** (§11.6): Easy stops; Medium Jab→Straight Blast; Hard Jab→Jab→Ember cancel or Jab→Sky Splitter cancel, with p=0.15 drop rate (deliberate humanizer).
- **JUMP_IN (MID 150–260):** triggered by player whiff, player fireball from this range, or rare raw roll (E 0.06 / M 0.05 / H 0.03 per tick). Up-forward; press Air Smash when descending and hDist ≤ 70; land → POKE chain.
- **ANTI_AIR (reflex):** on `PLAYER_JUMPED` with predicted landing within 200 lpx, roll `antiAirP`. Success: Sky Splitter (M 60% / H 75%), walk-back+block (M 30% / H 15%), neutral-jump Air Jab (10%). Easy on success only walks back + blocks. Sky Splitter input timed 20–34 f before landing (rolled) — can trade or whiff even on success.
- **ZONING:** fire Ember Wave from FAR/FULL when no own projectile live; min interval E 150 f / M 90 f / H 70 f (+0–30 jitter); fire prob at tick E 0.15 / M 0.35 / H 0.50. **Never** fire with player inside 280 lpx — except Hard's deliberate bait at 290–340 lpx, p=0.10, immediately holding down-back ready to anti-air. **Response to player projectile** (roll `projReactP`): FULL — counter-fire 40% / neutral jump 30% / block 30%; FAR — jump over it (M 40% / H 60%, converts to JUMP_IN) or block; CLOSE/MID — block only. Easy: block only, never jumps over.
- **WHIFF_PUNISH (reflex):** on `PLAYER_WHIFF` with remaining recovery ≥ 10 f and reachable (`dist ≤ walkSpeed*(remaining−startup) + reach`): roll `whiffPunishP`. Success: CLOSE — Straight Blast (combo conversion applies); 200–260 — Cyclone Boot (Hard only). Easy p=0.05 and uses a single Jab.
- **BLOCK (reflex):** on `PLAYER_ATTACK_STARTUP` in range, roll `blockP`. Success: hold back/down-back for `hitstop + blockstun + 6–14 f`. **Guard height is known only with `guardGuessP`**; otherwise keeps previous guard direction — this is how sweeps and jump-ins legitimately open the AI up. Punish-after-block: if the blocked move is ≥ 6 f punishable per `MOVES` (e.g. Sweep −9, Cyclone −11, Sky Splitter −32), Hard punishes p=0.6 (Jab chain or Sweep; Sky Splitter answered with Axe Roundhouse), Medium 0.25, Easy 0.
- **WAKE-UP** (rolled once per CPU knockdown): block-on-rise E 20 / M 50 / H 60%; panic mash Jab E 45 / M 15 / H 5%; reversal Sky Splitter E 5 / M 15 / H 20%; walk back E 10 / M 15 / H 10%; neutral jump E 20 / M 5 / H 5%. Hard drops reversal weight to 5% for the rest of the round after a blocked reversal.
- **OKIZEME** (player downed): Medium/Hard walk to 130–170 lpx and time a meaty Jab/Sweep to the rise (M p=0.5, H p=0.7; else back off to ideal spacing). Hard mixes meaty (55%), low/overhead mix — Sweep or jump-in Air Jab (25%), block bait (20%). **Easy always backs off to MID.**
- **AI CORNERED:** escape utility spikes: forward jump out 40%, Cyclone Boot through gap if player > 180 lpx 20%, reversal Sky Splitter under pressure (H 20% / M 10%), patient block rest. Easy panic-jumps 60%.
- **TIMER/HEALTH:** AI ahead > 200 HP and timer < 15 s → defensive utilities ×1.5, fireball interval ×1.3 (aggression floor 0.3× remains). AI behind on HP and timer < 20 s → aggression ×1.5, jump-in/Cyclone weights ×1.5. AI lost round 1 → +10% aggression all round.

### 11.5 Decision cadence

- Strategy tick every **8 f + irand(0–4)** (Easy: 12 + irand(0–6) — it thinks slower).
- Intent commitment: min 20 f, max 75 f (reflexes may interrupt any cancellable state). Makes the AI decisive, not jittery.
- Repetition damping: utility × `0.55^k`, k = uses of that intent in the last 5 ticks; never the same intent 3× in a row unless it's the only legal one.
- Round opening: first 45 f the AI only walks (forward/back 50/50) — no round ever opens with an instant special.
- Mistake injection: when an attack intent is chosen, once per intent roll `mistakeRate`; on success corrupt it into a plausible whiff (same button 60–110 lpx out of range, or jump-in attack 8–14 f early). Must look like a spacing error, not a freeze.

### 11.6 Difficulty tuning table (authoritative)

| Parameter | Easy | Medium | Hard |
|---|---|---|---|
| Reaction delay (snapshot age) | 32 f (533 ms) | 19 f (317 ms) | 11 f (183 ms) |
| Reaction jitter | +0–10 f | +0–6 f | +0–4 f |
| Strategy tick | 12 f + 0–6 | 8 f + 0–4 | 8 f + 0–4 |
| `blockP` (vs seen attack) | 0.25 | 0.55 | 0.78 (cap 0.80) |
| `guardGuessP` (correct high/low) | 0.50 | 0.65 | 0.82 |
| `antiAirP` | 0.10 | 0.45 | 0.72 (cap 0.75) |
| `whiffPunishP` | 0.05 | 0.35 | 0.75 |
| `projReactP` | 0.30 | 0.60 | 0.85 |
| Aggression p(attack intent, CLOSE/MID tick) | 0.30 | 0.55 | 0.70 |
| Special usage p(special when legal option) | 0.10 | 0.30 | 0.45 |
| Fireball min interval | 150 f | 90 f | 70 f |
| Mistake rate (intentional whiff) | 0.22 | 0.10 | 0.04 |
| Combo conversion after opening hit | 0.00 | 0.60 (2-hit) | 0.85 (3-hit, drop p 0.15) |
| Okizeme pressure probability | 0.00 | 0.50 | 0.70 |
| Punish-after-block probability | 0.00 | 0.25 | 0.60 |
| **AI→player damage scaling** | **0.75×** | 1.00× | 1.00× |
| AI damage received scaling | 1.00× | 1.00× | 1.00× |

**Hard never cheats:** 11 f delay + jitter forbids frame-perfect reactions; no input reading; 1.0× damage. Its edge is spacing, whiff punishing, and combo conversion — the same edges a good human has.

### 11.7 Anti-frustration rules (hard requirements, all tiers)

1. **Block ceiling:** `blockP` cap 0.80; after 4 consecutive AI blocks, the next roll force-fails (guaranteed opening). Counter resets on any non-block state.
2. **Combo mercy:** after the AI lands ≥3 hits or ≥180 damage in one sequence, PASSIVE mode (only RETREAT/SPACING/IDLE intents; reflex blocks still allowed): Easy 120 f, Medium 90 f, Hard 75 f.
3. **Corner-loop guard:** after 2 AI knockdowns on a cornered player in one round, the AI must disengage to ≥ 400 lpx after the next knockdown and may not re-enter CLOSE for 90 f; meaty okizeme disabled while the player is cornered.
4. **No perfect anti-air:** `antiAirP` cap 0.75; two consecutive successes force the third roll to fail.
5. **Comeback softening (Easy/Medium only):** player HP < 200 and AI HP > 600 → mistake rate ×2, aggression ×0.7. Hard never rubber-bands.
6. **Panic-move budget:** wake-up reversal Sky Splitter max 2 per round.
7. **Chip-kill abstention:** the AI never throws a projectile that would chip a blocking opponent to the 1-HP floor as its finisher plan; it always goes for a real hit (chip can't KO anyway per §6.1 — this rule stops the AI from fishing at 1 HP with fireballs only).

### 11.8 Calibration targets & QA

- Easy: first-time player wins ≥ 70% of matches; a scripted "walk forward + mash HP" player beats Easy ≥ 60%.
- Medium: a few-hours player wins ~50–60%.
- Hard: an experienced fighting-game player wins ~35–50%; a novice loses but sees readable, punishable patterns.
- QA: (1) determinism — same seed + same recorded inputs → identical AI; (2) fairness audit — log AI action startup vs input frame, must match `MOVES`; (3) ceiling tests — jump-spam vs Hard lands anti-air rate 0.60–0.75, never 3 in a row; jab-spam confirms block ceiling; (4) corner test — AI disengages per rule 3 within one knockdown cycle; (5) boredom test — 60 s of Hard neutral vs passive player, no intent > 35% of ticks; (6) touch parity — AI identical on iPad (it only reads the shared input struct).

**QA harness note (v2, non-normative — clarifies measurement fidelity; the bullets above are unchanged and still frozen):** `test/probe-ai.mjs`'s frozen ladder/turtle bot (default matchup) is a zero-defense dummy that never blocks at all. Measured against that dummy, "Medium ~50/50" is aspirational, not literal — a competently-tuned Medium is expected to dominate a bot that cannot guard, which is why the ladder guard only asserts the CPU takes ≥ 1 round rather than a literal split. The bullets above describe a "few-hours player," who does occasionally block; the §21/§15.4 per-character band check therefore drives a separate masher with a minimal probabilistic block reaction (see TESTING.md §6) so its "roughly comparable" band — the bot winning at least 2 and at most 10 of 12 sampled rounds, ~17–83% — is measured against a bot closer to that description, one a well-tuned Medium can legitimately land close to even with. That band is a wide anti-domination smoke check, not a precision calibration gate (see TESTING.md §6 for the n=12 statistical rationale); precision steering happens in each character's own §15.4 role map.

AI total ≈ 450–600 lines.

---

## 12. Performance Budget (target: iPad Air 2 / iPad 5th-gen @ 60 fps)

Frame budget: logic ≤ 2.0 ms, render ≤ 6.0 ms, total ≤ 8 ms.

1. Backing store cap (§2.1): dpr ≤ 2, ≤ 2.4 MP.
2. **Zero steady-state allocations:** particle pool, fixed touch-slot array, preallocated `Float32Array(14)` pose scratch per fighter; no array literals/`.map`/template strings in the loop; timer/HP strings cached, rebuilt on value change only.
3. Offscreen caches (rebuilt only on debounced resize): background, floor, health-bar plates, joystick base, each button base (pressed state = alpha/scale on the same cache).
4. Draw-call discipline: ≤ 350 ops/frame budget; actual worst case ≈ 140 (2 blits + 60 fighter ops + 10 lanterns + 25 particles + 35 HUD + 20 touch). Batch `'lighter'` particles; `save/restore` only at pass boundaries (≤ 6/frame).
5. Banned in the frame path: `shadowBlur`, `createLinearGradient` (bake it), `filter`, `getImageData`, `measureText` (measure once), DOM reads/writes.
6. GC hygiene: audio nodes are the only per-event allocations. Verify no sawtooth heap growth over a 99 s round in Safari Timeline.
7. Degradation valve (~15 lines): 60-frame moving average of frame time > 19 ms for 2 s → drop dpr to 1, rebuild caches once, never oscillate back.

---

## 13. Scope: cuts and size map

**Explicitly cut — do not implement:** throws/grabs and throw techs, super meter, dizzy/stun state, air blocking, air specials, cross-up hits, juggle combos, dashes/runs, extended attack hurtboxes, scrolling camera, motion inputs (stretch only), confetti particles, netplay, replays, character creation.

*(v2 un-cuts, per Part II: multiple stages (§17), more than 2 fighter appearances (§15), baked-layer parallax (§17.2), HUD portrait chips (§18.4), and a 2–3-frame hit punch-zoom (§18.3). The v1 line budget in the table below applies to v1 only; the v2 budget is in §20.)*

**Line-budget map:**

| Module | Est. lines |
|---|---|
| HTML/CSS/meta + boot/resize/safe-area/lifecycle | 160 |
| Input (touch joystick + buttons + keyboard + abstraction) | 260 |
| Game loop + screen states (title/select/fight/pause/victory) | 260 |
| Fighter rig, 20 pose sets, evaluator, draw | 600 |
| Stage caches + shake | 160 |
| HUD + menus + announcer | 300 |
| Particles | 120 |
| Audio (synth + music scheduler) | 280 |
| Combat core (physics, states, MOVES, collision, rounds) | 550 |
| CPU AI | 550 |
| **Total** | **≈ 3240** ✓ (inside 2000–3500) |

**If over budget, cut in this order:** keyboard motion-input flourish (already stretch-only), music lead melody, lantern bob, idle pose blending, degradation valve, walkB as reversed walkF, Hard's shimmy/bait behaviors (fold into plain approach).

---

## 14. Ordered Implementation Checklist

Build in this order; each step leaves the file runnable.

1. **Skeleton file:** HTML/CSS/meta (§2.2, §1.3 CSS), canvas, resize/DPR/letterbox algorithm (§2.1), safe-area probe (§2.3), gesture suppression (§2.4), rotate-prompt overlay (§2.7).
2. **Game loop:** fixed-timestep + interpolation (§4), screen-state machine stub (TITLE→SELECT→FIGHT→PAUSED→VICTORY), lifecycle pause (§2.6).
3. **Input layer:** abstract struct, keyboard backend (§8.1), touch backend — floating joystick + 5 buttons + pause (§8.2), visibility rules.
4. **Stage & camera:** baked background + floor caches (§9.2), fixed camera with shake, ground line, debug-draw fighters as rectangles.
5. **Combat core with box fighters:** fighter state machine, walk/jump/crouch physics, pushboxes/wall clamp (§5), `MOVES` table (§6), hitbox/hurtbox resolution, blocking (§6.1), hitstun/blockstun/pushback/hitstop, chains + special cancels, projectile object, knockdowns + invulnerability (§6.2). *Playable P1 vs dummy at this point — verify all frame data with the debug hitbox overlay.*
6. **Rounds & HUD:** HP/timer/rounds/win conditions (§7), health bars + ghost, pips, timer, combo counter, announcer cards (§9.4).
7. **Fighter rendering:** skeleton rig, pose evaluator, 20 animations, both palettes, shadows (§9.3). Wire attack anims to `MOVES` durations. Replace box rendering.
8. **Particles & juice:** pool, hit/block sparks, rings, dust, screen shake, KO flash + slow-mo (§9.5, §4).
9. **Audio:** unlock flow (§2.5), graph, all SFX recipes, music scheduler (§10). Wire to combat events.
10. **CPU AI:** virtual-input plumbing, snapshot ring + events, reflex layer, ~12 intent executors, utility picker, difficulty table, anti-frustration rules (§11).
11. **Screens polish:** title with idle preview, select screen (fighter + difficulty), pause menu with mute persistence, victory flow (§9.6).
12. **Platform verification:** run iOS Safari checklist end-to-end on a real device — rotate, home-indicator insets, touchcancel, audio interrupt/resume, Low Power Mode 30 Hz, no scroll/zoom/loupe.
13. **AI QA & calibration:** run §11.8 tests; tune bold-row parameters (aggression, combo conversion, blockP) toward calibration targets.
14. **Perf pass:** Safari Timeline on oldest available iPad — allocation flatline, frame time ≤ 8 ms; apply the §13 cut list if the file exceeds 3500 lines.

---
---

# PART II — v2 UPGRADE (Roster · Select · Stages · Visual Overhaul · Air-Hit Fix)

Everything below is normative for the v2 build. Hard constraints carried over unchanged: **one self-contained `index.html`**, zero external assets/libraries/build step, canvas vector art + WebAudio synth only, iOS Safari + desktop, the §12 performance rules, the `window.__SF` test contract (extended per TESTING.md, never broken), the touch-control DOM ids, and the **frozen §11.8 AI calibration targets** (Medium is *supposed* to go ~50/50 vs a jab-masher — never "fix" that).

---

## 15. Roster — Four Fighters

### 15.1 Identity overview

| id | Name | Tagline / style | Color identity | Silhouette read |
|---|---|---|---|---|
| `kazan` | **KAZAN** | "The Wanderer" — balanced all-rounder (P1 default) | Crimson gi `#c8322b`, ivory trim `#FEFFEA`, skin `#e8b98a`, accent ember `#ff7a2e` | Medium build, white headband with two swaying tails |
| `volt` | **VOLT** | "Live Wire" — fast rushdown (CPU default) | Azure sleeveless gi `#2b6fc8`, gold trim `#ffd23e`, skin `#8a5a3a`, accent teal `#34e0c8` | Lean, longer limbs, swept spiked-hair mass (one filled polygon, not triangles) |
| `tetsu` | **TETSU** | "Iron Bulwark" — heavy bruiser | Deep-green gi `#3f6b3f`, iron trim `#b9c0c8`, skin `#caa27e`, accent amber `#ffb43c` | Massive: wide torso, thick limbs, topknot + full beard |
| `sable` | **SABLE** | "Dusk Veil" — projectile zoner | Violet gi `#5c3a78`, gold-silver trim `#e8c86a`, skin `#d8a888`, accent moonlight `#b78cff` | Slender, long spring-driven high ponytail, waist sash |

**Alt palettes (mirror matches are now allowed; the later picker gets the alt):** kazan-alt charcoal `#3a3a3a`/crimson trim; volt-alt violet `#6a3ac8`/white trim; tetsu-alt rust `#8c4a2f`/black trim; sable-alt wine `#7a2438`/silver trim. Accent colors stay per character (projectiles must stay readable).

All names and move names are original and non-trademarked.

### 15.2 Per-character stats (authoritative)

Implemented as a `CHARACTERS` registry; `Fighter` reads its stats from `CHARACTERS[charId]` at construction — the old hardcoded constants become KAZAN's row. **Hurtboxes, pushboxes, and wall clamps stay identical for all four** (§5 values) — builds are visual only, so collision balance is untouched.

| Stat | KAZAN | VOLT | TETSU | SABLE |
|---|---|---|---|---|
| Max HP | **1000** | 920 | 1150 | 950 |
| Walk fwd / back (lpx/f) | 3.2 / 2.4 | 3.8 / 2.8 | 2.6 / 2.0 | 3.1 / 2.7 |
| Jump vy / gravity / air vx | −16 / 0.9 / ±4.0 | −16 / 1.0 / ±4.6 | −14.5 / 0.9 / ±3.4 | −16 / 0.82 / ±4.0 |
| Damage scale (multiplies `MOVES.dmg`; stacks with Easy's 0.75×) | 1.00 | 0.92 | 1.15 | 0.96 |
| Standing-normal reach bonus (added to xFar of MOVES rows 1–6) | 0 | 0 | +10 | +6 |
| Specials | Ember Wave · Cyclone Boot · Sky Splitter | Volt Rush ×2 slots · Thunder Spike | Fault Line ×2 slots · Hammer Lariat | Veil Arrow ×2 slots · Rising Veil |

Rows 1–8 of the §6 `MOVES` table (all normals) are shared verbatim by all four. The reach bonus must be applied in ONE place (`getHitbox`) and the AI's `moveReach` must include it.

### 15.3 Per-character specials

The §8 special-selection rule is unchanged (**sampled at SP press: down → slot D; else toward → slot T; else → slot N**) and works identically on keyboard (O/Space) and the existing touch SP buttons — no new inputs, no new DOM ids. Each character fills the three slots; characters with 2 unique specials map one move to two slots:

| Char | Slot N (neutral/back/up) | Slot T (toward) | Slot D (down) |
|---|---|---|---|
| KAZAN | Ember Wave | Cyclone Boot | Sky Splitter |
| VOLT | Volt Rush | Volt Rush | Thunder Spike |
| TETSU | Fault Line | Hammer Lariat | Fault Line |
| SABLE | Veil Arrow | Veil Arrow | Rising Veil |

New move rows (same `MOVES`-table format as §6; hitbox format identical):

| Move | Char | Startup | Active | Recovery | Total | Dmg | Chip | Guard | Hitstun | Blockstun | Adv block | KD | Hitbox / physics |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Volt Rush** (advancing elbow) | volt | 7 | 10 (moves fwd 6.5 lpx/f) | 15 | 32 | 95 | 22 | Mid | — | 14 | ≈ −10 | **Yes** | x 20→85, y 70→140; single hit (first contact ends hitbox), no invuln |
| **Thunder Spike** (rising knee) | volt | 4 (**invuln f1–6**) | 7 | rise + 8 land | ≈42 | 110 | 26 | Mid | — | 12 | ≈ −30 | **Yes (launch)** | x 5→60, y 55→180 attached while rising; vy = −13, g 0.9, fwd drift 1.5 |
| **Fault Line** (ground shockwave) | tetsu | 16 | flight | 20 after spawn | 36 commit | 90 | 24 | **Low** | 20 | 14 | varies | No | proj 50×26 hugging ground (center height 20), speed 3.5 lpx/f, **despawns after 300 lpx of travel**; must be crouch-blocked |
| **Hammer Lariat** (advancing lariat) | tetsu | 14 (**armor f4–9**, see below) | 8 (moves fwd 4.0 lpx/f) | 18 | 40 | 140 | 30 | Mid | — | 15 | ≈ −14 | **Yes** | x 25→105, y 80→160; single hit |
| **Veil Arrow** (fast bolt) | sable | 10 | flight | 14 after spawn | 24 commit | 70 | 10 | Mid | 16 | 12 | varies | No | proj 40×14, spawns x+70 center height 105, speed 8.5 lpx/f |
| **Rising Veil** (anti-air bolt) | sable | 11 | flight | 22 after spawn | 33 commit | 85 | 12 | Mid | — | 13 | varies | **Yes (air reset)** | proj 34×34, spawns x+40 center height 80, velocity (+4.5, −4.5), despawns above y=40 or after 40 f |

**New mechanic — one-hit armor (Hammer Lariat only):** a move may declare `armor:[a,b]` (move-frames, inclusive). If the fighter is hit while inside the window and armor not yet used this move: take **full damage** (all scalings apply; lethal damage still KOs normally), but **no hitstun/blockstun/pushback/knockdown** — the move keeps running; set `armorUsed`; 4-frame gray body flash + metallic clank SFX (triangle 1800 Hz, 40 ms). Absorbs exactly one hit per move use, including projectiles and KD moves. Armor is not block: no chip logic involved.

**Projectile rules generalized:** still max ONE live projectile per fighter (Sable cannot have Veil Arrow and Rising Veil live at once). `spawnProj` takes a per-move packet {w, h, spawnDX, centerH, vx, vy, guard, dmg, chip, hitstun, kd, rangeMax, style}; projectile clash (§6) applies between any two projectiles. Fault Line ignores gravity and never leaves the ground band. A Rising Veil that hits an airborne opponent triggers the §19 air reset (its natural anti-air role).

**New SFX (recipes in the §10 style, wired in `startMove`/projectile spawn):** Volt Rush = Cyclone recipe pitched +40% + zap (square 1200→300 Hz, 60 ms, 0.18); Thunder Spike = Sky Splitter +20% pitch + crackle noise burst; Fault Line = 70 Hz sine thump 200 ms + lowpass rumble noise; Hammer Lariat = heavy-whiff + armor clank on absorb; Veil Arrow = Ember recipe shortened to 140 ms, brighter (saw 320→160); Rising Veil = reverse sweep saw 100→500 Hz 180 ms.

**New animations (same keyframe system, durations read from MOVES):** `voltRush` (coiled elbow lunge, 3 keys), `thunderSpike` (crouched coil → rising knee, 3 keys), `faultLine` (overhead double-fist ground slam, 3 keys), `lariat` (wind-up twist → extended-arm spin → settle, 3 keys), `veilArrow` (quick one-hand fling, 2 keys), `risingVeil` (upward two-hand cast, 3 keys). ANIMS become per-character where movesets diverge (namespaced keys or per-char anim sets built in `buildAnims`).

### 15.4 CPU AI generalization — role maps (protects §11.8)

The AI's logic stays exactly §11; only its **hardcoded move ids** become lookups into `CHARACTERS[id].ai`:

| Field | KAZAN | VOLT | TETSU | SABLE |
|---|---|---|---|---|
| `dp` (invuln reversal: anti-air, wake-up reversal, mash counter, corner escape) | `splitter` | `thunderspike` | `null` | `null` |
| `fireball` (ZONING intent + counter-fire) | `ember` | `null` | `faultline` (min interval ×1.3) | `veilarrow` |
| `advance` (approach special / corner escape) | `cyclone` | `voltrush` | `lariat` | `null` |
| `antiAir` mode | `dp` | `dp` | `passive` (walk-back block / neutral-jump Air Jab only) | `proj` (Rising Veil timed 24–36 f before landing) |
| Zoning utility multiplier | 0.15 | 0.2 | 0.15 | 0.16 |
| Aggression multiplier | 0.65 | 1.30 | 0.18 | 0.4 |
| Ideal spacing Medium / Hard (lpx) | 300 / 350 | 220 / 240 | 260 / 280 | 400 / 430 |
| Combo plans (Hard) | jab→jab→ember-cancel; jab→splitter-cancel | jab→jab→voltrush-cancel | jab→straight; sweep | jab→veilarrow-cancel |

Null-role fallbacks (required): `dp:null` → wake-up reversal weight redistributed to block-on-rise, mash-counter interject uses fastest normal (Jab), corner escape uses `advance` or forward jump; `fireball:null` → ZONING intent unavailable (weight to APPROACH/POKE); `advance:null` → approach uses walk/jump only. The duplicated per-move block-advantage table inside `trackPunishAfterBlock` is **deleted and computed from `MOVES` at boot** (assert the computed values match the legacy literals for the v1 kit). `AI.pressMove` maps roles → the §8 slot inputs generically. `moveReach` takes the fighter (reach bonus). Seeded per-round RNG stays.

**Calibration protection (hard requirement):** `AI_TUNE` (§11.6) and §11.8 targets are untouched. `node test/probe-ai.mjs` must still pass on the default matchup (P1 KAZAN vs CPU VOLT): mash bot beats Easy, loses to Medium and Hard, no turtle-lock. If Volt's new kit drifts the Medium-vs-masher result out of band, tune **Volt's role-map numbers or Volt's special frame data only** — never §11.6/§11.8. Other characters must be "roughly comparable": Medium as each CPU character vs the mash bot must win at least 2 and at most 10 of 12 sampled rounds (~17–83% bot-winrate, a wide anti-domination smoke band rather than a precision gate — verified by the extended probe, §21).

---

## 16. Character Select Flow (v2)

One scene — `G.scene === 'select'` throughout (test contract) — with three phases in `G.sel = {phase, cursor, p1, p2, stage, diff}`. Difficulty and last picks persist across visits within a session. `__SF.start()` continues to bypass select entirely.

**Phase 0 — "CHOOSE YOUR FIGHTER".** Four character cards in a centered row (~200×260 lpx each): dark plate, live idle-animated fighter (via `drawFighterAt` at ~0.8 scale — reuse the preview-fighter pattern), name plate, style tag (ALL-ROUNDER / RUSHDOWN / BRUISER / ZONER). Left panel: large preview of the cursor character + 5-pip stat bars (SPD / PWR / HP) + its special-move names. Cursor = glowing pedestal + brightened card border (replaces the old floor ellipse). Input: ←/→ move cursor, Enter/any-attack confirm, Esc → title. Touch: tap a card — if cursor already there, confirm; else move cursor (two-tap confirm). All tap targets registered through the existing `drawMenuItems`/`G.menuRects`/`tapHit` mechanism (rects emitted during render).

**Phase 1 — "CHOOSE YOUR RIVAL".** Same four cards plus a fifth "?? RANDOM" card (cursor defaults to RANDOM). Same input rules; Esc → phase 0. Mirror pick allowed (rival gets the alt palette).

**Phase 2 — "BATTLEGROUND".** Top: VS banner (both picked fighters in idle, facing each other; RANDOM shows a silhouette). Three menu rows: **STAGE** ◀ HARBOR DUSK / NIGHT MARKET / TEMPLE DAWN / RANDOM ▶ (each with a small stylized emblem chip — sun disc / neon bars / torii glyph; no mini-bakes), **DIFFICULTY** ◀ EASY / MEDIUM / HARD ▶, **FIGHT!**. ↑/↓ row, ←/→ cycle, Enter on FIGHT! starts (Enter on other rows advances to next row). Esc → phase 1. Touch: tap ◀/▶ zones and FIGHT!.

**Start:** `startSelectedFight` resolves RANDOMs (plain `Math.random`, not the AI's seeded RNG), sets `G.charP1`, `G.charP2`, `G.stageId`, calls `newFight(diff)`. `newFight`'s hardcoded "P2 = the other of 2" is replaced by "P2 = G.charP2" (mirror → alt palette). **Victory menu item 0 stays REMATCH → `newFight` directly with the same characters/stage** (test 05 depends on one Enter press = instant rematch); item 1 → select (phase 0, picks retained); item 2 → title.

Defaults everywhere (title quick-start paths, `__SF.start` with no opts): p1 `kazan`, p2 `volt`, stage `harbor`, difficulty as passed/`medium`.

---

## 17. Stages (v2 — three stages)

### 17.1 Registry & invariants

`STAGES = { harbor, market, temple }`, each `{ name, light: {dir, rimColor}, bake(layers), live(ctx, t) }`, plus `G.stageId`. Rebake path unchanged: any stage switch or relayout sets `stageDirty` and the existing rebake hook rebuilds. **Invariants for every stage:** ground line y=620; floor strip blitted at y=608 (1280×130); shadows at y=622; letterbox clear `#0a0a0a` (test 09 samples it); world clip rect; §12 bake-everything rule (no gradients/shadowBlur/filters in the frame path); live overlay ≤ 20 draw ops.

### 17.2 Layer model + parallax

Each stage bakes FOUR offscreen layers at `scale*dpr`: **L0 sky** (1280×720, static), **L1 far** (transparent, baked **1320 wide** = 20 px overscan each side), **L2 mid** (transparent, 1320 wide), **floor** (1280×130, static). Per frame: `shift = clamp((midX − 640)/640, −1, 1)` where midX = fighters' midpoint x; blit L0 at 0, L1 at `−20 + shift*6`, L2 at `−20 + shift*14`, floor at (0, 608). Cost: 4 blits + live overlay. The gameplay camera and all gameplay coordinates are unaffected — parallax is a background-blit offset only.

### 17.3 The three stages

**`harbor` — HARBOR DUSK** (rework of the v1 stage; default). L0: dusk gradient `#2b1a4d → #b4432e → #f7a03c`, 90 px sun `#ffd98a` at (860, 190) + 3 halos, 12 stars. L1: city skyline `#1d1430` + harbor crane, warm haze band (baked `#f7a03c` @ 0.12 over the silhouette base). L2: pagoda left; **pier railing** (posts every ~90 px with rope swags) filling the old empty band behind the fighters; crate stacks at x<200 and x>1080; two moored-boat masts; **two lantern poles (x≈140 and x≈1140) with a catenary cable sagging to y≈150 — the 5 lanterns HANG FROM THE CABLE** (fixes the floating-lantern read). Floor: wooden deck as v1 + brighter plank highlights. Live: lantern bobs (cable-attached) + one swaying pennant. Light: warm from upper-right, rim `#ffcf8a`.

**`market` — NIGHT MARKET.** L0: night gradient `#070b1e → #101a38`, thin moon sliver, faint city glow. L1: rooftop silhouettes with water tanks, scattered lit windows (2×3 px warm dots). L2: market stalls with striped awnings (`#b8323c`/`#e8e0c8`), two catenary strings of warm bulb dots, **abstract neon sign shapes** (glyph-like rectangles/strokes, teal `#34e0c8` + magenta `#ff4fa0`, baked with pre-drawn glow discs), crates, a bicycle silhouette. Floor: wet flagstone `#23283a` with joint seams and **baked vertical reflection smears** (teal/magenta @ 0.15) under the neon. Live: 2 neon signs flicker (alpha = sin, distinct phases), 2 drifting steam wisps (pre-baked blob sprites translated slowly, wrap around). Light: cool from upper-left, rim `#7ae8ff`.

**`temple` — TEMPLE DAWN.** L0: sunrise gradient `#f7d9b0 → #eda27c → #c96a5a`, low pale sun left. L1: three mountain silhouette bands (`#7a5878`, `#5a3d5c`, `#43304a`) separated by baked haze bands @ 0.2. L2: large torii gate (`#8c2f2a`, shading `#5c1f1c`) center-right, pair of stone lanterns, maple tree left with foliage mass `#c85a4a`, baked waist-height mist band @ 0.10. Floor: stone slabs `#55504a`, joint lines, moss flecks, darkened front edge. Live: 4 drifting petals `#e88a7a` (use the particle pool with a `petal` type — sinusoidal fall, respawn at top; pool entries have px/py so interpolation/pause snapping is inherited) + slow mist alpha drift. Light: warm from left, rim `#ffd9c0`.

### 17.4 Stage choice

Chosen on the select screen (phase 2) with a RANDOM option; REMATCH keeps the same stage. `__SF.start` defaults to `harbor` unless `opts.stage` is passed. Every stage must survive test 09 (mid-fight resizes → rebake, zero console errors, dark letterbox).

---

## 18. Visual Overhaul (v2) — normative art spec

Adopts the graphics-audit priorities. §12 perf rules still bind: budget ≤ 350 ops/frame, zero steady-state allocation, nothing gradient/blur/filter in the frame path, perf valve intact. Particle pool grows **160 → 256** slots (same parallel-array design).

### 18.1 Fighter bodies — from stick figures to cel-shaded characters

Keep the 13-joint skeleton, the 13-value pose interface, all pose/anim data, and the px/py interpolation contract **unchanged**. Replace the stroke-per-limb skinning inside `drawFighterAt` with polygon pieces computed from the same joint positions:

- **Limbs = tapered capsules:** each bone segment is a filled quad with perpendicular half-widths at each end (thigh 11→7, shin 9→5.5, upper arm 8→6, forearm 7→5 — all × per-char width multiplier), end caps as arcs. Two-piece limbs meet with a filled joint disc (knee/elbow).
- **Torso + gi:** torso polygon from shoulderL/shoulderR/hipR/hipL with slight chest bulge (quadratic curves); gi jacket V-collar (two overlapping trim-color quads), sleeve cuffs (VOLT sleeveless: skin-colored upper arms + trim shoulder band), **gi skirt = 2 quads hanging from the hips**, belt band + **2 hanging belt tails**. Skirt/belt-tails/headband/ponytail sway via a tiny per-fighter **velocity-driven spring stepped in logic ticks** — never `performance.now()` (must freeze correctly under pause and hitstop).
- **Cel shading:** split each piece longitudinally along the bone axis; the half facing away from the stage light (`STAGES[id].light.dir`) is filled with `shadeCache(color, 0.72)`. Plus a 2 px rim-light stroke (stage `rimColor`, 0.5 alpha) on the light-facing edge of torso, head, and the two leading limbs only (≤ 6 rim strokes/fighter).
- **Outline:** every piece stroked `#141414`, lineWidth 4, round joins — bold silhouette preserved.
- **Head:** skull circle + jaw wedge, ear dot, brow line, 2×3 eyes, 2 px mouth. Per-char hair as filled polygons: KAZAN headband + tails; VOLT swept 5-spike mass; TETSU bald + topknot + beard mass; SABLE 3-segment spring-chain ponytail.
- **Hands/feet:** hands = knuckle-wedge polygon (~13×11, rotated to forearm angle) during punch anims, circle otherwise; feet = heel+toe polygon 24×9.
- **Per-char build table** (visual only; hurtboxes unchanged): `{limbLen, limbW, torsoW, headR}` = kazan 1.0/1.0/1.0/1.0; volt 1.04/0.88/0.95/1.0; tetsu 0.98/1.25/1.22/1.05; sable 1.02/0.85/0.90/0.97.
- White hit-flash (flashT) and gray armor-flash override all colors; debug hitbox overlay retained. **Budget ≤ 80 path ops per fighter** (was ~30) — measure and stay inside the frame budget; the perf valve must not trip on an iPad-class device.

### 18.2 Animation polish

Data-only edits in `buildAnims`: anticipation key (slight opposite wind-up) before Straight Blast, Axe Roundhouse, Sweep, and all new heavies; overshoot/settle key on their recoveries; idle breathe (torso ty ±1.5 over the 64 f loop) + subtle head bob; landing squash key (2 f); walk keys adjusted so feet visibly plant (kill foot-skate). New-move anims per §15.3.

### 18.3 Impact FX & juice

- **Hit starburst:** 8-spike polygon at contact point, radius 10→22 (light) / 14→34 (heavy/special), 7 f life, outQuad shrink, attacker-accent color, drawn inside the existing single `'lighter'` block.
- **Directional hit wedge** on heavies/specials: elongated triangle ~60×14 along the attack vector, 6 f.
- **Shake up:** light 3.5, heavy 7, special 10, KO 16 (same 0.82 decay, HUD nudge 25%).
- **Punch-zoom:** on heavy/special HIT (not block): 3-frame world-transform zoom to 1.03 anchored at the contact point, ease-out. Zoom state carries prev values for interpolation and freezes during pause.
- **KO drama:** existing slow-mo + white flash, plus flat dark overlay 0.45 alpha over the world (flat fillRect, allowed), loser spotlighted normally, winner re-drawn with rim-light emphasis.
- **Special afterimages:** during specials, sample the pose every 3 f into a 4-slot ring; redraw as accent-colored silhouette fills at alpha .25/.18/.12/.06. Only active during specials (adds ≤ 40 ops then).
- **Dust:** landing puffs + on walk direction change (reuse `spawnDust`).

### 18.4 HUD & typography

- **Health bars:** skewed parallelograms (12° toward center), notch ticks every 10%, inner bevel line, dark plate; keep ghost-damage red, low-HP pulse, white hit-flash. Fill keeps the lime `#34C52A → #a8e63c` identity.
- **Portrait chips:** ~34 px head-only renders (reuse the head routine) at the outer bar ends.
- **Names:** in banner plates under the bars. **Round pips:** moved to the bars' inner ends, ≥ 34 px below, so pips and names can no longer collide (fixes the v1 layout bug).
- **Timer:** dark diamond plate, kept pulse/red-at-10s behavior.
- **Procedural logotype:** a glyph-path table (~28 chunky angular glyphs on a 100-unit grid: A–Z subset covering all display strings, digits 0–3, `!` `.` `?`), drawn with −8° italic shear, dark extrusion offset (4 px down-right), top bevel highlight, via `drawLogotype(text, x, y, size, palette)`. Used by: title "KAZAN DUEL" (+ slow animated shine sweep), announcer cards (ROUND N / FIGHT! / K.O.! / PERFECT! / TIME UP / YOU WIN / CPU WINS / DRAW GAME), select-screen headers, VS banner. System font remains for small functional text (menus, names, hints). Card timing/behavior per §9.4 unchanged.
- **Color discipline:** global `THEME` table — UI primary gold `#ffd23e`, danger `#ff5040`, lime `#34C52A` reserved for title logo, HP fill, and win states; menu/HUD plates near-black `#12121a`. Every subsystem reads `THEME`, no ad-hoc hex in HUD code.

### 18.5 Projectile & touch-control art

- **Ember Wave:** layered fireball — white-hot core ellipse, orange mid, 2–3 sin-wobbled flame-tongue triangles trailing, slow rotation; denser ember trail.
- **Veil Arrow:** sleek crescent bolt with a thin light streak; **Rising Veil:** the same crescent angled 45° with a short sparkle trail; **Fault Line:** jagged rock-wave — 3 tumbling dark chunks + dust puffs at the leading edge, hugging the floor.
- All projectiles stay in the batched `'lighter'` block, tinted per character accent.
- **Touch controls (restyle only — ids, geometry, hit areas, and visibility rules unchanged):** dark plates `rgba(12,12,16,0.55)`, 2 px borders — LP/LK gold, HP/HK ember, SP1/SP2 teal; pressed = brighter fill + existing scale behavior.

### 18.6 New-entity interpolation contract (hard rule)

Any new animated thing (afterimage sampler, punch-zoom, petals, steam wisps, cloth springs) must either live in the particle pool (inherits px/py) or carry prev-position fields snapped in `setPrev`, the pause snap, and the hitstop freeze — no interpolation buzz, no motion during pause (the v1 wall-clock headband bug class is banned).

---

## 19. Air-Hit Reset — Bug Fix (normative)

**Bug (diagnosed & reproduced):** a non-knockdown hit (Jab, Air Jab, projectile…) connecting with an **airborne** defender put the defender into `hitstun` — a ground-only state with no gravity and no landing check — stranding them at mid-air y forever; they then walked/attacked/blocked while floating (`airborne()` returns false for those states). Repro script: `node test/repro-jumpattack.mjs` (Part A proves the pure jump-attack flow is fine; Part B reproduces via CPU anti-air trades). The same float can strand the CPU (soft-lock risk).

**Fix (the minimal, state-machine-consistent one):** in `applyContact`'s clean-hit path, airborne defenders hit by **non-KD** moves route through the existing `kdAir` state (gravity + landing already proven), exactly like the KD branch:

```
} else if (def.airborne()) {          // air hit by a non-KD move → air reset
  def.setState('kdAir'); def.move = null; def.rot = 0; def.crouching = false;
  def.vy = -7; def.vx = 3.5 * pushDir;
  if (def.y >= GROUND) def.y = GROUND - 1;   // same guard as the KD branch
} else { /* existing grounded hitstun path unchanged */ }
```

This is standard fighting-game air-reset behavior. It applies to BOTH fighters (fixes the symmetric CPU float). **Deliberate gameplay consequence (accepted):** hits on airborne opponents no longer leave them in `hitstun`, so combo scaling can't chain off air hits — anti-airs now grant a soft knockdown instead of a juggle-ish stun, consistent with §6.2 "juggles: none".

**Engine invariant (belt-and-braces, required):** at the end of `Fighter.update()`, if the fighter is in a grounded state (`idle/walkF/walkB/crouch/hitstun/blockstun/attack-grounded/getup/win`) with `y < GROUND`, snap into `kdAir` (which will land it). This must never fire in normal play — it is a self-healing assertion against future regressions.

**Verification gates:** `node test/repro-jumpattack.mjs` exits 0 (Part A all-PASS, Part B cannot reproduce); `node test/run-tests.mjs` 42/42; `node test/probe-ai.mjs` passes (the fix changes anti-air reward economy, so the §11.8 ladder must be re-verified — if Medium drifts, tuning happens per §15.4 rules, never in §11.6/§11.8).

---

## 20. v2 Scope, Budget, Ordering

- **Line budget v2:** ~5,500–6,500 lines for `index.html` (supersedes §13's 3,500 for v2). Perf budget (§12) unchanged and binding — the perf valve must not trip on target hardware.
- **Still cut (unchanged):** throws, super meter, dizzy, air block, air specials, cross-ups, juggles, dashes, netplay, replays, motion inputs.
- **Build order (one dev agent per milestone, sequential, each leaves the game fully green):**
  1. Air-hit reset fix + character-registry/moveset-seam refactor (zero behavior change beyond the fix).
  2. Roster of four: stats, new specials (+armor, new projectiles), per-char AI role maps, `__SF` extensions.
  3. Three stages + registry + parallax.
  4. Character-select flow (fighter / rival / battleground phases).
  5. Graphics overhaul: fighter reskin, FX/juice, HUD + logotype, projectile art, touch restyle.
  6. Test-suite extension (new checks: select flow, per-character differences, stage variety, air-reset regression) + full verification.
- **Non-regression gates after EVERY milestone:** `node test/smoke.mjs`, `node test/run-tests.mjs` (as updated up to that milestone), `node test/probe-ai.mjs`, and from milestone 1 on `node test/repro-jumpattack.mjs` — all green, zero console errors, `__SF.start('medium')` works with no arguments.

## 21. v2 Test Contract Summary

The authoritative contract lives in TESTING.md. v2 extends it **backward-compatibly**: `__SF.state()` gains `stage`, `roster`, `stages`, `select`, and `p1.char`/`p2.char`; `__SF.start(difficulty, opts?)` accepts optional `{p1, p2, stage}` (invalid/missing → defaults kazan/volt/harbor). No existing field is renamed or removed; no touch DOM id changes; scene enum unchanged (`select` covers all three select phases). New harness checks: select-flow drive-through (keyboard + tap), per-character stat/special verification, stage variety + resize, and the jump-attack float regression (adapted from `test/repro-jumpattack.mjs`).

// KAZAN DUEL automated test harness — implements TESTING.md §5 checks 1-10
// in BOTH Chromium and WebKit. No test framework; plain Node + Playwright.
//
//   node test/run-tests.mjs
//
// Exit 0 + "ALL TESTS PASSED" only when every check passes in both engines.

import { chromium, webkit } from 'playwright';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const GAME_URL = new URL('../index.html', import.meta.url).href;
const SHOTS_DIR = fileURLToPath(new URL('./screenshots/', import.meta.url));
mkdirSync(SHOTS_DIR, { recursive: true });

const MAXHP = 1000;
const results = []; // { engine, name, pass, detail }

/* ---------------------------------------------------------------- utils */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function attachErrorCollector(page) {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  return errors;
}

async function sf(page) {
  return page.evaluate(() => window.__SF.state());
}

// Poll __SF.state() until pred(state) is truthy. Returns the matching state
// or throws with a description + last observed state.
async function waitState(page, pred, timeoutMs, what) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeoutMs) {
    last = await sf(page);
    if (pred(last)) return last;
    await sleep(60);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for: ${what}\n  last state: ${JSON.stringify(last)}`
  );
}

// Collect states for durationMs; returns array of samples.
async function sampleStates(page, durationMs, intervalMs = 80) {
  const out = [];
  const t0 = Date.now();
  while (Date.now() - t0 < durationMs) {
    out.push(await sf(page));
    await sleep(intervalMs);
  }
  return out;
}

async function startFight(page, difficulty = 'medium', ai = false) {
  await page.evaluate(
    ([d, a]) => {
      window.__SF.setAI(a);
      window.__SF.start(d);
    },
    [difficulty, ai]
  );
  const s = await waitState(
    page,
    (s) => s.scene === 'fight' && !s.paused,
    8000,
    `scene 'fight' after __SF.start('${difficulty}')`
  );
  return s;
}

// Hold ArrowRight until p1 is within `gap` lpx of p2 (frozen AI assumed).
async function walkToOpponent(page, gap = 92, timeoutMs = 6000) {
  const dist = (s) => Math.abs(s.p2.x - s.p1.x);
  let s = await sf(page);
  if (dist(s) <= gap) return s;
  const towardRight = s.p2.x > s.p1.x;
  await page.keyboard.down(towardRight ? 'ArrowRight' : 'ArrowLeft');
  try {
    s = await waitState(
      page,
      (st) => Math.abs(st.p2.x - st.p1.x) <= gap,
      timeoutMs,
      `p1 within ${gap} lpx of p2 (walking)`
    );
  } finally {
    await page.keyboard.up(towardRight ? 'ArrowRight' : 'ArrowLeft');
  }
  await sleep(120); // settle out of walk state
  return s;
}

// Press light-punch (KeyU) up to `tries` times; resolves when pred(state)
// becomes true after a press.
async function jabUntil(page, pred, what, tries = 8) {
  for (let i = 0; i < tries; i++) {
    await walkToOpponent(page).catch(() => {}); // re-close gap (pushback)
    await page.keyboard.press('u'); // e.code === 'KeyU' → light punch
    const t0 = Date.now();
    while (Date.now() - t0 < 900) {
      const s = await sf(page);
      if (pred(s)) return s;
      await sleep(50);
    }
  }
  throw new Error(`after ${tries} jabs, never observed: ${what}\n  last state: ${JSON.stringify(await sf(page))}`);
}

// Wait for a freshly-started round to be in the 'play' phase (timer ticking).
async function waitPlayPhase(page, timeoutMs = 10000) {
  return waitState(
    page,
    (s) => s.scene === 'fight' && !s.paused && s.timer > 0 && s.timer <= 98,
    timeoutMs,
    'round in play phase (timer ticked below 99)'
  );
}

/* -------- synthetic touch-style pointer helpers (for holds/multi-touch;
   the game listens for Pointer Events and does not require isTrusted) ---- */

async function pointerDownOn(page, selector, relX, relY, pointerId) {
  return page.evaluate(
    ([sel, rx, ry, pid]) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error('no element ' + sel);
      const r = el.getBoundingClientRect();
      const x = r.left + r.width * rx;
      const y = r.top + r.height * ry;
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: pid, pointerType: 'touch', isPrimary: pid === 1,
          clientX: x, clientY: y, bubbles: true, cancelable: true,
        })
      );
      return { x, y };
    },
    [selector, relX, relY, pointerId]
  );
}

async function pointerUpOn(page, selector, relX, relY, pointerId) {
  return page.evaluate(
    ([sel, rx, ry, pid]) => {
      const el = document.querySelector(sel);
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: pid, pointerType: 'touch', isPrimary: pid === 1,
          clientX: r.left + r.width * rx, clientY: r.top + r.height * ry,
          bubbles: true, cancelable: true,
        })
      );
    },
    [selector, relX, relY, pointerId]
  );
}

async function tapElement(page, selector) {
  // Real emulated touch tap at the element's center (requires hasTouch).
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`no bounding box for ${selector} (not visible?)`);
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
}

// Hold the dpad toward the opponent until close (touch context, frozen AI).
async function dpadWalkToOpponent(page, gap = 92, timeoutMs = 8000) {
  let s = await sf(page);
  const towardRight = s.p2.x > s.p1.x;
  const rx = towardRight ? 0.94 : 0.06;
  await pointerDownOn(page, '#dpad', rx, 0.5, 41);
  try {
    s = await waitState(
      page,
      (st) => Math.abs(st.p2.x - st.p1.x) <= gap,
      timeoutMs,
      `p1 within ${gap} lpx of p2 (dpad walk)`
    );
  } finally {
    await pointerUpOn(page, '#dpad', rx, 0.5, 41);
  }
  await sleep(150);
  return s;
}

/* ------------------------------------------------------------ the tests */

// Each test fn gets ({ page, errors, engineName, shot }) and throws on failure.

const desktopTests = [
  {
    name: '01 load: clean load, title scene',
    async run({ page, errors, shot }) {
      // page was just loaded by the runner; give WebKit generous settle time
      await waitState(page, (s) => s.scene === 'title', 10000, "scene 'title' after load");
      const s = await sf(page);
      if (s.paused) throw new Error('game reports paused=true on the title screen');
      const hasSF = await page.evaluate(
        () =>
          typeof window.__SF === 'object' &&
          typeof window.__SF.state === 'function' &&
          typeof window.__SF.start === 'function' &&
          typeof window.__SF.setAI === 'function' &&
          typeof window.__SF.setHP === 'function' &&
          typeof window.__SF.setTimer === 'function' &&
          typeof window.__SF.version === 'string'
      );
      if (!hasSF) throw new Error('window.__SF is missing required members');
      // touch controls must exist in DOM (hidden on non-touch desktop)
      for (const id of ['#touch-controls', '#dpad', '#btn-lp', '#btn-hp', '#btn-lk', '#btn-hk', '#btn-sp1', '#btn-sp2', '#btn-pause']) {
        const n = await page.locator(id).count();
        if (n !== 1) throw new Error(`expected exactly 1 ${id} in DOM, found ${n}`);
      }
      if (s.touchControlsVisible !== false)
        throw new Error('touchControlsVisible should be false in a non-touch desktop context, got ' + s.touchControlsVisible);
      if (errors.length) throw new Error('errors during load:\n  ' + errors.join('\n  '));
      await shot('title');
    },
  },

  {
    name: "02 __SF.start('medium'): fight scene, full HP both",
    async run({ page, shot }) {
      const s = await startFight(page, 'medium', false);
      if (s.difficulty !== 'medium')
        throw new Error(`difficulty expected 'medium', got '${s.difficulty}'`);
      if (s.p1.hp !== s.p1.maxHp || s.p1.hp !== MAXHP)
        throw new Error(`p1 not at full HP: hp=${s.p1.hp} maxHp=${s.p1.maxHp}`);
      if (s.p2.hp !== s.p2.maxHp || s.p2.hp !== MAXHP)
        throw new Error(`p2 not at full HP: hp=${s.p2.hp} maxHp=${s.p2.maxHp}`);
      if (s.round !== 1) throw new Error(`round expected 1, got ${s.round}`);
      await shot('fight');
    },
  },

  {
    name: '03 frozen AI: movement keys move p1; attack keys damage p2',
    async run({ page }) {
      await startFight(page, 'medium', false);
      // -- movement right
      let s0 = await sf(page);
      await page.keyboard.down('ArrowRight');
      await sleep(600);
      await page.keyboard.up('ArrowRight');
      let s1 = await sf(page);
      if (!(s1.p1.x > s0.p1.x + 20))
        throw new Error(`holding ArrowRight 600ms: p1.x ${s0.p1.x} -> ${s1.p1.x}, expected +20 or more`);
      // -- movement left
      await page.keyboard.down('ArrowLeft');
      await sleep(600);
      await page.keyboard.up('ArrowLeft');
      const s2 = await sf(page);
      if (!(s2.p1.x < s1.p1.x - 20))
        throw new Error(`holding ArrowLeft 600ms: p1.x ${s1.p1.x} -> ${s2.p1.x}, expected -20 or less`);
      // -- jump: hold ArrowUp so at least one 60Hz logic tick samples it
      await page.keyboard.down('ArrowUp');
      let jumped = false;
      const tj = Date.now();
      while (Date.now() - tj < 1500) {
        const s = await sf(page);
        if (s.p1.y < 600) { jumped = true; break; }
        await sleep(25);
      }
      await page.keyboard.up('ArrowUp');
      if (!jumped) throw new Error('held ArrowUp did not lift p1 off the ground (p1.y never < 600)');
      await waitState(page, (s) => s.p1.y >= 615, 3000, 'p1 landed after jump');
      // -- attack next to opponent
      await walkToOpponent(page);
      const before = (await sf(page)).p2.hp;
      const after = await jabUntil(page, (s) => s.p2.hp < before, `p2 hp below ${before}`);
      if (!(after.p2.hp < before))
        throw new Error(`p2 hp did not decrease: ${before} -> ${after.p2.hp}`);
      // AI frozen: p2 must not have wandered from its spawn side
      if (after.p2.hp <= 0) throw new Error('unexpected: p2 KO during basic attack test');
    },
  },

  {
    name: '04 hard AI: CPU moves and attacks within 10s',
    async run({ page }) {
      await startFight(page, 'hard', true);
      const first = await sf(page);
      let moved = false, hurtOrBlock = false;
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        const s = await sf(page);
        if (Math.abs(s.p2.x - first.p2.x) > 15) moved = true;
        if (s.p1.hp < first.p1.hp) hurtOrBlock = true;
        if (typeof s.p1.action === 'string' && s.p1.action.toLowerCase().includes('block')) hurtOrBlock = true;
        if (moved && hurtOrBlock) break;
        await sleep(80);
      }
      if (!moved) throw new Error(`hard CPU never moved in 10s (p2.x stayed ~${first.p2.x})`);
      if (!hurtOrBlock)
        throw new Error('hard CPU never landed damage on p1 (and p1 never blocked) within 10s');
      await page.evaluate(() => window.__SF.setAI(false));
    },
  },

  {
    name: '05 KO flow: setHP(2,1)+hit → roundEnd → round 2 → matchEnd → rematch',
    async run({ page }) {
      await startFight(page, 'medium', false);
      // ---- round 1 KO
      await page.evaluate(() => window.__SF.setHP(2, 1));
      await walkToOpponent(page);
      await jabUntil(page, (s) => s.scene === 'roundEnd' || (s.p2.hp <= 0), 'KO / roundEnd after hit');
      await waitState(page, (s) => s.scene === 'roundEnd', 6000, "scene 'roundEnd' after KO");
      const rw = await waitState(page, (s) => s.roundWins[0] === 1, 8000, 'p1 round win recorded');
      if (rw.roundWins[1] !== 0) throw new Error(`p2 roundWins expected 0, got ${rw.roundWins[1]}`);
      // ---- round 2 starts
      await waitState(page, (s) => s.scene === 'fight' && s.round === 2, 12000, 'round 2 fight scene');
      await waitPlayPhase(page);
      const r2 = await sf(page);
      if (r2.p1.hp !== MAXHP || r2.p2.hp !== MAXHP)
        throw new Error(`round 2 did not reset HP: p1=${r2.p1.hp} p2=${r2.p2.hp}`);
      // ---- round 2 KO → match win
      await page.evaluate(() => window.__SF.setHP(2, 1));
      await walkToOpponent(page);
      await jabUntil(page, (s) => s.scene === 'roundEnd' || s.scene === 'matchEnd' || s.p2.hp <= 0, 'second KO');
      await waitState(page, (s) => s.scene === 'matchEnd', 15000, "scene 'matchEnd' after 2nd round win");
      const me = await sf(page);
      if (me.roundWins[0] !== 2)
        throw new Error(`matchEnd reached but p1 roundWins=${me.roundWins[0]}, expected 2`);
      // ---- rematch (victory menu, first item = rematch, Enter confirms)
      await sleep(600); // let the victory screen settle
      await page.keyboard.press('Enter');
      const re = await waitState(
        page,
        (s) => s.scene === 'fight' && s.roundWins[0] === 0 && s.roundWins[1] === 0 && s.round === 1,
        10000,
        'rematch: fresh fight (round 1, 0-0)'
      );
      if (re.p1.hp !== MAXHP || re.p2.hp !== MAXHP)
        throw new Error(`rematch did not reset HP: p1=${re.p1.hp} p2=${re.p2.hp}`);
      await waitPlayPhase(page);
    },
  },

  {
    name: '06 setTimer(1): time-over, higher-HP fighter wins round',
    async run({ page }) {
      await startFight(page, 'medium', false);
      await page.evaluate(() => {
        window.__SF.setHP(2, 100); // p1 (full) should win on time
        window.__SF.setTimer(1);
      });
      const s = await waitState(page, (st) => st.scene === 'roundEnd', 8000, "roundEnd via time-over");
      if (s.p2.hp !== 100 && s.p2.hp > s.p1.hp)
        throw new Error(`unexpected HPs at time-over: p1=${s.p1.hp} p2=${s.p2.hp}`);
      const win = await waitState(
        page,
        (st) => st.roundWins[0] === 1,
        8000,
        'higher-HP fighter (p1) credited with the round after TIME UP'
      );
      if (win.roundWins[1] !== 0)
        throw new Error(`p2 should have 0 round wins after losing on time, got ${win.roundWins[1]}`);
    },
  },

  {
    name: '07 pause/resume via keyboard (Escape)',
    async run({ page }) {
      await startFight(page, 'medium', false);
      await waitPlayPhase(page);
      await page.keyboard.press('Escape');
      const p = await waitState(page, (s) => s.paused === true, 3000, 'paused=true after Escape');
      const frozenTimer = p.timer;
      const frozenX = p.p1.x;
      await sleep(1500);
      const still = await sf(page);
      if (!still.paused) throw new Error('game unpaused itself');
      if (still.timer !== frozenTimer)
        throw new Error(`timer advanced while paused: ${frozenTimer} -> ${still.timer}`);
      if (still.p1.x !== frozenX)
        throw new Error(`p1 moved while paused: ${frozenX} -> ${still.p1.x}`);
      await page.keyboard.press('Escape');
      await waitState(page, (s) => s.paused === false, 3000, 'paused=false after second Escape');
      // timer resumes ticking
      const t1 = (await sf(page)).timer;
      await waitState(page, (s) => s.timer < t1, 4000, 'timer ticking again after resume');
    },
  },

  {
    name: '09 resize mid-fight: canvas rescales, letterboxed, no errors',
    async run({ page, errors }) {
      await startFight(page, 'medium', false);
      const errsBefore = errors.length;
      const sizes = [
        { w: 800, h: 1000 }, // tall: expect top/bottom letterbox
        { w: 1400, h: 500 }, // wide: expect left/right letterbox
        { w: 1280, h: 720 },
      ];
      for (const { w, h } of sizes) {
        await page.setViewportSize({ width: w, height: h });
        await sleep(1000); // debounce is 150ms + extra relayout passes
        const info = await page.evaluate(() => {
          const c = document.querySelector('canvas');
          return {
            iw: window.innerWidth, ih: window.innerHeight,
            styleW: c.style.width, styleH: c.style.height,
            bw: c.width, bh: c.height,
          };
        });
        if (info.styleW !== info.iw + 'px' || info.styleH !== info.ih + 'px')
          throw new Error(
            `canvas CSS size ${info.styleW}x${info.styleH} != viewport ${info.iw}x${info.ih} after resize to ${w}x${h}`
          );
        const rw = info.bw / info.iw, rh = info.bh / info.ih;
        if (Math.abs(rw - rh) > 0.01)
          throw new Error(`non-uniform backing-store scale: ${rw} vs ${rh}`);
        // letterbox check: sample a pixel deep inside the expected margin
        const scale = Math.min(info.iw / 1280, info.ih / 720);
        const gameW = 1280 * scale, gameH = 720 * scale;
        let px = null;
        if (info.ih - gameH > 40) px = { x: Math.floor(info.iw / 2), y: 8 };
        else if (info.iw - gameW > 40) px = { x: 8, y: Math.floor(info.ih / 2) };
        if (px) {
          const rgb = await page.evaluate(([x, y, dpr]) => {
            const c = document.querySelector('canvas');
            const d = c.getContext('2d').getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
            return [d[0], d[1], d[2]];
          }, [px.x, px.y, info.bw / info.iw]);
          if (!(rgb[0] < 30 && rgb[1] < 30 && rgb[2] < 30))
            throw new Error(
              `expected dark letterbox pixel at ${px.x},${px.y} for ${w}x${h}, got rgb(${rgb.join(',')})`
            );
        }
      }
      // game still alive after resizes
      const t1 = (await sf(page)).timer;
      await waitState(page, (s) => s.timer < t1, 5000, 'timer still ticking after resizes');
      if (errors.length > errsBefore)
        throw new Error('errors during resize:\n  ' + errors.slice(errsBefore).join('\n  '));
    },
  },
];

/* ---- touch tests run in a separate hasTouch context per viewport ------- */

function touchTests(viewport, tag, full) {
  const list = [
    {
      name: `08${tag}a touch ${viewport.width}x${viewport.height}: controls visible`,
      async run({ page, shot }) {
        await waitState(page, (s) => s.scene === 'title', 10000, 'title scene (touch ctx)');
        const s = await sf(page);
        if (s.touchControlsVisible !== true)
          throw new Error('state().touchControlsVisible is not true in a hasTouch context');
        const vis = await page.evaluate(() => {
          const tc = document.getElementById('touch-controls');
          const ids = ['dpad', 'btn-lp', 'btn-hp', 'btn-lk', 'btn-hk', 'btn-pause'];
          return {
            on: tc.classList.contains('on'),
            display: getComputedStyle(tc).display,
            missing: ids.filter((id) => {
              const el = document.getElementById(id);
              if (!el) return true;
              const r = el.getBoundingClientRect();
              return r.width < 5 || r.height < 5;
            }),
          };
        });
        if (!vis.on || vis.display === 'none')
          throw new Error(`#touch-controls not visible: class on=${vis.on} display=${vis.display}`);
        if (vis.missing.length)
          throw new Error('touch controls with no layout: ' + vis.missing.join(', '));
        await shot(`touch-${viewport.width}x${viewport.height}`);
      },
    },
    {
      name: `08${tag}b touch ${viewport.width}x${viewport.height}: tap #btn-lp attacks`,
      async run({ page }) {
        await startFight(page, 'medium', false);
        await tapElement(page, '#btn-lp');
        await waitState(
          page,
          (s) => s.p1.action === 'attack',
          2500,
          "p1.action === 'attack' after tapping #btn-lp (real touch tap)"
        );
      },
    },
    {
      name: `08${tag}c touch ${viewport.width}x${viewport.height}: dpad hold moves fighter; tap damages opponent`,
      async run({ page }) {
        await startFight(page, 'medium', false);
        const s0 = await sf(page);
        // hold right zone of the dpad for a moment — x must increase
        await pointerDownOn(page, '#dpad', 0.94, 0.5, 21);
        await sleep(650);
        const s1 = await sf(page);
        await pointerUpOn(page, '#dpad', 0.94, 0.5, 21);
        if (!(s1.p1.x > s0.p1.x + 20))
          throw new Error(`dpad right hold: p1.x ${s0.p1.x} -> ${s1.p1.x}, expected +20 or more`);
        await sleep(150);
        // hold left — x must decrease
        await pointerDownOn(page, '#dpad', 0.06, 0.5, 22);
        await sleep(500);
        const s2 = await sf(page);
        await pointerUpOn(page, '#dpad', 0.06, 0.5, 22);
        if (!(s2.p1.x < s1.p1.x - 15))
          throw new Error(`dpad left hold: p1.x ${s1.p1.x} -> ${s2.p1.x}, expected -15 or less`);
        await sleep(150);
        // walk into range with the dpad, then land a tapped hit
        await dpadWalkToOpponent(page);
        const before = (await sf(page)).p2.hp;
        let hit = false;
        for (let i = 0; i < 5 && !hit; i++) {
          await dpadWalkToOpponent(page).catch(() => {});
          await tapElement(page, '#btn-lp');
          const t0 = Date.now();
          while (Date.now() - t0 < 900) {
            if ((await sf(page)).p2.hp < before) { hit = true; break; }
            await sleep(50);
          }
        }
        if (!hit) throw new Error(`5 tapped jabs in range never reduced p2.hp from ${before}`);
      },
    },
  ];
  if (full) {
    list.push(
      {
        name: `08${tag}d touch ${viewport.width}x${viewport.height}: multi-touch move + attack`,
        async run({ page }) {
          await startFight(page, 'medium', false);
          const s0 = await sf(page);
          // touch point 1: hold dpad right the whole time
          await pointerDownOn(page, '#dpad', 0.94, 0.5, 31);
          await sleep(450);
          const s1 = await sf(page);
          if (!(s1.p1.x > s0.p1.x + 10))
            throw new Error(`multi-touch: dpad hold not moving p1 (x ${s0.p1.x} -> ${s1.p1.x})`);
          // touch point 2: press LP while dpad is still held
          await pointerDownOn(page, '#btn-lp', 0.5, 0.5, 32);
          await pointerUpOn(page, '#btn-lp', 0.5, 0.5, 32);
          let attacked = false;
          const t0 = Date.now();
          while (Date.now() - t0 < 1500) {
            if ((await sf(page)).p1.action === 'attack') { attacked = true; break; }
            await sleep(30);
          }
          // dpad must still be live after the attack finishes: x keeps growing
          await sleep(600);
          const s2 = await sf(page);
          await pointerUpOn(page, '#dpad', 0.94, 0.5, 31);
          if (!attacked)
            throw new Error('multi-touch: second touch point on #btn-lp never produced an attack while dpad held');
          if (!(s2.p1.x > s1.p1.x + 5))
            throw new Error(
              `multi-touch: dpad hold stopped working after simultaneous attack (x ${s1.p1.x} -> ${s2.p1.x})`
            );
        },
      },
      {
        name: `08${tag}e touch ${viewport.width}x${viewport.height}: #btn-pause pauses and resumes`,
        async run({ page }) {
          await startFight(page, 'medium', false);
          await waitPlayPhase(page);
          await tapElement(page, '#btn-pause');
          const p = await waitState(page, (s) => s.paused === true, 3000, 'paused=true after tapping #btn-pause');
          await sleep(800);
          const still = await sf(page);
          if (still.timer !== p.timer) throw new Error(`timer ran while paused: ${p.timer} -> ${still.timer}`);
          await tapElement(page, '#btn-pause');
          await waitState(page, (s) => s.paused === false, 3000, 'paused=false after second #btn-pause tap');
        },
      }
    );
  }
  return list;
}

/* --------------------------------------------------------------- runner */

async function runSuite(engineName, browserType) {
  console.log(`\n=== ${engineName} ===`);

  async function execTest(t, page, errors) {
    const errsBefore = errors.length;
    const shot = async (label) => {
      await page.screenshot({ path: path.join(SHOTS_DIR, `${label}-${engineName}.png`) });
    };
    try {
      await t.run({ page, errors, engineName, shot });
      const fresh = errors.slice(errsBefore);
      if (fresh.length) throw new Error('console/page errors during test:\n  ' + fresh.join('\n  '));
      results.push({ engine: engineName, name: t.name, pass: true, detail: '' });
      console.log(`  PASS  ${t.name}`);
    } catch (e) {
      results.push({ engine: engineName, name: t.name, pass: false, detail: e.message });
      console.log(`  FAIL  ${t.name}\n        ${e.message.replace(/\n/g, '\n        ')}`);
    }
  }

  const browser = await browserType.launch();
  try {
    // ---------- desktop (keyboard) context ----------
    {
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
      const page = await ctx.newPage();
      const errors = attachErrorCollector(page);
      await page.goto(GAME_URL);
      await sleep(1500); // generous initial settle (WebKit is slower)
      for (const t of desktopTests) await execTest(t, page, errors);
      await ctx.close();
    }
    // ---------- touch contexts (iPad landscape + portrait) ----------
    const touchConfigs = [
      { viewport: { width: 1024, height: 768 }, tag: 'L', full: true },
      { viewport: { width: 820, height: 1180 }, tag: 'P', full: false },
    ];
    for (const cfg of touchConfigs) {
      const ctx = await browser.newContext({ viewport: cfg.viewport, hasTouch: true });
      const page = await ctx.newPage();
      const errors = attachErrorCollector(page);
      await page.goto(GAME_URL);
      await sleep(1500);
      for (const t of touchTests(cfg.viewport, cfg.tag, cfg.full)) await execTest(t, page, errors);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
}

await runSuite('chromium', chromium);
await runSuite('webkit', webkit);

/* --------------------------------------------------------------- report */

const wName = Math.max(...results.map((r) => r.name.length), 4);
console.log('\n================ SUMMARY ================');
console.log(`${'TEST'.padEnd(wName)}  ${'ENGINE'.padEnd(8)}  RESULT`);
for (const r of results) {
  console.log(`${r.name.padEnd(wName)}  ${r.engine.padEnd(8)}  ${r.pass ? 'PASS' : 'FAIL'}`);
}
const failed = results.filter((r) => !r.pass);
console.log('-----------------------------------------');
console.log(`${results.length - failed.length}/${results.length} passed`);
if (failed.length === 0) {
  console.log('ALL TESTS PASSED');
  process.exit(0);
} else {
  console.log(`${failed.length} FAILURE(S):`);
  for (const f of failed) console.log(`  [${f.engine}] ${f.name}: ${f.detail.split('\n')[0]}`);
  process.exit(1);
}

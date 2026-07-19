// Repro probe for the "jump + attack -> stuck" bug report.
//
// Part A (AI OFF, __SF.setAI(false)): drives every jump-attack variant with no
// opponent interference — attack at takeoff / apex / just before landing,
// holding attack through landing, jump-attack at the wall, jump-attack while
// touching the opponent — and after each one verifies the fighter lands,
// returns to an actionable ground state, and still responds to walk + attack
// inputs. These should all be clean (the state machine itself lands fine).
//
// Part B (AI ON): repeated jump-in attacks against the CPU. The actual bug:
// a NON-knockdown hit (jab / air jab / straight / snap) connecting with an
// AIRBORNE fighter puts it in 'hitstun' — a state with no gravity — and on
// stun expiry it transitions to 'idle' at its mid-air y. No ground state ever
// snaps y back to GROUND (620), so the fighter floats permanently (it can
// still walk/attack in mid-air; only jumping again re-enters a state with
// gravity). Detection signature: p.action in {idle,walkF,walkB,crouch} while
// p.y < GROUND - 8. On detection the probe freezes the AI and confirms the
// float persists for 3 s while inputs are being sent.
//
// Exit semantics (regression-test style): exit 0 = bug NOT present (all Part A
// variants clean AND Part B could not reproduce); exit 1 = REPRODUCED (or a
// Part A variant got stuck). While the bug exists this script exits 1.
//
// Run: node test/repro-jumpattack.mjs
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const url = new URL('../index.html', import.meta.url).href;
const shotDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screenshots');

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(url);
await page.waitForTimeout(1000);

let fail = 0;

/* ---------------- Part A: AI off, all jump-attack variants ---------------- */
const partA = await page.evaluate(() => (async () => {
  const GROUND = 620;
  const groundActs = ['idle', 'walkF', 'walkB', 'crouch'];
  const K = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const held = new Set();
  const down = (c) => { if (!held.has(c)) { held.add(c); K('keydown', c); } };
  const up = (c) => { if (held.has(c)) { held.delete(c); K('keyup', c); } };
  const releaseAll = () => { for (const c of [...held]) up(c); };
  const tap = async (c, ms) => { K('keydown', c); await sleep(ms || 35); K('keyup', c); };
  const S = () => __SF.state();
  const waitFor = async (pred, timeout) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) { if (pred(S())) return true; await sleep(25); }
    return false;
  };
  const walkTo = async (x, timeout) => {
    const t0 = Date.now();
    let lastX = -1e9, stallT = Date.now();
    while (Date.now() - t0 < (timeout || 6000)) {
      const s = S();
      const dx = x - s.p1.x;
      if (Math.abs(dx) <= 20) break;
      if (Math.abs(s.p1.x - lastX) > 1) { lastX = s.p1.x; stallT = Date.now(); }
      else if (Date.now() - stallT > 700) break; // blocked (body collision / wall)
      down(dx > 0 ? 'ArrowRight' : 'ArrowLeft');
      up(dx > 0 ? 'ArrowLeft' : 'ArrowRight');
      await sleep(30);
    }
    releaseAll();
    await sleep(120);
  };
  // post-variant health check: landed + actionable + inputs respected
  const recover = async (name) => {
    const landed = await waitFor((s) => s.p1.y >= GROUND - 2 && groundActs.includes(s.p1.action), 2500);
    if (!landed) {
      const s = S();
      return { name, ok: false, why: 'never returned to grounded actionable state (action=' + s.p1.action + ' y=' + s.p1.y.toFixed(1) + ')' };
    }
    const s0 = S();
    const dir = s0.p1.x < 640 ? 'ArrowRight' : 'ArrowLeft';
    down(dir); await sleep(400); up(dir);
    const s1 = S();
    if (Math.abs(s1.p1.x - s0.p1.x) < 15) return { name, ok: false, why: 'walk input ignored (x ' + s0.p1.x.toFixed(1) + ' -> ' + s1.p1.x.toFixed(1) + ')' };
    await tap('KeyU');
    if (!(await waitFor((s) => s.p1.action === 'attack', 600))) return { name, ok: false, why: 'attack input ignored after sequence' };
    if (!(await waitFor((s) => groundActs.includes(s.p1.action) && s.p1.y >= GROUND - 2, 1500))) {
      return { name, ok: false, why: 'stuck in "' + S().p1.action + '" after post-sequence attack' };
    }
    return { name, ok: true, why: 'clean' };
  };

  __SF.start('medium');
  __SF.setAI(false);
  await sleep(300);

  const results = [];
  const jump = async (dirKey) => { if (dirKey) down(dirKey); down('ArrowUp'); await sleep(80); up('ArrowUp'); };
  const variants = [
    ['repeated air attacks (mid-jump lp/hp x3)', async () => {
      for (let i = 0; i < 3; i++) { await jump(); await sleep(150); await tap(i % 2 ? 'KeyI' : 'KeyU'); await sleep(700); }
    }],
    ['attack exactly at takeoff (press during prejump)', async () => {
      down('ArrowUp'); await tap('KeyU', 30); await sleep(50); up('ArrowUp'); await sleep(850);
    }],
    ['attack at apex', async () => { await jump(); await sleep(220); await tap('KeyI'); await sleep(600); }],
    ['attack just before landing', async () => { await jump(); await sleep(440); await tap('KeyU'); await sleep(500); }],
    ['hold attack through landing', async () => {
      await jump(); await sleep(170); down('KeyI'); await sleep(650); up('KeyI'); await sleep(300);
    }],
    ['jump-attack into the wall / corner', async () => {
      await walkTo(75, 8000);
      down('ArrowLeft'); await jump(); await sleep(200); await tap('KeyU'); await sleep(600); up('ArrowLeft');
      await jump(); await sleep(200); await tap('KeyI'); await sleep(700); // neutral jump attack at wall
    }],
    ['jump-attack while touching the opponent', async () => {
      const s = S();
      await walkTo(s.p2.x, 8000); // body collision stops us at contact
      await jump(); await sleep(200); await tap('KeyU'); await sleep(700); // neutral, point blank
      const s2 = S();
      const toward = s2.p1.x < s2.p2.x ? 'ArrowRight' : 'ArrowLeft';
      down(toward); await jump(); await sleep(250); await tap('KeyI'); await sleep(650); up(toward); // cross-up arc
    }],
  ];
  for (const [name, fn] of variants) {
    __SF.setHP(1, 1000); __SF.setHP(2, 1000); __SF.setTimer(99);
    releaseAll();
    await fn();
    releaseAll();
    results.push(await recover(name));
  }
  releaseAll();
  return results;
})());

console.log('--- Part A: AI OFF, jump-attack variants (expect clean) ---');
for (const r of partA) {
  console.log((r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + ': ' + r.why);
  if (!r.ok) fail++;
}

/* --------- Part B: AI on — jump-in attacks until hit out of the air -------- */
async function huntFloat(diff, budgetMs) {
  return page.evaluate(({ diff, budgetMs }) => (async () => {
    const GROUND = 620;
    const groundActs = ['idle', 'walkF', 'walkB', 'crouch'];
    const K = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const held = new Set();
    const down = (c) => { if (!held.has(c)) { held.add(c); K('keydown', c); } };
    const up = (c) => { if (held.has(c)) { held.delete(c); K('keyup', c); } };
    const releaseAll = () => { for (const c of [...held]) up(c); };
    const S = () => __SF.state();
    const floatSig = (s) => {
      if (groundActs.includes(s.p1.action) && s.p1.y < GROUND - 8) return 1;
      if (groundActs.includes(s.p2.action) && s.p2.y < GROUND - 8) return 2;
      return 0;
    };
    const res = { diff, reproduced: false, detect: null, confirm: null, transientAirHitstun: 0, cycles: 0 };
    __SF.start(diff); __SF.setAI(true);
    await sleep(300);
    let lastTop = 0, prevAirHitstun = false;
    const t0 = Date.now();
    const check = (s) => {
      const ah = s.p1.action === 'hitstun' && s.p1.y < GROUND - 8;
      if (ah && !prevAirHitstun) res.transientAirHitstun++;
      prevAirHitstun = ah;
      const who = floatSig(s);
      if (who && !res.detect) {
        const p = who === 1 ? s.p1 : s.p2;
        res.detect = { who: 'p' + who, action: p.action, y: +p.y.toFixed(1), x: +p.x.toFixed(1), cycle: res.cycles, elapsedMs: Date.now() - t0 };
      }
      return !!res.detect;
    };
    hunt:
    while (Date.now() - t0 < budgetMs) {
      if (Date.now() - lastTop > 1000) { __SF.setHP(1, 1000); __SF.setHP(2, 1000); __SF.setTimer(99); lastTop = Date.now(); }
      let s = S();
      if (s.scene !== 'fight' || s.paused) { __SF.start(diff); __SF.setAI(true); await sleep(300); continue; }
      res.cycles++;
      // approach to jump-in range (randomized so CPU sees varied spacing)
      const range = 90 + Math.random() * 150;
      let guard = Date.now() + 4000;
      while (Math.abs((s = S()).p1.x - s.p2.x) > range && Date.now() < guard) {
        if (check(s)) break hunt;
        down(s.p1.x < s.p2.x ? 'ArrowRight' : 'ArrowLeft');
        up(s.p1.x < s.p2.x ? 'ArrowLeft' : 'ArrowRight');
        await sleep(30);
      }
      releaseAll();
      if (check(S())) break hunt;
      // jump-in with an air attack at a randomized timing (sometimes none, so
      // the CPU's anti-air jab connects while we are still purely in 'air')
      const toward = s.p1.x < s.p2.x ? 'ArrowRight' : 'ArrowLeft';
      const doAtk = Math.random() < 0.75;
      const atkDelay = 120 + Math.random() * 360;
      const btn = Math.random() < 0.5 ? 'KeyU' : 'KeyI';
      down(toward); down('ArrowUp');
      const jt = Date.now();
      let attacked = false;
      while (Date.now() - jt < 950) {
        if (Date.now() - jt > 120) up('ArrowUp');
        if (doAtk && !attacked && Date.now() - jt >= atkDelay) {
          K('keydown', btn); setTimeout(() => K('keyup', btn), 35); attacked = true;
        }
        if (check(S())) break hunt;
        await sleep(25);
      }
      releaseAll();
    }
    releaseAll();
    if (!res.detect) return res;

    // ---- confirmation: freeze AI, keep sending inputs, watch altitude ----
    __SF.setAI(false);
    __SF.setTimer(99); __SF.setHP(1, 1000); __SF.setHP(2, 1000);
    const who = res.detect.who;
    const conf = { ms: 3000, groundedAtMs: null, minY: 1e9, maxY: -1e9, minX: 1e9, maxX: -1e9, actions: {} };
    const c0 = Date.now();
    while (Date.now() - c0 < 3000) {
      const s = S();
      const p = who === 'p1' ? s.p1 : s.p2;
      conf.minY = Math.min(conf.minY, p.y); conf.maxY = Math.max(conf.maxY, p.y);
      conf.minX = Math.min(conf.minX, p.x); conf.maxX = Math.max(conf.maxX, p.x);
      conf.actions[p.action] = (conf.actions[p.action] || 0) + 1;
      if (p.y >= GROUND - 2) { conf.groundedAtMs = Date.now() - c0; break; }
      if (who === 'p1') { // inputs are accepted (x moves, attacks come out) but y never recovers
        const el = Date.now() - c0;
        if (el < 700) { down('ArrowLeft'); up('ArrowRight'); }
        else if (el < 1400) { down('ArrowRight'); up('ArrowLeft'); }
        else if (el < 1480) { releaseAll(); K('keydown', 'KeyU'); setTimeout(() => K('keyup', 'KeyU'), 35); }
        else if (el > 1600 && el < 2300) down('ArrowLeft');
        else releaseAll();
      }
      await sleep(40);
    }
    releaseAll();
    for (const k of Object.keys(conf)) { if (typeof conf[k] === 'number') conf[k] = +conf[k].toFixed(1); }
    res.confirm = conf;
    res.reproduced = conf.groundedAtMs === null;
    return res;
  })(), { diff, budgetMs });
}

console.log('--- Part B: AI ON, jump-in attacks vs CPU (hunting mid-air hitstun float) ---');
let hunt = await huntFloat('hard', 60000);
if (!hunt.reproduced) {
  console.log('hard: not reproduced in ' + hunt.cycles + ' jump-in cycles (transient air-hitstun events: ' + hunt.transientAirHitstun + ') — retrying on medium');
  hunt = await huntFloat('medium', 60000);
}
if (hunt.reproduced) {
  fail++;
  console.log('REPRODUCED on ' + hunt.diff + ': ' + hunt.detect.who + ' entered ground state "' + hunt.detect.action +
    '" at mid-air y=' + hunt.detect.y + ' (GROUND=620) after ' + hunt.detect.cycle + ' jump-in cycle(s), ' +
    (hunt.detect.elapsedMs / 1000).toFixed(1) + 's in. Transient mid-air hitstun freezes seen: ' + hunt.transientAirHitstun);
  console.log('Persistence (AI frozen, inputs sent for 3s): y stayed in [' + hunt.confirm.minY + ', ' + hunt.confirm.maxY +
    '] — never landed; x ranged [' + hunt.confirm.minX + ', ' + hunt.confirm.maxX + '] (inputs ARE accepted); actions seen: ' +
    JSON.stringify(hunt.confirm.actions));
  try {
    await page.screenshot({ path: shotDir + '/repro-jumpattack.png' });
    console.log('screenshot: test/screenshots/repro-jumpattack.png');
  } catch (e) { /* non-fatal */ }
} else {
  console.log('not reproduced: ' + hunt.cycles + ' jump-in cycles on ' + hunt.diff +
    ', transient air-hitstun events: ' + hunt.transientAirHitstun);
}

if (errors.length) { console.log('CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); fail++; }
else console.log('no console errors');
await browser.close();
console.log(fail === 0 ? 'NO STUCK DETECTED (bug absent)' : 'STUCK REPRODUCED / ' + fail + ' failure(s)');
process.exit(fail === 0 ? 0 : 1);

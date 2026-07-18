// Verifies the two round-3 AI fixes end-to-end in headless Chromium:
//  1. turtle-lock: after a close-range mash read, out-of-reach whiff pokes must
//     NOT hold the CPU in permanent down-back (it should attack/approach/deal damage)
//  2. ladder: walk-forward jab-mash bot must beat Easy but lose to Medium and Hard
import { chromium } from 'playwright';

const url = 'file:///Users/caseybarr/Documents/ClaudeCode/street-fighter-fable5/index.html';
const mode = process.argv[2] || 'all';
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(url);
await page.waitForTimeout(1000);

let fail = 0;

if (mode === 'all' || mode === 'turtle') {
  const turtle = await page.evaluate(() => new Promise((resolve) => {
    const K = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
    const tap = (c, ms) => { K('keydown', c); setTimeout(() => K('keyup', c), ms || 35); };
    __SF.start('hard'); __SF.setAI(true);
    let phase = 0, jabs = 0, held = null, lastJab = 0, baseHp = 1000, deadline = 0;
    let crouchN = 0, sampleN = 0;
    const hold = (c) => { if (held !== c) { if (held) K('keyup', held); held = c; if (c) K('keydown', c); } };
    const t0 = Date.now();
    const iv = setInterval(() => {
      const s = __SF.state();
      if (Date.now() - t0 > 60000) { done({ ok: false, why: 'probe timeout in phase ' + phase }); return; }
      if (s.scene !== 'fight' || s.paused) return;
      const dist = Math.abs(s.p1.x - s.p2.x);
      const toward = s.p1.x < s.p2.x ? 'ArrowRight' : 'ArrowLeft';
      const away = s.p1.x < s.p2.x ? 'ArrowLeft' : 'ArrowRight';
      if (phase === 0) {                       // approach to point blank
        hold(toward);
        if (dist <= 120) { hold(null); phase = 1; }
      } else if (phase === 1) {                // build the mash read: 12 close jabs
        if (dist > 140) hold(toward); else hold(null);
        if (Date.now() - lastJab > 130) { tap('KeyU'); lastJab = Date.now(); jabs++; }
        if (jabs >= 12) { phase = 2; hold(away); }
      } else if (phase === 2) {                // back out to whiff range
        hold(away);
        if (dist >= 195) { hold(null); phase = 3; baseHp = s.p1.hp; deadline = Date.now() + 14000; lastJab = 0; }
      } else if (phase === 3) {                // whiff-poke: pre-fix this locks the CPU forever
        if (dist > 240) hold(toward); else if (dist < 165) hold(away); else hold(null);
        if (Date.now() - lastJab > 750) { tap('KeyU'); lastJab = Date.now(); }
        sampleN++;
        if (s.p2.action === 'crouch' || s.p2.action === 'blockstun') crouchN++;
        if (s.p2.action === 'attack') { done({ ok: true, why: 'CPU attacked', crouchFrac: crouchN / sampleN }); return; }
        if (s.p1.hp < baseHp) { done({ ok: true, why: 'CPU dealt damage', crouchFrac: crouchN / sampleN }); return; }
        if (dist <= 150) { done({ ok: true, why: 'CPU closed distance', crouchFrac: crouchN / sampleN }); return; }
        if (Date.now() > deadline) { done({ ok: false, why: 'CPU stayed passive for 14s of out-of-reach pokes', crouchFrac: crouchN / sampleN }); return; }
      }
    }, 16);
    function done(r) { clearInterval(iv); if (held) K('keyup', held); resolve(r); }
  }));
  console.log((turtle.ok ? 'PASS' : 'FAIL') + ' turtle-lock: ' + turtle.why +
    (turtle.crouchFrac !== undefined ? ' (crouch/block frac while poking: ' + turtle.crouchFrac.toFixed(2) + ')' : ''));
  if (!turtle.ok) fail++;
}

if (mode === 'all' || mode === 'ladder') {
  for (const diff of ['easy', 'medium', 'hard']) {
    const r = await page.evaluate((diff) => new Promise((resolve) => {
      const K = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
      __SF.start(diff); __SF.setAI(true);
      let held = null, t0 = Date.now();
      const iv = setInterval(() => {
        const s = __SF.state();
        if (Date.now() - t0 > 300000) { cleanup(); resolve({ result: 'timeout', wins: s.roundWins }); return; }
        if (s.scene === 'matchEnd') { cleanup(); resolve({ wins: s.roundWins }); return; }
        if (s.scene !== 'fight' || s.paused) return;
        const toward = s.p1.x < s.p2.x ? 'ArrowRight' : 'ArrowLeft';
        if (held !== toward) { if (held) K('keyup', held); K('keydown', toward); held = toward; }
      }, 16);
      const jabIv = setInterval(() => { K('keydown', 'KeyU'); setTimeout(() => K('keyup', 'KeyU'), 35); }, 140);
      function cleanup() { clearInterval(iv); clearInterval(jabIv); if (held) K('keyup', held); }
    }), diff);
    // Expectations per DESIGN.md 11.8 calibration targets:
    //  easy   - the masher must win the match (target: mash beats Easy >= 60%)
    //  medium - target win rate for this skill tier is ~50-60%, so either side
    //           may win, but the CPU must never be shut out 2-0 (that was the
    //           original "difficulty collapse" defect)
    //  hard   - the CPU must win the match
    const botWon = r.wins[0] > r.wins[1];
    let ok, expect;
    if (diff === 'easy') { ok = botWon; expect = '(masher should beat easy)'; }
    else if (diff === 'medium') { ok = r.wins[1] >= 1; expect = '(cpu must take at least one round)'; }
    else { ok = !botWon; expect = '(cpu should beat masher)'; }
    if (r.result === 'timeout') ok = false;
    console.log((ok ? 'PASS' : 'FAIL') + ` ladder ${diff}: bot ${r.wins[0]} - cpu ${r.wins[1]} ` + expect + (r.result === 'timeout' ? ' TIMEOUT' : ''));
    if (!ok) fail++;
  }
}

if (errors.length) { console.log('CONSOLE/PAGE ERRORS:\n' + errors.join('\n')); fail++; }
else console.log('no console errors');
await browser.close();
console.log(fail === 0 ? 'ALL PROBES PASSED' : fail + ' PROBE(S) FAILED');
process.exit(fail === 0 ? 0 : 1);

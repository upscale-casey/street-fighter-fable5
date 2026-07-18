// Diagnostic: masher bot vs Medium for one full round, tracing AI internals via __SF.aiDebug()
import { chromium } from 'playwright';

const url = 'file:///Users/caseybarr/Documents/ClaudeCode/street-fighter-fable5/index.html';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(url);
await page.waitForTimeout(800);

const trace = await page.evaluate(() => new Promise((resolve) => {
  const K = (t, c) => window.dispatchEvent(new KeyboardEvent(t, { code: c, bubbles: true }));
  __SF.start('medium'); __SF.setAI(true);
  let held = null, t0 = Date.now();
  const rows = [];
  const iv = setInterval(() => {
    const s = __SF.state();
    if (Date.now() - t0 > 125000 || s.scene === 'roundEnd' || s.scene === 'matchEnd') {
      cleanup();
      rows.push({ final: true, scene: s.scene, wins: s.roundWins.join('-'), botHp: s.p1.hp, cpuHp: s.p2.hp, timer: s.timer });
      resolve(rows);
      return;
    }
    if (s.scene !== 'fight' || s.paused) return;
    const toward = s.p1.x < s.p2.x ? 'ArrowRight' : 'ArrowLeft';
    if (held !== toward) { if (held) K('keyup', held); K('keydown', toward); held = toward; }
  }, 16);
  const jabIv = setInterval(() => { K('keydown', 'KeyU'); setTimeout(() => K('keyup', 'KeyU'), 35); }, 140);
  const sampleIv = setInterval(() => {
    const s = __SF.state(), a = __SF.aiDebug();
    if (s.scene !== 'fight' || !a) return;
    rows.push({ t: ((Date.now() - t0) / 1000).toFixed(1), dist: Math.round(Math.abs(s.p1.x - s.p2.x)),
      botHp: s.p1.hp, cpuHp: s.p2.hp, cpuAct: s.p2.action, timer: s.timer, ...a });
  }, 500);
  function cleanup() { clearInterval(iv); clearInterval(jabIv); clearInterval(sampleIv); if (held) K('keyup', held); }
}));

for (const r of trace) {
  if (r.final) {
    console.log(`FINAL scene=${r.scene} wins=${r.wins} botHp=${r.botHp} cpuHp=${r.cpuHp} timer=${r.timer}`);
  } else {
    console.log(`t=${r.t}s timer=${r.timer} dist=${r.dist} botHp=${r.botHp} cpuHp=${r.cpuHp} cpu=${r.cpuAct} pressN=${r.pressN} chainG=${r.chainG} blkRow=${r.blockedRow} openHold=${r.openHoldT} counter=${r.counterMv} plans=${r.plans} fires=${r.fires} passiveT=${r.passiveT}`);
  }
}
await browser.close();

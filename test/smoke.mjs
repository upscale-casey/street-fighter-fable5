// Quick smoke check: loads index.html in headless Chromium, reports console/page
// errors and the initial __SF.state(). Exit 0 = page loads clean with a title scene.
import { chromium } from 'playwright';

const url = new URL('../index.html', import.meta.url).href;
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
await page.goto(url);
await page.waitForTimeout(1500);
let state = null;
try {
  state = await page.evaluate(() => (window.__SF ? window.__SF.state() : null));
} catch (e) {
  errors.push('__SF.state() threw: ' + e.message);
}
console.log('state:', JSON.stringify(state));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no console errors');
await browser.close();
process.exit(errors.length || !state || state.scene !== 'title' ? 1 : 0);

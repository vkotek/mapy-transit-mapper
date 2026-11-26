import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const url =
  'https://mapy.com/en/turisticka?source=pubt&id=15334169&timeboard=%7B%22l%22%3A%22552628%22%2C%22d%22%3A-1%2C%22v%22%3A%7B%22from%22%3A%222026-11-26T01%3A00%3A00%2B01%3A00%22%2C%22to%22%3A%222026-12-11T01%3A00%3A00%2B01%3A00%22%7D%7D&x=14.0912965&y=50.5241815&z=18.358';

const edgeExe = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const shotDir = path.resolve('test-screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const bridgeCode = fs.readFileSync(path.resolve('dist/content/main-world-bridge.js'), 'utf8');
const overlayCode = fs.readFileSync(path.resolve('dist/content/overlay-app.js'), 'utf8');

const browser = await chromium.launch({
  executablePath: edgeExe,
  headless: true,
});

try {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    bypassCSP: true,
  });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[PAGE ERROR]', msg.text());
  });
  page.on('pageerror', (err) => console.log('[UNCAUGHT]', err.message));

  // Patch chrome.* shim onto existing window.chrome + inject MAIN world bridge
  await page.addInitScript(() => {
    window.addEventListener('unhandledrejection', (e) => {
      console.error('[UNHANDLED]', String(e.reason?.stack || e.reason));
    });
    const fakeChrome = {
      runtime: { sendMessage: async () => ({ ok: true }) },
      storage: { onChanged: { addListener: () => {} } },
    };
    try {
      Object.defineProperty(window, 'chrome', { value: fakeChrome, configurable: true });
    } catch {
      window.chrome = fakeChrome;
    }
  });
  await page.addInitScript(bridgeCode);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('#scene', { timeout: 15000 });

  // Inject ISOLATED world bundle and check for any startup error
  const injectErr = await page.evaluate((code) => {
    try {
      (0, eval)(code);
      return null;
    } catch (e) {
      return String(e?.stack || e);
    }
  }, overlayCode);
  console.log('Overlay inject error:', injectErr);

  const agreeBtn = page.locator('button:has-text("Agree"), button:has-text("Souhlasím")').first();
  if (await agreeBtn.isVisible({ timeout: 3500 }).catch(() => false)) {
    await agreeBtn.click();
    await page.waitForTimeout(500);
  }

  // Close timeboard so we see the Stop Detail Sidebar + wide map
  const closeBtn = page.locator('button.close-overlay').first();
  if (await closeBtn.isVisible({ timeout: 4000 }).catch(() => false)) {
    await closeBtn.click();
  }

  // Wait for sheetIntervals + all poiagg stop coordinates to resolve
  await page.waitForTimeout(4500);

  const hudBefore = await page.evaluate(() => {
    const host = document.getElementById('mapy-transit-mapper-hud-host');
    const canvas = document.getElementById('mapy-transit-mapper-canvas');
    const panel = host?.shadowRoot?.querySelector('.panel');
    return JSON.stringify({
      hasHost: Boolean(host),
      hasCanvas: Boolean(canvas),
      panelClass: panel?.className || null,
      panelText: panel?.textContent?.trim() || '',
      url: window.location.href,
    });
  });
  console.log('=== HUD BEFORE FIT ===\n', hudBefore);
  await page.screenshot({ path: path.join(shotDir, '01-before-fit.png') });

  // Click Fit all connections inside Shadow DOM
  const clickedFit = await page.evaluate(() => {
    const host = document.getElementById('mapy-transit-mapper-hud-host');
    const btn = host?.shadowRoot?.querySelector('.primary-btn');
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }
    return false;
  });
  console.log('Clicked Fit all connections:', clickedFit);

  await page.waitForTimeout(2500);
  console.log('URL AFTER FIT:', page.url());

  const hudAfter = await page.evaluate(() => {
    const host = document.getElementById('mapy-transit-mapper-hud-host');
    return host?.shadowRoot?.querySelector('.panel')?.textContent?.trim() || 'NO_HUD';
  });
  console.log('=== HUD AFTER FIT ===\n', hudAfter);
  await page.screenshot({ path: path.join(shotDir, '02-after-fit.png') });
} finally {
  await browser.close();
}

#!/usr/bin/env node
/**
 * Takes iPhone Pro (393x852) screenshots of the Volundr web UI.
 * Uses Playwright Chromium.
 *
 * Prerequisites:
 *   1. npm run build (builds dist/)
 *   2. npx playwright install chromium
 *   3. System browser dependencies (sudo npx playwright install-deps)
 *
 * Usage:
 *   node scripts/mobile-screenshot.mjs
 *
 * Output: web/screenshots/iphone-*.png
 */

import { chromium } from 'playwright';
import { preview } from 'vite';
import { resolve, dirname } from 'path';
import { mkdir } from 'fs/promises';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT_DIR = resolve(ROOT, 'screenshots');

const DEVICE = {
  viewport: { width: 393, height: 852 },
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  isMobile: true,
  hasTouch: true,
};

async function main() {
  // Start vite preview server
  const server = await preview({
    root: ROOT,
    preview: { port: 4173, strictPort: true },
  });
  const serverUrl = 'http://localhost:4173';
  console.log(`Preview server at ${serverUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(DEVICE);

  try {
    await mkdir(OUT_DIR, { recursive: true });
    const page = await context.newPage();

    // Navigate to main page
    console.log('Navigating to /volundr ...');
    await page.goto(`${serverUrl}/volundr`, { waitUntil: 'networkidle' }).catch(() =>
      page.goto(serverUrl, { waitUntil: 'networkidle' })
    );
    await page.waitForTimeout(2000);

    // Screenshot 1: Main page (sidebar should be hidden)
    await page.screenshot({ path: resolve(OUT_DIR, 'iphone-main.png') });
    console.log('Saved: screenshots/iphone-main.png');

    // Screenshot 2: Open mobile sidebar via hamburger
    const hamburger = page.locator('button[aria-label="Open menu"]').first();
    if (await hamburger.isVisible()) {
      await hamburger.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: resolve(OUT_DIR, 'iphone-sidebar-open.png') });
      console.log('Saved: screenshots/iphone-sidebar-open.png');

      // Close sidebar via backdrop
      const backdrop = page.locator('[class*="sidebarOverlayBackdrop"]').first();
      if (await backdrop.isVisible()) {
        await backdrop.click();
        await page.waitForTimeout(300);
      }
    }

    // Screenshot 3: Open new session wizard
    const newBtn = page.locator('button:has-text("New Session")').first();
    if (await newBtn.isVisible()) {
      await newBtn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: resolve(OUT_DIR, 'iphone-wizard-template.png') });
      console.log('Saved: screenshots/iphone-wizard-template.png');
    }

    console.log('\nAll screenshots saved to web/screenshots/');
  } finally {
    await context.close();
    await browser.close();
    if (server.httpServer) server.httpServer.close();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

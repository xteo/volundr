#!/usr/bin/env node
/**
 * Takes iPhone Pro (393x852) screenshots of the Volundr web UI.
 * Uses Puppeteer with the locally-cached Chrome binary.
 *
 * Usage: node scripts/mobile-screenshot.mjs [--serve]
 *   --serve  Start a local preview server (default: expects localhost:4173)
 */

import puppeteer from 'puppeteer';
import { createServer } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DIST = resolve(ROOT, 'dist');
const OUT_DIR = resolve(ROOT, 'screenshots');

const VIEWPORT = { width: 393, height: 852, deviceScaleFactor: 3 };

async function takeScreenshots() {
  // Start a preview server from the built dist
  let serverUrl;
  let server;

  try {
    // Use vite preview
    const { preview } = await import('vite');
    server = await preview({
      root: ROOT,
      preview: { port: 4173, strictPort: true },
    });
    serverUrl = 'http://localhost:4173';
    console.log(`Preview server at ${serverUrl}`);
  } catch (err) {
    console.error('Failed to start preview server:', err.message);
    console.log('Trying http://localhost:4173...');
    serverUrl = 'http://localhost:4173';
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport(VIEWPORT);

    // Navigate to the main page
    console.log('Navigating to main page...');
    await page.goto(`${serverUrl}/volundr`, {
      waitUntil: 'networkidle2',
      timeout: 15000,
    }).catch(() => {
      // If /volundr doesn't work, try root
      return page.goto(serverUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    });

    // Wait for React to render
    await page.waitForTimeout(2000);

    // Make output dir
    const { mkdir } = await import('fs/promises');
    await mkdir(OUT_DIR, { recursive: true });

    // Screenshot 1: Main page (should show sidebar hidden, empty main or session list)
    await page.screenshot({
      path: resolve(OUT_DIR, 'iphone-main.png'),
      fullPage: false,
    });
    console.log('Saved: screenshots/iphone-main.png');

    // Screenshot 2: Try to open the mobile sidebar by clicking hamburger
    const hamburger = await page.$('button[aria-label="Open menu"]');
    if (hamburger) {
      await hamburger.click();
      await page.waitForTimeout(500);
      await page.screenshot({
        path: resolve(OUT_DIR, 'iphone-sidebar-open.png'),
        fullPage: false,
      });
      console.log('Saved: screenshots/iphone-sidebar-open.png');

      // Close sidebar
      const backdrop = await page.$('[class*="sidebarOverlayBackdrop"]');
      if (backdrop) {
        await backdrop.click();
        await page.waitForTimeout(300);
      }
    }

    // Screenshot 3: Try to open the new session wizard
    const newBtn = await page.$('button');
    // Find the "New Session" button
    const buttons = await page.$$('button');
    for (const btn of buttons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text && text.includes('New Session')) {
        await btn.click();
        await page.waitForTimeout(1000);
        await page.screenshot({
          path: resolve(OUT_DIR, 'iphone-wizard-template.png'),
          fullPage: false,
        });
        console.log('Saved: screenshots/iphone-wizard-template.png');
        break;
      }
    }

    console.log('\nAll screenshots saved to web/screenshots/');
  } finally {
    await browser.close();
    if (server) {
      // vite preview server close
      if (server.close) await server.close();
      else if (server.httpServer) server.httpServer.close();
    }
  }
}

takeScreenshots().catch(err => {
  console.error(err);
  process.exit(1);
});

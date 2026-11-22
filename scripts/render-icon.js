'use strict';
// Renders assets/icon.svg to assets/icon.png (256x256) using the local Chrome via CDP.
const path = require('path');
const { chromium } = require('playwright-core');

(async () => {
  const browser = await chromium.connectOverCDP('http://localhost:29229');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 256, height: 256 });
  const svgPath = path.resolve(__dirname, '..', 'assets', 'icon.svg');
  await page.goto('file:///' + svgPath.replace(/\\/g, '/'));
  await page.screenshot({
    path: path.resolve(__dirname, '..', 'assets', 'icon.png'),
    clip: { x: 0, y: 0, width: 256, height: 256 },
    omitBackground: true,
  });
  await page.close();
  await browser.close();
  console.log('icon.png written');
})();

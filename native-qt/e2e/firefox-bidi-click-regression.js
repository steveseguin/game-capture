'use strict';

// A gate for the browser automation adapter, not an application workflow.
const assert = require('node:assert/strict');
const { launchInstalledFirefox } = require('./firefox-bidi-adapter');

async function main() {
  const argument = process.argv.find((value) => value.startsWith('--firefox-path='));
  assert(argument, 'Pass --firefox-path=<official Firefox executable>');
  const browser = await launchInstalledFirefox({
    executablePath: argument.slice('--firefox-path='.length), headless: true
  });
  try {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await context.newPage();
    await page.goto('data:text/html,<html><body></body></html>');
    await page.evaluate(() => {
      document.body.innerHTML = '<button id="target" style="position:absolute;top:100px;left:100px;width:100px;height:40px">Target</button>' +
        '<div id="cover" style="position:fixed;inset:0;background:gray;z-index:10"></div>';
      window.clicks = [];
      document.addEventListener('click', (event) => window.clicks.push({
        id: event.target.id, trusted: event.isTrusted
      }), true);
      window.readyAt = 0;
      setTimeout(() => {
        document.getElementById('cover').remove();
        window.readyAt = Date.now();
      }, 350);
    });
    await page.locator('#target').click({ timeout: 3000 });
    const uncovered = await page.evaluate(() => ({ clicks: window.clicks, readyAt: window.readyAt }));
    assert(uncovered.readyAt > 0);
    assert.deepEqual(uncovered.clicks, [{ id: 'target', trusted: true }]);

    await page.evaluate(() => {
      window.clicks = [];
      window.motionDone = false;
      const target = document.getElementById('target');
      const start = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - start;
        target.style.left = (100 + Math.min(elapsed, 350)) + 'px';
        if (elapsed >= 350) {
          clearInterval(timer);
          window.motionDone = true;
        }
      }, 10);
    });
    await page.locator('#target').click({ timeout: 3000 });
    const moved = await page.evaluate(() => ({ clicks: window.clicks, motionDone: window.motionDone }));
    assert(moved.motionDone, 'Clicked before the target stopped moving');
    assert.deepEqual(moved.clicks, [{ id: 'target', trusted: true }]);

    await page.evaluate(() => {
      window.clicks = [];
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:gray;z-index:10';
      document.body.append(cover);
    });
    await assert.rejects(page.locator('#target').click({ timeout: 250 }), /stable and unobstructed/);
    assert.deepEqual(await page.evaluate(() => window.clicks), []);
    console.log('PASS: real pointer waits for uncovered/stable targets and refuses covered targets.');
  } finally {
    await browser.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });

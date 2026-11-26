// Browser end-to-end tests: two independent browser contexts act as the sending
// and receiving devices. Requires Playwright with Chromium (npm run test:e2e).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { after, before, describe, test } from 'node:test';
import { startServer } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

let srv;
let browser;

before(async () => {
  srv = await startServer({ iceServers: [] });
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
  });
});

after(async () => {
  await browser?.close();
  await srv?.stop();
});

async function device(options = {}) {
  const context = await browser.newContext({ acceptDownloads: true, ...options });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.errors = errors;
  return page;
}

function file(name, size, mimeType = 'application/octet-stream') {
  return { name, mimeType, buffer: crypto.randomBytes(size) };
}

async function compose(page, files, { text, mode } = {}) {
  await page.goto(`${srv.base}/`);
  await page.waitForSelector('.send-card');
  if (files.length) await page.setInputFiles('.send-card input[type=file]', files);
  if (text) await page.fill('.text-input', text);
  if (mode) await page.click(`.seg-btn[data-mode=${mode}]`);
  await page.click('.send-card .btn-primary');
  await page.waitForSelector('[data-testid=share-code]');
  const code = (await page.textContent('[data-testid=share-code]')).replace(/\D/g, '');
  const link = await page.inputValue('[data-testid=share-link]');
  return { code, link };
}

async function saved(download) {
  return fs.readFile(await download.path());
}

describe('QuickDrop in the browser', () => {
  test('upload mode: send files + text, receive with the 6-digit code on a phone', async () => {
    const sender = await device({ viewport: { width: 1280, height: 900 } });
    const phone = await device({ ...devices['iPhone 13'] });
    const video = file('holiday.mp4', 3 * 1024 * 1024 + 123, 'video/mp4');
    const doc = file('report.pdf', 5000, 'application/pdf');
    const { code } = await compose(sender, [video, doc], { text: 'Photos from the trip 🎉', mode: 'upload' });
    assert.match(code, /^\d{6}$/);
    await sender.waitForSelector('text=Uploaded', { timeout: 20000 });

    await phone.goto(`${srv.base}/receive`);
    await phone.fill('[data-testid=code-input]', code);
    await phone.waitForSelector('[data-testid=accept]');
    assert.match(await phone.textContent('.offer-card'), /holiday\.mp4/);
    await phone.click('[data-testid=accept]');
    await phone.waitForSelector('[data-testid=done]', { timeout: 30000 });
    assert.equal(await phone.textContent('[data-testid=message]'), 'Photos from the trip 🎉');

    const buttons = phone.locator('.result .btn');
    const [first] = await Promise.all([phone.waitForEvent('download'), buttons.nth(0).click()]);
    assert.equal(first.suggestedFilename(), 'holiday.mp4');
    assert.ok((await saved(first)).equals(video.buffer));
    const [second] = await Promise.all([phone.waitForEvent('download'), buttons.nth(1).click()]);
    assert.ok((await saved(second)).equals(doc.buffer));

    const [zip] = await Promise.all([phone.waitForEvent('download'), phone.click('text=Save all (.zip)')]);
    const zipBytes = await saved(zip);
    assert.equal(zipBytes.readUInt32LE(0), 0x04034b50);

    // Sender sees live progress and delivery.
    await sender.waitForSelector('[data-testid=send-status]:has-text("Delivered")', { timeout: 10000 });
    assert.deepEqual(sender.errors, []);
    assert.deepEqual(phone.errors, []);
    await sender.context().close();
    await phone.context().close();
  });

  test('live mode: scanning the QR link streams directly over WebRTC', async () => {
    const sender = await device();
    const receiver = await device();
    const big = file('movie.mov', 2 * 1024 * 1024 + 777, 'video/quicktime');
    const { link } = await compose(sender, [big], { mode: 'direct' });
    assert.match(link, /\/r\/[\w-]{22}#[\w-]{43}$/);

    await receiver.goto(link);
    await receiver.waitForSelector('[data-testid=accept]');
    const [download] = await Promise.all([
      receiver.waitForEvent('download', { timeout: 40000 }),
      receiver.click('[data-testid=accept]'),
    ]);
    assert.ok((await saved(download)).equals(big.buffer));
    assert.match(await receiver.textContent('.done-card'), /Received/);
    await sender.waitForSelector('[data-testid=send-status]:has-text("Delivered")', { timeout: 10000 });
    assert.match(await sender.textContent('.timeline'), /Connected directly/);
    assert.deepEqual(sender.errors, []);
    assert.deepEqual(receiver.errors, []);
    await sender.context().close();
    await receiver.context().close();
  });

  test('live mode: falls back to the encrypted relay when a direct path is not possible', async () => {
    const sender = await device();
    const receiver = await device();
    const files = [file('a.bin', 700 * 1024), file('b.bin', 61440 * 3)];
    const { code, link } = await compose(sender, files, { mode: 'direct' });
    const url = new URL(link);
    await receiver.goto(`${srv.base}/receive?relay=1`);
    await receiver.fill('[data-testid=code-input]', code);
    await receiver.waitForSelector('[data-testid=accept]');
    await receiver.click('[data-testid=accept]');
    await receiver.waitForSelector('[data-testid=done]', { timeout: 30000 });
    const buttons = receiver.locator('.result .btn');
    for (let i = 0; i < files.length; i++) {
      const [dl] = await Promise.all([receiver.waitForEvent('download'), buttons.nth(i).click()]);
      assert.ok((await saved(dl)).equals(files[i].buffer), `file ${i} matches`);
    }
    assert.match(await sender.textContent('.timeline'), /Connected via relay/);
    // After a code is used the receiver's URL becomes the link (refresh-safe).
    assert.equal(new URL(receiver.url()).pathname, url.pathname);
    await sender.waitForSelector('[data-testid=send-status]:has-text("Delivered")', { timeout: 10000 });
    await sender.context().close();
    await receiver.context().close();
  });

  test('text only, and one-time links stop working after use', async () => {
    const sender = await device();
    const receiver = await device();
    const { link } = await compose(sender, [], { text: 'wifi password: hunter2' });
    await receiver.goto(link);
    await receiver.click('[data-testid=accept]');
    await receiver.waitForSelector('[data-testid=done]');
    assert.equal(await receiver.textContent('[data-testid=message]'), 'wifi password: hunter2');

    const again = await device();
    await again.goto(link);
    await again.waitForSelector('text=no longer available');
    await sender.context().close();
    await receiver.context().close();
    await again.context().close();
  });

  test('wrong codes show a helpful error', async () => {
    const page = await device();
    await page.goto(`${srv.base}/receive`);
    await page.fill('[data-testid=code-input]', '000000');
    await page.waitForSelector('.field-error:has-text("doesn’t match")');
    await page.context().close();
  });
});

describe('free-hosting profile in the browser', () => {
  let free;
  before(async () => {
    free = await startServer({
      iceServers: [],
      accountsEnabled: false,
      limits: {
        anonymous: { maxBytes: 0, maxHours: 24, maxDownloads: 10 },
        account: { maxBytes: 0, maxHours: 24, maxDownloads: 10 },
      },
    });
  });
  after(() => free?.stop());

  test('only offers Live for files and shows device history instead of sign-in', async () => {
    const page = await device();
    await page.goto(`${free.base}/`);
    await page.setInputFiles('.send-card input[type=file]', [file('a.bin', 1000)]);
    assert.equal(await page.isVisible('.seg-btn[data-mode=upload]'), false);
    assert.match(await page.textContent('.mode-desc'), /Device to device/);
    assert.equal(await page.textContent('#nav-account'), 'History');
    await page.click('#nav-account');
    await page.waitForSelector('text=Transfers you sent from this browser');
    assert.equal(await page.isVisible('.auth-card'), false);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
});

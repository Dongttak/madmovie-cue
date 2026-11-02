import { test, expect } from '@playwright/test';
import { createDemoFile } from '../../dist/demo.js';

test('the app offers only an original generated demo and external reference links', async ({ page }) => {
  const requests = [], errors = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('[data-sample]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cipher 듣고 분석', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Crypto 듣고 분석', exact: true })).toHaveCount(0);
  expect(requests.every(request => request.url.startsWith('http://127.0.0.1:5173/'))).toBe(true);
  await page.locator('.ncs-catalog summary').click();
  const references = page.locator('.ncs-catalog li a');
  await expect(references).toHaveCount(3);
  expect(await references.evaluateAll(links => links.every(link => link.href.startsWith('https://www.youtube.com/watch?v=') && link.target === '_blank'))).toBe(true);
  await expect(page.locator('a[href="https://broke.ffm.to/1800"]')).toBeVisible();
  await page.locator('#sample-demo').click();
  await expect(page.locator('#track-name')).toHaveText('CUE-demo-120bpm.wav');
  await expect(page.locator('#bpm')).toBeEnabled();
  expect(Number(await page.locator('#bpm').inputValue())).toBeCloseTo(120, 0);
  await expect(page.locator('#total')).toHaveText('00:24.0');
  await expect(page.locator('#empty')).toBeHidden();
  await page.locator('#play').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(.1);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.every(request => request.method === 'GET' && (request.url.startsWith('http://127.0.0.1:5173/') || request.url.startsWith('blob:')))).toBe(true);
  expect(requests.some(request => /\/samples\/|\.(mp3|m4a|ogg|flac|aac|wav)(?:[?#]|$)/i.test(request.url))).toBe(false);
  expect(errors).toEqual([]);
});

test('a local generated WAV is analyzed and played without uploading its contents', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push({ url: request.url(), method: request.method() }));
  await page.goto('/');
  const file = createDemoFile();
  await page.locator('#file').setInputFiles({ name: 'local-original.wav', mimeType: 'audio/wav', buffer: Buffer.from(await file.arrayBuffer()) });
  await expect(page.locator('#track-name')).toHaveText('local-original.wav');
  await expect(page.locator('#bpm')).toBeEnabled();
  await expect(page.locator('#bpm')).toHaveValue('120');
  await expect.poll(async () => Number(await page.locator('#onset-count').textContent())).toBeGreaterThan(0);
  await page.locator('#play').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeGreaterThan(.1);
  expect(requests.every(request => request.method === 'GET' && (request.url.startsWith('http://127.0.0.1:5173/') || request.url.startsWith('blob:')))).toBe(true);
  expect(requests.some(request => request.url.includes('local-original.wav') || request.url.includes('/samples/'))).toBe(false);
});

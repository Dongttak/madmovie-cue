import { test, expect } from '@playwright/test';
import { createDemoFile } from '../../dist/demo.js';

async function demo(page) {
  await page.goto('/#analyze');
  await page.locator('#sample-demo').click();
  await expect(page.locator('#bpm')).toBeEnabled();
}
async function setNumber(page, id, value) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press('Tab');
}

test('selection presets, keyboard movement, bounds and track replacement stay consistent', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/#analyze');
  await expect(page.locator('#clip-preview')).toBeDisabled();
  await page.locator('#sample-demo').click();
  await expect(page.locator('#bpm')).toBeEnabled();
  await expect(page.locator('#clip-end')).toHaveValue('24.000');
  expect(await page.locator('#clip-length option[value="30"]').evaluate(option => option.disabled)).toBe(true);
  await page.locator('#clip-length').selectOption('15');
  await page.locator('#clip-position').focus();
  await page.keyboard.press('End');
  await expect(page.locator('#clip-start')).toHaveValue('9.000');
  await expect(page.locator('#clip-end')).toHaveValue('24.000');
  await expect(page.locator('#clip-position')).toHaveAttribute('aria-valuetext', /부터.*까지/);
  await setNumber(page, '#clip-start', 100);
  await expect(page.locator('#clip-start')).toHaveValue('23.900');
  await setNumber(page, '#clip-end', -1);
  await expect(page.locator('#clip-end')).toHaveValue('24.000');
  const localBytes = Buffer.from(await createDemoFile().arrayBuffer()).subarray(0, 44 + 16000 * 18 * 2);
  localBytes.writeUInt32LE(localBytes.length - 8, 4);
  localBytes.writeUInt32LE(localBytes.length - 44, 40);
  await page.locator('#file').setInputFiles({ name: 'local-18s.wav', mimeType: 'audio/wav', buffer: localBytes });
  await expect(page.locator('#track-name')).toHaveText('local-18s.wav');
  await expect(page.locator('#bpm')).toBeEnabled();
  await expect(page.locator('#clip-length')).toHaveValue('custom');
  expect(await page.locator('#clip-length option[value="30"]').evaluate(option => option.disabled)).toBe(true);
  expect(Number(await page.locator('#clip-end').inputValue()) - Number(await page.locator('#clip-start').inputValue())).toBeCloseTo(18, 2);
  await expect(page.locator('#clip-suggestions button').first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('preview loops at the selected boundary, stops without loop and returns to full playback', async ({ page }) => {
  await demo(page);
  await setNumber(page, '#clip-start', 1);
  await setNumber(page, '#clip-end', 1.2);
  await page.locator('#clip-preview').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
  await page.locator('#audio').evaluate(audio => { audio.currentTime = 1.199; });
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.currentTime)).toBeLessThan(1.15);
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
  await page.locator('#clip-loop').uncheck();
  await page.locator('#clip-preview').click();
  await page.locator('#audio').evaluate(audio => { audio.currentTime = 1.199; });
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  expect(await page.locator('#audio').evaluate(audio => audio.currentTime)).toBeCloseTo(1.2, 2);
  await expect(page.locator('#clip-status')).toContainText('재생이 끝났어요');
  await page.locator('#clip-full').click();
  expect(await page.locator('#audio').evaluate(audio => audio.currentTime)).toBeLessThan(.5);
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
});

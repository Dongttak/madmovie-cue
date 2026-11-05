import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

let video;
test.beforeAll(async ({}, testInfo) => {
  video = testInfo.outputPath('local-engagement.mp4'); await mkdir(dirname(video), { recursive: true });
  await promisify(execFile)('ffmpeg', ['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24','-t','2','-c:v','libx264','-threads','1','-preset','ultrafast','-an','-y',video]);
});
const tracks = [{ id: 'invincible', artist: 'DEAF KEV', title: 'Invincible', page: 'https://ncs.io/Invincible', credit: 'DEAF KEV - Invincible [NCS Release]' }];

test('offline clip editing survives keyboard navigation and workspace switching without upload', async ({ page }) => {
  const posts = [];
  page.on('request', request => { if (request.method() === 'POST') posts.push(request.url()); });
  await page.route('**/api/ncs/catalog', route => route.fulfill({ status: 503, json: { error: 'Unavailable' } }));
  await page.goto('/');
  await expect(page.locator('#mont-upload')).toBeEnabled();
  await page.locator('#mont-files').setInputFiles(video);
  await expect(page.locator('#mont-source')).toBeVisible();
  await expect(page.locator('#mont-empty')).toBeHidden();
  await page.locator('#mont-source').evaluate(v => { v.currentTime = 1; });
  await page.locator('#mont-add-accent').click();
  await expect(page.locator('#mont-accent-time')).toHaveValue('1');
  await expect(page.locator('#mont-plan')).toBeDisabled();
  await expect(page.locator('#mont-next')).toContainText('음악을 선택하면');
  await page.locator('#tab-edit').focus(); await page.keyboard.press('ArrowDown');
  await expect(page.locator('#view-analyze')).toBeVisible();
  await expect(page.locator('#tab-analyze')).toBeFocused();
  await page.keyboard.press('End'); await expect(page.locator('#view-quick')).toBeVisible();
  await page.keyboard.press('Home'); await expect(page.locator('#view-edit')).toBeVisible();
  await expect(page.locator('#mont-accent-time')).toHaveValue('1');
  await expect(page.locator('#mont-source')).toBeVisible();
  await page.locator('#tab-analyze').click(); await page.locator('#sample-demo').click();
  await expect(page.locator('#play')).toBeEnabled(); await page.locator('#play').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(false);
  await page.locator('#tab-edit').click();
  await expect.poll(() => page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  await page.locator('h1').click(); await page.keyboard.press('Space');
  expect(await page.locator('#audio').evaluate(audio => audio.paused)).toBe(true);
  expect(posts).toEqual([]);
});

test('navigation keeps an in-flight render visible until cancellation', async ({ page }) => {
  await page.route('**/api/ncs/catalog', route => route.fulfill({ json: { tracks } }));
  await page.route('**/api/ncs/plan', route => route.fulfill({ json: { mode: 'continuity', duration: 2, segments: [{fileIndex:0, sourceStart:0, duration:2, timelineStart:0}] } }));
  let release;
  await page.route('**/api/ncs/montage', async route => { await new Promise(resolve => { release = resolve; }); await route.abort().catch(() => {}); });
  await page.goto('/'); await page.locator('#mont-files').setInputFiles(video);
  await expect(page.locator('#mont-plan')).toBeEnabled(); await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-render')).toBeEnabled(); await page.locator('#mont-render').click();
  await expect(page.locator('#mont-cancel')).toBeVisible();
  await page.locator('#tab-analyze').click(); await expect(page.locator('#view-edit')).toBeVisible();
  await expect(page.locator('.navigation-alert')).toContainText('작업');
  await expect.poll(() => typeof release).toBe('function');
  await page.locator('#mont-cancel').click(); release();
  await expect(page.locator('#mont-cancel')).toBeHidden();
  await page.locator('#tab-analyze').click(); await expect(page.locator('#view-analyze')).toBeVisible();
});

test('all workspaces fit mobile and desktop widths with no detectable WCAG A/AA violations', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  await page.route('**/api/ncs/catalog', route => route.fulfill({ json: { tracks } }));
  await page.goto('/'); await expect(page.locator('#mont-track')).toBeEnabled();
  for (const width of [360, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const key of ['edit', 'analyze', 'quick']) {
      await page.locator(`#tab-${key}`).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${key} at ${width}`).toBe(true);
    }
  }
  for (const width of [390, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  for (const key of ['edit', 'analyze', 'quick']) {
    await page.locator(`#tab-${key}`).click();
    const results = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    await testInfo.attach(`accessibility-${key}-${width}`, { body: JSON.stringify(results.violations), contentType: 'application/json' });
    expect(results.violations).toEqual([]);
  }
  }
  await page.locator('#tab-edit').click();
  await page.locator('#mont-files').setInputFiles(video);
  await expect(page.locator('#mont-source')).toBeVisible();
  await page.locator('#mont-source').evaluate(video => { video.currentTime = 1; });
  await page.locator('#mont-add-accent').click();
  const editing = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  expect(editing.violations).toEqual([]);
});

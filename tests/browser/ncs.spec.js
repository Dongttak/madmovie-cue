import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const run = promisify(execFile);
const tracks = [
  { id: 'invincible', title: 'Invincible', artist: 'DEAF KEV', page: 'https://ncs.io/invincible', credit: 'DEAF KEV — Invincible [NCS Release]\nhttps://ncs.io/invincible' },
  { id: 'blank', title: 'Blank', artist: 'Disfigure', page: 'https://ncs.io/blank', credit: 'Disfigure — Blank [NCS Release]\nhttps://ncs.io/blank' },
  { id: 'symbolism', title: 'Symbolism', artist: 'Electro-Light', page: 'https://ncs.io/symbolism', credit: 'Electro-Light — Symbolism [NCS Release]\nhttps://ncs.io/symbolism' },
];
let originalVideo, combinedBytes;

test.beforeAll(async ({}, testInfo) => {
  originalVideo = testInfo.outputPath('original-game.mp4');
  const combined = testInfo.outputPath('mock-combined.mp4');
  await mkdir(dirname(originalVideo), { recursive: true });
  await Promise.all([
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', originalVideo]),
    run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', combined]),
  ]);
  combinedBytes = await readFile(combined);
});

async function openNcs(page) {
  await page.goto('/#quick');
}

test('catalog selection uploads only the local video and downloads a combined MP4', async ({ page }) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => requests.push(request));
  await page.route('**/api/ncs/catalog', route => route.fulfill({ json: { tracks } }));
  let renderRequest;
  await page.route('**/api/ncs/render?**', async route => {
    renderRequest = route.request();
    await route.fulfill({ contentType: 'video/mp4', body: combinedBytes });
  });
  await openNcs(page);
  await expect(page.locator('#ncs-track option')).toHaveCount(3);
  await page.locator('#ncs-track').selectOption('blank');
  await expect(page.locator('#ncs-credit')).toHaveValue(tracks[1].credit);
  await expect(page.locator('#ncs-download')).toBeHidden();
  await page.locator('#ncs-file').setInputFiles(originalVideo);
  await page.locator('#ncs-music-start').fill('7.5');
  await page.locator('#ncs-video-start').fill('0.5');
  await page.locator('#ncs-length').selectOption('15');
  await page.locator('#ncs-render').click();
  await expect(page.locator('#ncs-download')).toBeVisible();
  expect(renderRequest.method()).toBe('POST');
  expect(Object.fromEntries(new URL(renderRequest.url()).searchParams)).toEqual({ track: 'blank', musicStart: '7.5', length: '15', videoStart: '0.5' });
  expect(renderRequest.postDataBuffer()).toEqual(await readFile(originalVideo));
  expect(renderRequest.headers()['content-type']).toBe('application/octet-stream');
  const downloading = page.waitForEvent('download');
  await page.locator('#ncs-download').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('CUE-blank-shorts.mp4');
  expect(await readFile(await download.path())).toEqual(combinedBytes);
  await expect(page.locator('#ncs-result')).toHaveAttribute('src', /^blob:/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(requests.every(request => request.url().startsWith('http://127.0.0.1:5173/') || request.url().startsWith('blob:'))).toBe(true);
  expect(requests.some(request => /\.(mp3|m4a|wav|ogg|flac|aac)(?:[?#]|$)/i.test(request.url()))).toBe(false);
  expect(errors).toEqual([]);
});

test('catalog retry, upstream failure and cancellation keep the form usable', async ({ page }) => {
  let catalogAvailable = false;
  await page.route('**/api/ncs/catalog', route => route.fulfill(catalogAvailable ? { json: { tracks } } : { status: 503, json: { error: 'Unavailable' } }));
  let mode = 'error', release;
  await page.route('**/api/ncs/render?**', async route => {
    if (mode === 'error') return route.fulfill({ status: 502, json: { error: '공식 음원에 연결하지 못했어요.' } });
    if (mode === 'wait') await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ contentType: 'video/mp4', body: combinedBytes }); } catch {}
  });
  await openNcs(page);
  await expect(page.locator('#ncs-status')).toContainText('서버에 연결하지 못했어요');
  await expect(page.locator('#ncs-render')).toBeDisabled();
  catalogAvailable = true;
  await page.locator('#ncs-retry').click();
  await expect(page.locator('#ncs-track')).toBeEnabled();
  await page.locator('#ncs-file').setInputFiles(originalVideo);
  await page.locator('#ncs-render').click();
  await expect(page.locator('#ncs-status')).toContainText('공식 음원에 연결하지 못했어요');
  await expect(page.locator('#ncs-render')).toBeEnabled();
  mode = 'wait';
  await page.locator('#ncs-render').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await page.locator('#ncs-cancel').click();
  await expect(page.locator('#ncs-status')).toContainText('취소했어요');
  await expect(page.locator('#ncs-render')).toBeEnabled();
  await expect(page.locator('#ncs-download')).toBeHidden();
  release();
  mode = 'success';
  await page.locator('#ncs-render').click();
  await expect(page.locator('#ncs-download')).toBeVisible();
});

test('a large catalog searches titles, artists and Korean genres without losing selection state', async ({ page }) => {
  const catalog = [...tracks, ...Array.from({ length: 57 }, (_, index) => {
    const number = index + 4;
    return { id: `test-${number}`, title: `Signal ${number}`, artist: `Artist ${number}`, genre: 'Electronic', page: `https://ncs.io/Test${number}`, credit: `Artist ${number} — Signal ${number}\nMusic provided by NoCopyrightSounds.` };
  })];
  catalog[59] = { id: 'korean-test', title: '별빛 질주', artist: '밤 하늘', genre: '드럼 앤 베이스', page: 'https://ncs.io/KoreanTest', credit: '밤 하늘 — 별빛 질주\nMusic provided by NoCopyrightSounds.' };
  await page.route('**/api/ncs/catalog', route => route.fulfill({ json: { tracks: catalog } }));
  let release, renderedTrack;
  await page.route('**/api/ncs/render?**', async route => {
    renderedTrack = new URL(route.request().url()).searchParams.get('track');
    await new Promise(resolve => { release = resolve; });
    await route.fulfill({ contentType: 'video/mp4', body: combinedBytes });
  });
  await openNcs(page);
  await expect(page.locator('#ncs-track option')).toHaveCount(60);
  await expect(page.locator('#ncs-count')).toContainText('전체 60곡');
  await page.locator('#ncs-search').fill('  별빛  ');
  await expect(page.locator('#ncs-track option')).toHaveCount(1);
  await expect(page.locator('#ncs-track')).toHaveValue('korean-test');
  await expect(page.locator('#ncs-credit')).toHaveValue(catalog[59].credit);
  await page.locator('#ncs-search').fill('드럼 앤 베이스');
  await expect(page.locator('#ncs-track option')).toHaveCount(1);
  await expect(page.locator('#ncs-track')).toHaveValue('korean-test');
  await page.locator('#ncs-search').fill('no matching song at all');
  await expect(page.locator('#ncs-track')).toHaveValue('');
  await expect(page.locator('#ncs-track')).toBeDisabled();
  await expect(page.locator('#ncs-count')).toContainText('검색 0곡');
  await expect(page.locator('#ncs-credit')).toHaveValue('');
  await expect(page.locator('#ncs-render')).toBeDisabled();
  await page.locator('#ncs-search').fill('   ');
  await expect(page.locator('#ncs-track option')).toHaveCount(60);
  await page.locator('#ncs-search').fill('  aRTisT 41  ');
  await expect(page.locator('#ncs-track option')).toHaveCount(1);
  await expect(page.locator('#ncs-track')).toHaveValue('test-41');
  await expect(page.locator('#ncs-credit')).toHaveValue(catalog.find(track => track.id === 'test-41').credit);
  await page.locator('#ncs-file').setInputFiles(originalVideo);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#ncs-render').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  expect(renderedTrack).toBe('test-41');
  await expect(page.locator('#ncs-search')).toBeDisabled();
  await expect(page.locator('#ncs-track')).toBeDisabled();
  release();
  await expect(page.locator('#ncs-download')).toBeVisible();
  await expect(page.locator('#ncs-search')).toBeEnabled();
  await page.locator('#ncs-search').fill('별빛');
  await expect(page.locator('#ncs-track')).toHaveValue('korean-test');
  await expect(page.locator('#ncs-credit')).toHaveValue(catalog[59].credit);
  await expect(page.locator('#ncs-download')).toBeHidden();
});

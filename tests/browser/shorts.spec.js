import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const run = promisify(execFile);
let originalVideo;

test.beforeAll(async ({}, testInfo) => {
  originalVideo = testInfo.outputPath('original-game.mp4');
  await mkdir(dirname(originalVideo), { recursive: true });
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', '-y', originalVideo]);
});

async function prepare(page) {
  await page.goto('/#analyze');
  await expect(page.locator('#clip-save')).toHaveCount(0);
  await expect(page.locator('#shorts-download')).toBeHidden();
  await page.locator('#sample-demo').click();
  await expect(page.locator('#bpm')).toBeEnabled();
  for (const [id, value] of [['#clip-start', '2'], ['#clip-end', '4.25']]) {
    await page.locator(id).fill(value);
    await page.locator(id).press('Tab');
  }
  await page.locator('#shorts-file').setInputFiles(originalVideo);
  await expect(page.locator('#shorts-render')).toBeEnabled();
  await page.locator('#shorts-start').fill('0.5');
  await page.locator('#shorts-start').press('Tab');
}

test('a local game clip and music produce a vertical video download with audible music', async ({ page }) => {
  const requests = [], errors = [];
  page.on('request', request => requests.push({ method: request.method(), url: request.url() }));
  page.on('pageerror', error => errors.push(error.message));
  await prepare(page);
  await page.locator('#shorts-render').click();
  await expect(page.locator('#shorts-download')).toBeVisible({ timeout: 15000 });
  const downloading = page.waitForEvent('download');
  await page.locator('#shorts-download').click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.(webm|mp4)$/);
  const output = await download.path();
  expect((await readFile(output)).length).toBeGreaterThan(1000);
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height', '-show_entries', 'format=duration', '-of', 'json', output]);
  const metadata = JSON.parse(stdout);
  const videos = metadata.streams.filter(stream => stream.codec_type === 'video');
  const audios = metadata.streams.filter(stream => stream.codec_type === 'audio');
  expect(videos).toHaveLength(1);
  expect(audios).toHaveLength(1);
  expect([videos[0].width, videos[0].height]).toEqual([720, 1280]);
  expect(Math.abs(Number(metadata.format.duration) - 2.25)).toBeLessThan(.4);
  const { stdout: pcm } = await run('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 'f32le', '-ac', '1', '-ar', '8000', 'pipe:1'], { encoding: 'buffer' });
  let energy = 0;
  for (let offset = 0; offset < pcm.length; offset += 4) energy += pcm.readFloatLE(offset) ** 2;
  expect(Math.sqrt(energy / (pcm.length / 4))).toBeGreaterThan(.001);
  expect(requests.every(request => request.method === 'GET' && (request.url.startsWith('http://127.0.0.1:5173/') || request.url.startsWith('blob:')))).toBe(true);
  expect(requests.some(request => /\/samples\/|\.(mp3|m4a|wav|ogg|flac|aac)(?:[?#]|$)/i.test(request.url))).toBe(false);
  expect(errors).toEqual([]);
});

test('a render can be cancelled and restarted on a narrow screen', async ({ page }) => {
  await prepare(page);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#shorts-render').click();
  await expect(page.locator('#shorts-cancel')).toBeEnabled();
  await page.locator('#shorts-cancel').click();
  await expect(page.locator('#shorts-render')).toBeEnabled();
  await expect(page.locator('#shorts-download')).toBeHidden();
  await page.locator('#shorts-render').click();
  await expect(page.locator('#shorts-download')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('#shorts-result')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('#shorts-render')).toBeEnabled();
});

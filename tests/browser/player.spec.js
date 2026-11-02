import { test, expect } from '@playwright/test';
function wav(samples = 8000 * 12) {
  const rate = 8000;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 2 * 440) * 12000), 44 + i * 2);
  return { name: '테스트 음원.wav', mimeType: 'audio/wav', buffer };
}
test('load, play, seek, keyboard, replace, invalid-file recovery and mobile layout', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#play')).toBeDisabled();
  await page.locator('#file').setInputFiles(wav());
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#total')).toHaveText('00:12.0');
  await expect(page.locator('#empty')).toBeHidden();
  await page.locator('#play').click();
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeGreaterThan(.1);
  await page.locator('#play').click();
  const box = await page.locator('#seek').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeCloseTo(6, 0);
  await page.locator('#forward').click();
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeCloseTo(11, 0);
  await page.locator('h1').click();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeCloseTo(6, 0);
  await page.keyboard.press('Space');
  await expect(page.locator('#play')).toHaveText('일시정지');
  await page.keyboard.press('Space');
  await expect(page.locator('#play')).toHaveText('재생');
  await page.locator('#file').setInputFiles({ name: 'broken.wav', mimeType: 'audio/wav', buffer: Buffer.from('not audio') });
  await expect(page.locator('#status')).toHaveClass('error');
  await expect(page.locator('#play')).toBeDisabled();
  await page.locator('#file').setInputFiles(wav());
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#status')).not.toHaveClass('error');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('a finished track resets the play label when seeking or loading another file', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles(wav());
  await expect(page.locator('#play')).toBeEnabled();
  await page.locator('#audio').evaluate(async (audio) => {
    await audio.play();
    audio.currentTime = audio.duration - .05;
  });
  await expect(page.locator('#play')).toHaveText('다시 재생');
  await page.locator('#back').click();
  await expect(page.locator('#play')).toHaveText('재생');
  await page.locator('#audio').evaluate(async (audio) => {
    await audio.play();
    audio.currentTime = audio.duration - .05;
  });
  await expect(page.locator('#play')).toHaveText('다시 재생');
  await page.locator('#file').setInputFiles(wav());
  await expect(page.locator('#play')).toBeEnabled();
  await expect(page.locator('#play')).toHaveText('재생');
});

test('rhythm analysis, manual grid correction and candidate audition', async ({ page }) => {
  const { clickTrack } = await import('../fixtures/rhythm.js');
  const { samples } = clickTrack(120, 18);
  const track = wav();
  track.buffer = Buffer.alloc(44 + samples.length * 2);
  const header = wav().buffer.subarray(0, 44);
  header.copy(track.buffer);
  track.buffer.writeUInt32LE(track.buffer.length - 8, 4);
  track.buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) track.buffer.writeInt16LE(Math.round(samples[i] * 32767), 44 + i * 2);
  track.name = '120bpm.wav';
  const requests = [];
  page.on('request', r => requests.push({ method: r.method(), url: r.url() }));
  await page.goto('/');
  await page.locator('#file').setInputFiles(track);
  await expect(page.locator('#bpm')).toBeEnabled();
  await expect.poll(async () => Math.abs(Number(await page.locator('#bpm').inputValue()) - 120)).toBeLessThan(1);
  await expect(page.locator('.onset-button')).toHaveCount(36);
  await page.locator('.onset-button').nth(3).click();
  await expect.poll(() => page.locator('#audio').evaluate(a => a.currentTime)).toBeCloseTo(1.73, 1);
  await page.locator('#bpm').fill('100');
  await page.locator('#offset').fill('0.5');
  await page.locator('#apply-beats').click();
  await expect(page.locator('#analysis-status')).toContainText('수동 보정: 100 BPM');
  await expect(page.locator('#analysis-summary')).toContainText('30개 박자');
  await page.locator('#use-position').click();
  expect(Number(await page.locator('#offset').inputValue())).toBeCloseTo(1.73, 1);
  await page.locator('#reset-beats').click();
  await expect(page.locator('#analysis-status')).toContainText('자동 추정');
  await page.locator('#show-beats').uncheck();
  await page.locator('#show-onsets').uncheck();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#file').setInputFiles(wav());
  await expect(page.locator('#bpm')).toBeEnabled();
  await expect(page.locator('#bpm')).toHaveValue('');
  await expect(page.locator('#reset-beats')).toBeDisabled();
  await expect(page.locator('#analysis-status')).toContainText('추정하기 어려워요');
  expect(requests.every(r => r.method === 'GET')).toBe(true);
  expect(requests.every(r => r.url.startsWith('http://127.0.0.1:5173/') || r.url.startsWith('blob:'))).toBe(true);
});


test('using the end of a fractional-length track keeps the first-beat form valid', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles(wav(80005));
  await expect(page.locator('#bpm')).toBeEnabled();
  await page.locator('#bpm').fill('120');
  await page.locator('#audio').evaluate(audio => { audio.currentTime = audio.duration; });
  await page.locator('#use-position').click();
  expect(await page.locator('#beat-form').evaluate(form => form.checkValidity())).toBe(true);
  await page.locator('#apply-beats').click();
  await expect(page.locator('#analysis-status')).toContainText('수동 보정: 120 BPM');
});

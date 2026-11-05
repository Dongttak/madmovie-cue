import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const run = promisify(execFile);
const tracks = [
  { id: 'invincible', title: 'Invincible', artist: 'DEAF KEV', genre: 'Dubstep', page: 'https://ncs.io/Invincible', credit: 'DEAF KEV — Invincible\nMusic provided by NoCopyrightSounds.' },
  { id: 'blank', title: 'Blank', artist: 'Disfigure', genre: 'Electronic', page: 'https://ncs.io/Blank', credit: 'Disfigure — Blank\nMusic provided by NoCopyrightSounds.' },
];
let videos, combinedBytes;

test.beforeAll(async ({}, testInfo) => {
  const directory = dirname(testInfo.outputPath('red.mp4'));
  await mkdir(directory, { recursive: true });
  videos = await Promise.all(['red', 'green', 'blue'].map(async color => {
    const path = testInfo.outputPath(`${color}.mp4`);
    await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:size=320x180:rate=24`, '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-y', path]);
    return { name: `${color}.mp4`, mimeType: 'video/mp4', buffer: await readFile(path) };
  }));
  const output = testInfo.outputPath('mock-montage.mp4');
  await run('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:size=720x1280:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', output]);
  combinedBytes = await readFile(output);
});

function makePlan(input, uniform = false) {
  return { bpm: uniform ? null : input.bpm || 120, offset: input.offset || 0, mode: uniform ? 'uniform' : 'beats', duration: input.clips.length, segments: input.clips.map((clip, index) => ({ fileIndex: index, sourceStart: clip.start, duration: 1, timelineStart: index })), ...(uniform ? { warning: '규칙적인 박자를 추정하지 못해 균등하게 나눴어요.' } : {}) };
}
async function catalog(page, mode = 'beats') {
  await page.route('**/api/ncs/catalog', route => route.fulfill({ json: { tracks } }));
  await page.goto('/');
  await expect(page.locator('#mont-track')).toBeEnabled();
  await expect(page.locator('#mont-mode')).toHaveValue('continuity');
  await page.locator('#mont-mode').selectOption(mode);
}
async function number(page, id, value) {
  await page.locator(id).fill(String(value));
  await page.locator(id).press('Tab');
}

test('clip reordering and source starts survive plan preview, JSON export and the binary render request', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let planInput, resultPlan, renderBody;
  await page.route('**/api/ncs/plan', route => {
    planInput = route.request().postDataJSON();
    resultPlan = makePlan(planInput);
    return route.fulfill({ json: resultPlan });
  });
  await page.route('**/api/ncs/montage', async route => {
    renderBody = route.request().postDataBuffer();
    await route.fulfill({ contentType: 'video/mp4', body: combinedBytes });
  });
  await catalog(page);
  await expect(page.locator('#mont-plan')).toBeDisabled();
  await page.locator('#mont-track').selectOption('blank');
  await expect(page.locator('#mont-credit')).toHaveValue(tracks[1].credit);
  await page.getByText('배치 상세 보기', { exact: true }).click();
  await page.locator('#mont-files').setInputFiles(videos);
  await expect(page.locator('#mont-clips li')).toHaveCount(3);
  await page.getByRole('button', { name: '클립 3 위로', exact: true }).click();
  await page.getByRole('button', { name: '클립 2 위로', exact: true }).click();
  await page.getByRole('button', { name: '클립 3 삭제', exact: true }).click();
  await expect(page.locator('#mont-clips li')).toHaveCount(2);
  await page.locator('#mont-files').setInputFiles(videos[1]);
  await expect(page.locator('#mont-clips li')).toHaveCount(3);
  expect(await page.locator('#mont-clips li strong').allTextContents()).toEqual(['1. blue.mp4', '2. red.mp4', '3. green.mp4']);
  await page.getByRole('spinbutton', { name: '클립 2 시작 (초)', exact: true }).fill('0.5');
  await page.getByRole('spinbutton', { name: '클립 2 시작 (초)', exact: true }).press('Tab');
  await number(page, '#mont-music-start', 10);
  await page.locator('#mont-length').selectOption('15');
  await number(page, '#mont-bpm', 120);
  await number(page, '#mont-offset', .25);
  await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-plan-rows tr')).toHaveCount(3);
  expect(planInput).toEqual({ track: 'blank', musicStart: 10, length: 15, bpm: 120, offset: .25, mode: 'beats', layout: 'wide', fps: 60, gameAudio: true, clips: [{ duration: 3, start: 0, end: 3 }, { duration: 3, start: .5, end: 3 }, { duration: 3, start: 0, end: 3 }] });
  expect(await page.locator('#mont-plan-rows tr td:first-child').allTextContents()).toEqual(['blue.mp4', 'red.mp4', 'green.mp4']);
  await expect(page.locator('#mont-summary')).toContainText('박자 기준 배치');
  const jsonDownloading = page.waitForEvent('download');
  await page.locator('#mont-json').click();
  const jsonDownload = await jsonDownloading;
  expect(jsonDownload.suggestedFilename()).toBe('CUE-cut-plan.json');
  const exported = JSON.parse(await readFile(await jsonDownload.path(), 'utf8'));
  expect(exported.music).toEqual({ track: 'blank', start: 10 });
  expect(exported.clips.map(clip => clip.name)).toEqual(['blue.mp4', 'red.mp4', 'green.mp4']);
  expect(exported.segments).toEqual(resultPlan.segments);
  await page.locator('#mont-render').click();
  await expect(page.locator('#mont-download')).toBeVisible();
  const jsonLength = renderBody.readUInt32BE(0);
  const manifest = JSON.parse(renderBody.subarray(4, 4 + jsonLength).toString('utf8'));
  expect(manifest.track).toBe('blank');
  expect(manifest.musicStart).toBe(10);
  expect(manifest.segments).toEqual(resultPlan.segments);
  let cursor = 4 + jsonLength;
  for (const [index, file] of [videos[2], videos[0], videos[1]].entries()) {
    expect(manifest.files[index].size).toBe(file.buffer.length);
    expect(renderBody.subarray(cursor, cursor + file.buffer.length)).toEqual(file.buffer);
    cursor += file.buffer.length;
  }
  expect(cursor).toBe(renderBody.length);
  const downloading = page.waitForEvent('download');
  await page.locator('#mont-download').click();
  expect(await readFile(await (await downloading).path())).toEqual(combinedBytes);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('spinbutton', { name: '클립 1 시작 (초)', exact: true }).fill('0.2');
  await page.getByRole('spinbutton', { name: '클립 1 시작 (초)', exact: true }).press('Tab');
  await expect(page.locator('#mont-render')).toBeDisabled();
  await expect(page.locator('#mont-plan-rows tr')).toHaveCount(0);
  await expect(page.locator('#mont-download')).toBeHidden();
  expect(errors).toEqual([]);
});

test('clip limits, empty searches, plan errors and cancellation allow recovery with honest fallback status', async ({ page }) => {
  let mode = 'error', release;
  await page.route('**/api/ncs/plan', async route => {
    if (mode === 'error') return route.fulfill({ status: 502, json: { error: '음악 분석에 연결하지 못했어요.' } });
    if (mode === 'wait') await new Promise(resolve => { release = resolve; });
    try { await route.fulfill({ json: makePlan(route.request().postDataJSON(), true) }); } catch {}
  });
  await catalog(page);
  await page.locator('#mont-files').setInputFiles(videos[0]);
  await expect(page.locator('#mont-clips li')).toHaveCount(1);
  await expect(page.locator('#mont-plan')).toBeDisabled();
  await page.locator('#mont-files').setInputFiles(Array.from({ length: 8 }, (_, index) => ({ ...videos[1], name: `extra-${index}.mp4` })));
  await expect(page.locator('#mont-status')).toContainText('최대 8개');
  await expect(page.locator('#mont-clips li')).toHaveCount(1);
  await page.locator('#mont-files').setInputFiles(videos[1]);
  await expect(page.locator('#mont-clips li')).toHaveCount(2);
  await page.getByRole('spinbutton', { name: '클립 1 시작 (초)', exact: true }).fill('100');
  await page.getByRole('spinbutton', { name: '클립 1 시작 (초)', exact: true }).press('Tab');
  await expect(page.getByRole('spinbutton', { name: '클립 1 시작 (초)', exact: true })).toHaveValue('0');
  await page.locator('#mont-search').fill('no matching track');
  await expect(page.locator('#mont-track')).toHaveValue('');
  await expect(page.locator('#mont-plan')).toBeDisabled();
  await page.locator('#mont-search').fill('');
  await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-status')).toContainText('음악 분석에 연결하지 못했어요.');
  await expect(page.locator('#mont-plan')).toBeEnabled();
  mode = 'wait';
  await page.locator('#mont-plan').click();
  await expect.poll(() => Boolean(release)).toBe(true);
  await expect(page.locator('#mont-files')).toBeDisabled();
  await expect(page.locator('#mont-search')).toBeDisabled();
  await expect(page.getByRole('button', { name: '클립 1 삭제', exact: true })).toBeDisabled();
  await page.locator('#mont-cancel').click();
  await expect(page.locator('#mont-status')).toContainText('취소했어요');
  await expect(page.locator('#mont-plan')).toBeEnabled();
  release(); mode = 'success';
  await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-plan-rows tr')).toHaveCount(2);
  await expect(page.locator('#mont-summary')).toContainText('균등 분할 배치');
  await expect(page.locator('#mont-status')).toContainText('규칙적인 박자를 추정하지 못해');
  await expect(page.locator('#mont-render')).toBeEnabled();
});


test('one intact engagement is the default and preview positions become range boundaries', async ({ page }) => {
  let input, manifest;
  await page.route('**/api/ncs/plan', route => {
    input = route.request().postDataJSON();
    const duration=input.clips[0].end-input.clips[0].start;
    return route.fulfill({json:{...input,bpm:null,offset:0,duration,segments:[{fileIndex:0,sourceStart:input.clips[0].start,duration,timelineStart:0}]}});
  });
  await page.route('**/api/ncs/montage', route => {
    const body=route.request().postDataBuffer(), length=body.readUInt32BE(0);
    manifest=JSON.parse(body.subarray(4,4+length).toString('utf8'));
    return route.fulfill({contentType:'video/mp4',body:combinedBytes});
  });
  await catalog(page,'continuity');
  const fonts=await page.evaluate(async()=>{const faces=await document.fonts.load('16px Pretendard','교전 영상');return faces.map(face=>face.status);});
  expect(fonts).toContain('loaded');
  await expect(page.locator('#mont-beat-settings')).toBeHidden();
  await page.locator('#mont-files').setInputFiles(videos[0]);
  await expect(page.locator('#mont-plan')).toBeEnabled();
  await page.getByRole('button',{name:'클립 1 미리보기',exact:true}).click();
  await expect(page.locator('#mont-source')).toBeVisible();
  await page.locator('#mont-source').evaluate(video=>{video.currentTime=.5;});
  await expect.poll(()=>page.locator('#mont-source').evaluate(v=>v.currentTime)).toBeCloseTo(.5,1);
  await page.locator('#mont-set-start').click();
  await page.locator('#mont-source').evaluate(video=>{video.currentTime=2.5;});
  await expect.poll(()=>page.locator('#mont-source').evaluate(v=>v.currentTime)).toBeCloseTo(2.5,1);
  await page.locator('#mont-set-end').click();
  await expect(page.getByRole('spinbutton',{name:'클립 1 시작 (초)',exact:true})).toHaveValue('0.5');
  await expect(page.getByRole('spinbutton',{name:'클립 1 끝 (초)',exact:true})).toHaveValue('2.5');
  await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-summary')).toContainText('2.00초 · 1클립 · 교전 구간 전체 유지 · 60fps · 와이드');
  expect(input.clips).toEqual([{duration:3,start:.5,end:2.5}]);
  expect(input.mode).toBe('continuity');
  await page.locator('#mont-render').click();
  await expect(page.locator('#mont-download')).toBeVisible();
  expect(manifest).toMatchObject({mode:'continuity',layout:'wide',fps:60,gameAudio:true,segments:[{fileIndex:0,sourceStart:.5,duration:2,timelineStart:0}]});
  await page.locator('#mont-layout').selectOption('landscape');
  await expect(page.locator('#mont-download')).toBeHidden();
  await expect(page.locator('#mont-render')).toBeDisabled();
});

test('one selected accent survives planning and basic/accent renders remain available for comparison', async ({ page }) => {
  const manifests = []; let input;
  await page.route('**/api/ncs/plan', route => {
    input = route.request().postDataJSON();
    const clip = input.clips[0], accent = clip.accent;
    return route.fulfill({ json: { mode: 'continuity', fps: 60, duration: 3.3,
      waveform: { duration: 30, peaks: Array(1200).fill(.5) },
      segments: [{ fileIndex: 0, sourceStart: 0, sourceDuration: 3, duration: 3.3, timelineStart: 0, accent }] } });
  });
  await page.route('**/api/ncs/montage', route => {
    const body = route.request().postDataBuffer(), length = body.readUInt32BE(0);
    manifests.push(JSON.parse(body.subarray(4,4+length).toString()));
    return route.fulfill({ contentType: 'video/mp4', body: combinedBytes });
  });
  await catalog(page, 'continuity');
  await page.locator('#mont-files').setInputFiles(videos[0]);
  await page.getByRole('button', { name: '클립 1 미리보기', exact: true }).click();
  await expect.poll(() => page.locator('#mont-source').evaluate(video => video.readyState >= 1)).toBe(true);
  await page.locator('#mont-source').evaluate(video => { video.currentTime = 1.5; });
  await page.locator('#mont-accent-kind').selectOption('slow');
  await page.locator('#mont-add-accent').click();
  await expect(page.locator('#mont-accent-time')).toHaveValue('1.5');
  await expect(page.locator('#mont-seek')).toHaveAttribute('max','3.3');
  await page.locator('#mont-plan').click();
  await expect(page.locator('#mont-render-base')).toBeEnabled();
  const timelineBox = await page.locator('#mont-timeline').boundingBox();
  const wrapperBox = await page.locator('#mont-timeline-wrap').boundingBox();
  expect(timelineBox.y).toBeGreaterThan(wrapperBox.y);
  expect(timelineBox.y + timelineBox.height).toBeLessThan(wrapperBox.y + wrapperBox.height);
  expect(input.clips[0].accent).toEqual({ time: 1.5, kind: 'slow' });
  await page.locator('#mont-render-base').click();
  await expect(page.locator('#mont-download')).toBeVisible();
  await expect(page.locator('#mont-render')).toBeEnabled();
  await page.locator('#mont-render').click();
  await expect(page.locator('#mont-compare option:not(:disabled)')).toHaveCount(2);
  expect(manifests[0].segments[0]).toEqual({ fileIndex: 0, sourceStart: 0, duration: 3, timelineStart: 0 });
  expect(manifests[1].segments[0].accent).toEqual({ time: 1.5, kind: 'slow' });
  await page.locator('#mont-compare').selectOption('base');
  await expect(page.locator('#mont-download')).toHaveAttribute('download',/baseline/);
  await page.locator('#mont-compare').selectOption('accent');
  await expect(page.locator('#mont-download')).toHaveAttribute('download',/montage/);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator('#mont-remove-accent').click();
  await expect(page.locator('#mont-accent-time')).toHaveValue('');
  await expect(page.locator('#mont-render')).toBeDisabled();
  await expect(page.locator('#mont-compare-label')).toBeHidden();
});

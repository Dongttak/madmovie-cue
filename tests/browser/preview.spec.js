import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
let video;
test.beforeAll(async ({}, info) => {
 video=info.outputPath('preview-source.mp4');await mkdir(dirname(video),{recursive:true});
 await promisify(execFile)('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=160x90:rate=24','-t','1','-c:v','libx264','-threads','1','-preset','ultrafast','-an','-y',video]);
});
const tracks=[{id:'invincible',artist:'DEAF KEV',title:'Invincible',page:'https://ncs.io/Invincible',credit:'NCS',youtubeId:'AbCdEf012_-'},
 {id:'blank',artist:'Disfigure',title:'Blank',page:'https://ncs.io/Blank',credit:'NCS'},
 {id:'invalid',artist:'Fixture',title:'Unsupported',page:'https://ncs.io/Fixture',credit:'NCS',youtubeId:'../../unsafe'}];

async function setup(page) {
 const external=[];
 await page.route('**/api/ncs/catalog',route=>route.fulfill({json:{tracks}}));
 await page.route('https://www.youtube-nocookie.com/embed/**',route=>{
  external.push({url:route.request().url(),referer:route.request().headers().referer});
  return route.fulfill({contentType:'text/html',body:'<html><head><title>Player fixture</title></head><body><p>Official player test fixture</p></body></html>'});
 });
 await page.goto('/');await expect(page.locator('#mont-preview-open')).toBeEnabled();return external;
}

test('official preview loads only on click, sends origin referrer and uses the requested start',async({page})=>{
 const external=await setup(page);expect(external).toEqual([]);
 await page.locator('#mont-files').setInputFiles(video);await expect(page.locator('#mont-source')).toBeVisible();
 await page.locator('#mont-music-start').fill('12.9');await page.locator('#mont-music-start').press('Tab');
 await page.locator('#mont-preview-open').click();
 const frame=page.locator('#mont-preview-player iframe');await expect(frame).toBeVisible();
 await expect.poll(()=>external.length).toBe(1);
 const url=new URL(external[0].url);
 expect(url.origin).toBe('https://www.youtube-nocookie.com');expect(url.pathname).toBe('/embed/AbCdEf012_-');
 expect(url.searchParams.get('start')).toBe('12');expect(external[0].referer).toBe('http://127.0.0.1:5173/');
 const box=await frame.boundingBox();expect(box.width).toBeGreaterThanOrEqual(200);expect(box.height).toBeGreaterThanOrEqual(200);
 await page.locator('#mont-source').evaluate(v=>v.play());await expect(frame).toHaveCount(0);
 await page.locator('#mont-preview-open').click();await expect(frame).toBeVisible();
 await page.locator('#mont-preview-close').click();await expect(frame).toHaveCount(0);
 await page.locator('#mont-preview-open').click();await expect(frame).toBeVisible();
 await page.locator('#mont-music-start').fill('20');await page.locator('#mont-music-start').press('Tab');await expect(frame).toHaveCount(0);
});

test('changing song or workspace unloads playback and unsupported IDs never embed',async({page})=>{
 await setup(page);await page.locator('#mont-preview-open').click();await expect(page.locator('iframe')).toHaveCount(1);
 await page.locator('#mont-track').selectOption('blank');await expect(page.locator('iframe')).toHaveCount(0);
 await expect(page.locator('#mont-preview-open')).toBeDisabled();await expect(page.locator('#mont-preview-note')).toContainText('공식 페이지');
 await page.locator('#mont-track').selectOption('invalid');await expect(page.locator('#mont-preview-open')).toBeDisabled();
 await page.locator('#mont-track').selectOption('invincible');await page.locator('#mont-preview-open').click();
 await page.locator('#tab-quick').click();await expect(page.locator('iframe')).toHaveCount(0);
 await page.locator('#ncs-preview-open').click();await expect(page.locator('#ncs-preview-player iframe')).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#tab-edit').click();await expect(page.locator('iframe')).toHaveCount(0);
});

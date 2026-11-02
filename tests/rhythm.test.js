import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRhythm, beatGrid } from '../dist/rhythm.js';
import { clickTrack } from './fixtures/rhythm.js';

for (const bpm of [90, 120, 150]) {
  test(`${bpm} BPM: estimates tempo and aligns transients and beat grid`, async () => {
    const { buffer, hits } = clickTrack(bpm);
    const result = await analyzeRhythm(buffer);
    assert.ok(Math.abs(result.bpm - bpm) < 1, `got ${result.bpm}`);
    assert.equal(result.onsets.length, hits.length);
    for (const hit of hits) assert.ok(result.onsets.some(o => Math.abs(o.time - hit) <= .02));
    const beats = beatGrid(buffer.duration, result.bpm, result.offset);
    for (const hit of hits) assert.ok(beats.some(t => Math.abs(t - hit) < .035), `missed ${hit}`);
  });
}
test('silence and sustained tone do not produce a confident tempo', async () => {
  const { buffer, samples } = clickTrack();
  samples.fill(0);
  assert.deepEqual(await analyzeRhythm(buffer), { bpm: null, offset: 0, regularity: 0, onsets: [] });
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(2 * Math.PI * 440 * i / buffer.sampleRate) * .5;
  assert.equal((await analyzeRhythm(buffer)).bpm, null);
});
test('anti-phase stereo keeps transients and cancellation returns no stale analysis', async () => {
  const { buffer, samples, hits } = clickTrack();
  const inverse = samples.map(v => -v);
  buffer.numberOfChannels = 2;
  buffer.getChannelData = (i) => i === 0 ? samples : inverse;
  const result = await analyzeRhythm(buffer);
  assert.ok(Math.abs(result.bpm - 120) < 1);
  assert.equal(result.onsets.length, hits.length);
  assert.equal(await analyzeRhythm(buffer, () => true), null);
});
test('manual grid uses BPM and offset, rejecting invalid values and keeping times in bounds', () => {
  assert.deepEqual(beatGrid(2, 120, .25), [.25, .75, 1.25, 1.75]);
  for (const [bpm, offset] of [[0, 0], [Infinity, 0], [301, 0], [120, -1], [120, 2], [120, NaN]]) {
    assert.deepEqual(beatGrid(2, bpm, offset), []);
  }
});

test('a three-minute 123 BPM song keeps the grid aligned through the end', async () => {
  const { buffer, hits } = clickTrack(123, 180);
  const result = await analyzeRhythm(buffer);
  assert.ok(Math.abs(result.bpm - 123) < .1, `got ${result.bpm}`);
  const beats = beatGrid(buffer.duration, result.bpm, result.offset);
  for (const hit of hits) assert.ok(beats.some(t => Math.abs(t - hit) < .035), `drift at ${hit}`);
});

test('beat grid excludes a beat exactly at the end despite floating-point division', () => {
  const duration = .23 + 2 * (60 / 31);
  assert.deepEqual(beatGrid(duration, 31, .23), [.23, .23 + 60 / 31]);
});

test('unstructured noise has no confident tempo', async () => {
  const { buffer, samples } = clickTrack(120, 30);
  let seed = 1;
  for (let i = 0; i < samples.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    samples[i] = (seed / 2 ** 32 - .5) * .2;
  }
  assert.equal((await analyzeRhythm(buffer)).bpm, null);
});

test('short clips retain transients without inventing a tempo; empty clips are safe', async () => {
  const { buffer, hits } = clickTrack(120, 1);
  const result = await analyzeRhythm(buffer);
  assert.equal(result.bpm, null);
  assert.equal(result.onsets.length, hits.length);
  assert.deepEqual(await analyzeRhythm(clickTrack(120, 0).buffer), { bpm: null, offset: 0, regularity: 0, onsets: [] });
});

test('cancellation during analysis stops before returning a completed result', async () => {
  let checks = 0;
  const result = await analyzeRhythm(clickTrack(120, 30).buffer, () => ++checks === 2);
  assert.equal(result, null);
  assert.equal(checks, 2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPeaks, formatTime } from '../dist/waveform.js';

test('waveform retains transients in either stereo channel, including the last sample', () => {
  const channels = [new Float32Array([0, 0, -.8, 0, 0]), new Float32Array([.4, 0, 0, 0, 1])];
  const peaks = extractPeaks({ length: 5, numberOfChannels: 2, getChannelData: (i) => channels[i] }, 2);
  assert.ok(Math.abs(peaks[0] - .4) < .0001);
  assert.equal(peaks[1], 1);
});
test('short clips and silence produce finite peaks', () => {
  const peaks = extractPeaks({ length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0]) });
  assert.deepEqual([...peaks], [0]);
});
test('time display handles boundaries and unknown duration', () => {
  assert.equal(formatTime(59.99, true), '00:59.9');
  assert.equal(formatTime(60, true), '01:00.0');
  assert.equal(formatTime(NaN), '00:00');
  assert.equal(formatTime(-1), '00:00');
});

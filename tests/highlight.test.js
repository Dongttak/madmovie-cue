import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestHighlights } from '../dist/highlight.js';

function audio(duration = 120, loudStart = 60, loudEnd = 90) {
  const sampleRate = 1000;
  const samples = new Float32Array(duration * sampleRate);
  for (let i = 0; i < samples.length; i++) {
    const amplitude = i / sampleRate >= loudStart && i / sampleRate < loudEnd ? .8 : .05;
    samples[i] = Math.sin(2 * Math.PI * 95 * i / sampleRate) * amplitude;
  }
  return { duration, length: samples.length, sampleRate, numberOfChannels: 1, getChannelData: () => samples };
}

test('the strongest middle or ending window wins over a quiet intro', () => {
  for (const start of [60, 90]) {
    const result = suggestHighlights(audio(120, start, start + 30));
    assert.equal(result[0].start, start);
    assert.equal(result[0].end, start + 30);
    assert.equal(result[0].score, 1);
    assert.equal(result[0].label, '에너지 높은 구간 1');
    assert.ok(result.length <= 3);
    for (let i = 0; i < result.length; i++) for (let j = i + 1; j < result.length; j++) {
      assert.ok(Math.min(result[i].end, result[j].end) - Math.max(result[i].start, result[j].start) <= 7.5);
    }
  }
});

test('short clips return one full clip and invalid or silent buffers return none', () => {
  const result = suggestHighlights(audio(12, 2, 10));
  assert.equal(result.length, 1);
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 12);
  const silence = audio();
  silence.getChannelData().fill(0);
  for (const buffer of [null, audio(0), silence, { ...audio(), duration: NaN }]) {
    assert.deepEqual(suggestHighlights(buffer), []);
  }
  assert.deepEqual(suggestHighlights(audio(), { length: -1 }), []);
});

test('anti-phase stereo keeps the same energy ranking', () => {
  const mono = audio();
  const samples = mono.getChannelData();
  const inverse = samples.map(sample => -sample);
  const stereo = { ...mono, numberOfChannels: 2, getChannelData: channel => channel ? inverse : samples };
  const actual = suggestHighlights(stereo), expected = suggestHighlights(mono);
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i].start, expected[i].start);
    assert.equal(actual[i].end, expected[i].end);
    assert.ok(Math.abs(actual[i].score - expected[i].score) < 1e-10);
  }
});

test('beat snapping follows the offset while keeping the full window within the song', () => {
  const result = suggestHighlights(audio(121, 89, 121), { length: 30, bpm: 123, offset: .23 });
  const period = 60 / 123;
  assert.ok(result[0].start > 88);
  for (const candidate of result) {
    const beat = (candidate.start - .23) / period;
    assert.ok(Math.abs(beat - Math.round(beat)) < 1e-8);
    assert.ok(candidate.start >= 0 && candidate.end <= 121);
    assert.ok(Math.abs(candidate.end - candidate.start - 30) < 1e-8);
  }
});

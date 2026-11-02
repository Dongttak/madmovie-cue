import test from 'node:test';
import assert from 'node:assert/strict';
import { createDemoFile } from '../dist/demo.js';
import { analyzeRhythm } from '../dist/rhythm.js';

test('generated demo is a complete mono PCM16 WAV with audible, unclipped samples', async () => {
  const file = createDemoFile();
  assert.equal(file.name, 'CUE-demo-120bpm.wav');
  assert.equal(file.type, 'audio/wav');
  const bytes = await file.arrayBuffer();
  const view = new DataView(bytes);
  const text = (offset, length) => new TextDecoder().decode(new Uint8Array(bytes, offset, length));
  assert.equal(text(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), bytes.byteLength - 8);
  assert.equal(text(8, 8), 'WAVEfmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(text(36, 4), 'data');
  assert.equal(view.getUint32(40, true), bytes.byteLength - 44);
  assert.equal((bytes.byteLength - 44) / 32000, 24);
  let peak = 0;
  for (let i = 44; i < bytes.byteLength; i += 2) peak = Math.max(peak, Math.abs(view.getInt16(i, true)));
  assert.ok(peak > 29000 && peak < 30000, `peak ${peak}`);
});

test('decoded demo estimates 120 BPM and retains kicks through the entire song', async () => {
  const view = new DataView(await createDemoFile().arrayBuffer());
  const samples = new Float32Array((view.byteLength - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
  const result = await analyzeRhythm({
    sampleRate: 16000, length: samples.length, duration: samples.length / 16000,
    numberOfChannels: 1, getChannelData: () => samples,
  });
  assert.ok(Math.abs(result.bpm - 120) < 1, `got ${result.bpm}`);
  for (let hit = .25; hit < 24; hit += .5) {
    assert.ok(result.onsets.some(onset => Math.abs(onset.time - hit) <= .02), `missing kick at ${hit}`);
  }
});

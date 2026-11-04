import { readFile } from 'node:fs/promises';
import { analyzeRhythm } from '../dist/rhythm.js';

const pcm = await readFile(process.argv[2]);
if (pcm.byteLength % 4) throw new Error('Invalid float32 PCM input');
const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 4);
const result = await analyzeRhythm({
  sampleRate: 22050,
  length: samples.length,
  duration: samples.length / 22050,
  numberOfChannels: 1,
  getChannelData: () => samples,
});
// Peak-only bins look flat on limited masters; RMS reveals the energy changes.
const peaks = new Float32Array(Math.min(1200, samples.length));
for (let bin = 0; bin < peaks.length; bin++) {
  const start = Math.floor(bin * samples.length / peaks.length);
  const end = Math.floor((bin + 1) * samples.length / peaks.length);
  let energy = 0;
  for (let i = start; i < end; i++) energy += samples[i] ** 2;
  peaks[bin] = Math.sqrt(energy / Math.max(1, end - start));
}
const maximum = Math.max(1e-8, ...peaks);
console.log(JSON.stringify({ bpm: result.bpm, offset: result.offset, regularity: result.regularity,
  peaks: Array.from(peaks, energy => Math.min(1, energy / maximum)) }));

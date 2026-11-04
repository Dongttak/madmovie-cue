import { readFile } from 'node:fs/promises';
import { analyzeRhythm } from '../dist/rhythm.js';
import { extractPeaks } from '../dist/waveform.js';

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
console.log(JSON.stringify({ bpm: result.bpm, offset: result.offset, regularity: result.regularity,
  peaks: Array.from(extractPeaks({ length: samples.length, numberOfChannels: 1, getChannelData: () => samples }, 1200), peak => Math.min(1, peak)) }));

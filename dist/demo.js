export function createDemoFile() {
  const sampleRate = 16000;
  const samples = new Float32Array(sampleRate * 24);
  for (let beat = .25; beat < 24; beat += .5) {
    const start = Math.round(beat * sampleRate);
    for (let i = 0; i < sampleRate * .2 && start + i < samples.length; i++) {
      const t = i / sampleRate;
      samples[start + i] += .8 * Math.sin(2 * Math.PI * 95 * t) * Math.exp(-t / .035);
    }
  }
  for (let hat = .25; hat < 24; hat += .25) {
    const start = Math.round(hat * sampleRate);
    for (let i = 0; i < sampleRate * .04 && start + i < samples.length; i++) {
      const t = i / sampleRate;
      samples[start + i] += .035 * (Math.sin(2 * Math.PI * 4319 * t) + Math.sin(2 * Math.PI * 6173 * t)) * Math.exp(-t / .006);
    }
  }

  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  /** @param {number} offset @param {string} text */
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeText(0, 'RIFF');
  view.setUint32(4, bytes.byteLength - 8, true);
  writeText(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  const gain = .9 * 32767 / peak;
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(samples[i] * gain), true);
  return new File([bytes], 'CUE-demo-120bpm.wav', { type: 'audio/wav' });
}

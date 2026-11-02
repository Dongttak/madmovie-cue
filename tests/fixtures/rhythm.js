export function clickTrack(bpm = 120, duration = 18, rate = 8000, offset = .23) {
  const samples = new Float32Array(Math.round(duration * rate));
  const hits = [];
  for (let time = offset; time < duration - .05; time += 60 / bpm) {
    hits.push(time);
    const start = Math.round(time * rate);
    for (let j = 0; j < rate * .06 && start + j < samples.length; j++) {
      samples[start + j] = Math.sin(2 * Math.PI * 95 * j / rate) * Math.exp(-j / (rate * .012)) * .8;
    }
  }
  return { samples, hits, buffer: { length: samples.length, duration, sampleRate: rate, numberOfChannels: 1, getChannelData: () => samples } };
}

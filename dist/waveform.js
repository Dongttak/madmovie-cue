/**
 * @param {Pick<AudioBuffer, 'length' | 'numberOfChannels' | 'getChannelData'>} buffer
 * @param {number} [bins]
 */
export function extractPeaks(buffer, bins = 1600) {
  const count = Math.max(1, Math.min(bins, buffer.length));
  const peaks = new Float32Array(count);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let bin = 0; bin < count; bin++) {
    const start = Math.floor(bin * buffer.length / count);
    const end = Math.floor((bin + 1) * buffer.length / count);
    let peak = 0;
    for (const channel of channels) {
      for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(channel[i]));
    }
    peaks[bin] = peak;
  }
  return peaks;
}

/** @param {number} seconds @param {boolean} [precise] */
export function formatTime(seconds, precise = false) {
  const ticks = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0) * 10);
  const minutes = Math.floor(ticks / 600);
  const secs = Math.floor(ticks / 10) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${precise ? `.${ticks % 10}` : ''}`;
}

// shortcut: RMS energy ranks fixed windows; use musical structure analysis for section labels.
/**
 * @param {Pick<AudioBuffer, 'duration' | 'sampleRate' | 'length' | 'numberOfChannels' | 'getChannelData'> | null} buffer
 * @param {{length?: number, bpm?: number | null, offset?: number}} [options]
 * @returns {{start: number, end: number, score: number, label: string}[]}
 */
export function suggestHighlights(buffer, { length = 30, bpm = null, offset = 0 } = {}) {
  if (!buffer || !Number.isFinite(buffer.duration) || buffer.duration <= 0 ||
      !Number.isFinite(buffer.sampleRate) || buffer.sampleRate <= 0 ||
      !Number.isSafeInteger(buffer.length) || buffer.length <= 0 ||
      !Number.isSafeInteger(buffer.numberOfChannels) || buffer.numberOfChannels <= 0 ||
      !Number.isFinite(length) || length <= 0) return [];
  const duration = Math.min(buffer.duration, buffer.length / buffer.sampleRate);
  const window = Math.min(length, duration);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const hop = Math.max(1, Math.round(buffer.sampleRate * .5));
  const step = hop / buffer.sampleRate;
  const prefix = new Float64Array(Math.ceil(buffer.length / hop) + 1);
  for (let bin = 0; bin < prefix.length - 1; bin++) {
    let energy = 0;
    for (const samples of channels) {
      for (let i = bin * hop; i < Math.min((bin + 1) * hop, buffer.length); i++) {
        const sample = samples[i];
        if (Number.isFinite(sample)) energy += sample * sample;
      }
    }
    prefix[bin + 1] = prefix[bin] + energy / (buffer.sampleRate * channels.length);
  }
  /** @param {number} time */
  const energyUntil = time => {
    const bin = Math.floor(time / step);
    if (bin >= prefix.length - 1) return prefix[prefix.length - 1];
    const end = Math.min((bin + 1) * step, buffer.length / buffer.sampleRate);
    return prefix[bin] + (prefix[bin + 1] - prefix[bin]) * (time - bin * step) / (end - bin * step);
  };
  const period = bpm !== null && Number.isFinite(bpm) && bpm >= 30 && bpm <= 300 ? 60 / bpm : 0;
  const phase = Number.isFinite(offset) && period ? ((offset % period) + period) % period : 0;
  const lastStart = duration - window;
  const candidates = [];
  for (let time = 0; time < lastStart + step; time += step) {
    let start = Math.min(time, lastStart);
    if (period && lastStart >= phase) {
      start = phase + Math.round((start - phase) / period) * period;
      start = Math.max(phase, Math.min(start, phase + Math.floor((lastStart - phase) / period) * period));
    }
    const end = Math.min(start + window, duration);
    candidates.push({ start, end, score: (energyUntil(end) - energyUntil(start)) / window });
  }
  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const best = candidates[0]?.score ?? 0;
  if (best < 1e-10) return [];
  /** @type {{start: number, end: number, score: number, label: string}[]} */
  const result = [];
  for (const candidate of candidates) {
    if (candidate.score < 1e-10 || result.some(other =>
      Math.min(other.end, candidate.end) - Math.max(other.start, candidate.start) > window * .25)) continue;
    result.push({ ...candidate, score: candidate.score / best, label: `에너지 높은 구간 ${result.length + 1}` });
    if (result.length === 3) break;
  }
  return result;
}

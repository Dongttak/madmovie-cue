// shortcut: one fixed tempo for the whole song; use local beat tracking for tempo changes.
export function beatGrid(duration, bpm, offset = 0) {
  if (![duration, bpm, offset].every(Number.isFinite) || bpm < 30 || bpm > 300 || offset < 0 || offset >= duration) return [];
  const period = 60 / bpm;
  return Array.from({ length: Math.ceil((duration - offset) / period) }, (_, i) => offset + i * period).filter(time => time < duration);
}

export async function analyzeRhythm(buffer, cancelled = () => false) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  const hop = Math.max(1, Math.round(buffer.sampleRate / 100));
  const step = hop / buffer.sampleRate;
  const envelope = new Float32Array(Math.ceil(buffer.length / hop));
  const lowState = new Float64Array(channels.length);
  const alpha = 1 - Math.exp(-2 * Math.PI * 180 / buffer.sampleRate);
  let previousLow = 0, previousHigh = 0;
  for (let frame = 0; frame < envelope.length; frame++) {
    if (frame % 100 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
      if (cancelled()) return null;
    }
    const start = frame * hop, end = Math.min(buffer.length, start + hop);
    let lowPower = 0, highPower = 0;
    for (let c = 0; c < channels.length; c++) {
      let low = lowState[c];
      for (let i = start; i < end; i++) {
        const sample = channels[c][i];
        low += alpha * (sample - low);
        lowPower += low * low;
        highPower += (sample - low) ** 2;
      }
      lowState[c] = low;
    }
    const n = (end - start) * channels.length;
    const low = Math.sqrt(lowPower / n), high = Math.sqrt(highPower / n);
    envelope[frame] = Math.max(0, low - previousLow) + .5 * Math.max(0, high - previousHigh);
    previousLow = low; previousHigh = high;
  }
  if (cancelled()) return null;
  let max = 0;
  for (const value of envelope) max = Math.max(max, value);
  if (max < .00001) return { bpm: null, offset: 0, regularity: 0, onsets: [] };
  const onsets = [];
  for (let i = 0; i < envelope.length; i++) {
    let mean = 0;
    const from = Math.max(0, i - 15), to = Math.min(envelope.length, i + 16);
    for (let j = from; j < to; j++) mean += envelope[j];
    mean /= to - from;
    const value = envelope[i];
    if (value < Math.max(.00001, max * .1, mean * 1.6)) continue;
    if (value < (envelope[i - 1] ?? 0) || value <= (envelope[i + 1] ?? 0)) continue;
    const onset = { time: i * step, strength: value / max };
    const last = onsets.at(-1);
    if (last && onset.time - last.time < .1) {
      if (onset.strength > last.strength) onsets[onsets.length - 1] = onset;
    } else onsets.push(onset);
  }
  const tempo = estimateTempo(envelope, step, onsets);
  return { ...tempo, onsets };
}

function estimateTempo(envelope, step, onsets) {
  const unknown = { bpm: null, offset: 0, regularity: 0 };
  if (envelope.length * step < 6 || onsets.length < 6) return unknown;
  // Smooth across 30 ms so a beat between frame boundaries still correlates.
  const pulse = Float32Array.from(envelope, (v, i) => v + .5 * ((envelope[i - 1] ?? 0) + (envelope[i + 1] ?? 0)));
  const mean = pulse.reduce((sum, value) => sum + value, 0) / pulse.length;
  for (let i = 0; i < pulse.length; i++) pulse[i] -= mean;
  let bestLag = 0, bestScore = 0, regularity = 0;
  for (let lag = Math.ceil(60 / 200 / step); lag <= Math.floor(60 / 60 / step); lag++) {
    let dot = 0, left = 0, right = 0;
    for (let i = lag; i < pulse.length; i++) {
      dot += pulse[i] * pulse[i - lag];
      left += pulse[i] ** 2; right += pulse[i - lag] ** 2;
    }
    const correlation = dot / (Math.sqrt(left * right) || 1);
    const bpm = 60 / (lag * step);
    const score = correlation * Math.exp(-.1 * Math.log2(bpm / 120) ** 2);
    if (score > bestScore) { bestLag = lag; bestScore = score; regularity = correlation; }
  }
  if (regularity < .15) return unknown;
  let period = bestLag * step;
  let elapsed = 0, cycles = 0;
  for (let i = 1; i < onsets.length; i++) {
    const delta = onsets[i].time - onsets[i - 1].time;
    const count = Math.round(delta / period);
    if (count < 1 || count > 4 || Math.abs(delta - count * period) > .04) continue;
    const weight = Math.min(onsets[i].strength, onsets[i - 1].strength);
    elapsed += delta * weight; cycles += count * weight;
  }
  if (cycles > 0) period = elapsed / cycles;
  let offset = 0, bestPhaseScore = -1;
  for (let phase = 0; phase < period; phase += step) {
    let score = 0;
    for (const onset of onsets) {
      const remainder = ((onset.time - phase) % period + period) % period;
      const distance = Math.min(remainder, period - remainder);
      score += onset.strength * Math.exp(-.5 * (distance / .035) ** 2);
    }
    if (score > bestPhaseScore) { bestPhaseScore = score; offset = phase; }
  }
  // Refine with widely separated hits to avoid cumulative frame-rounding drift.
  let weight = 0, x = 0, y = 0, xx = 0, xy = 0;
  for (const onset of onsets) {
    const beat = Math.round((onset.time - offset) / period);
    if (Math.abs(onset.time - (offset + beat * period)) > .06) continue;
    const w = onset.strength;
    weight += w; x += w * beat; y += w * onset.time; xx += w * beat * beat; xy += w * beat * onset.time;
  }
  const denominator = weight * xx - x * x;
  if (denominator > 0) {
    const refined = (weight * xy - x * y) / denominator;
    if (Math.abs(refined - period) < step) {
      period = refined;
      offset = (y - period * x) / weight;
    }
  }
  offset = ((offset % period) + period) % period;
  if (period - offset < step / 2) offset = 0;
  return { bpm: Math.round(60 / period * 10) / 10, offset: Math.round(offset * 1000) / 1000, regularity };
}

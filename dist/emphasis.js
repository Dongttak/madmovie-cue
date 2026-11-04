export function sourceClock(time, hit, slow) {
  const x = Math.max(0, Math.min(.6, time - hit + .3));
  return time + (slow ? .3 * (x / .6 - Math.sin(Math.PI * x / .3) / (2 * Math.PI)) : 0);
}

export function sourceAt(time, segment) {
  const duration = segment.sourceDuration ?? segment.duration;
  if (segment.accent?.kind !== 'slow') return segment.sourceStart + Math.max(0, Math.min(duration, time));
  let lo = 0, hi = duration;
  for (let i = 0; i < 35; i++) {
    const mid = (lo + hi) / 2;
    if (sourceClock(mid, segment.accent.time - segment.sourceStart, true) < time) lo = mid;
    else hi = mid;
  }
  return segment.sourceStart + (lo + hi) / 2;
}

export function outputAt(source, segment) {
  return segment.timelineStart + sourceClock(source - segment.sourceStart,
    (segment.accent?.time ?? segment.sourceStart) - segment.sourceStart, segment.accent?.kind === 'slow');
}

export function continuitySegments(clips, fps) {
  let position = 0;
  return clips.map((clip, fileIndex) => {
    const sourceStart = Math.ceil(clip.start * fps - 1e-7) / fps;
    const sourceDuration = Math.max(0, (Math.floor(clip.end * fps + 1e-7) / fps) - sourceStart);
    const segment = { fileIndex, sourceStart, duration: sourceDuration, timelineStart: position };
    if (clip.accent) Object.assign(segment, { sourceDuration, accent: clip.accent,
      duration: sourceDuration + (clip.accent.kind === 'slow' ? .3 : 0) });
    position += segment.duration;
    return segment;
  });
}

export function withoutAccents(segments) {
  let position = 0;
  return segments.map(segment => {
    const item = { fileIndex: segment.fileIndex, sourceStart: segment.sourceStart,
      duration: segment.sourceDuration ?? segment.duration, timelineStart: position };
    position += item.duration;
    return item;
  });
}

import { suggestHighlights } from './highlight.js';
import { formatTime } from './waveform.js';

export function createClipEditor({ audio, onChange, onPositionChange }) {
  const $ = id => document.getElementById(id);
  const controlIds = ['clip-length', 'clip-start', 'clip-end', 'clip-position', 'clip-preview', 'clip-full', 'clip-loop'];
  let buffer = null, start = 0, end = 0, bpm = null, offset = 0;
  let active = false, edited = false, timer = 0;

  function render() {
    $('clip-start').value = start.toFixed(3);
    $('clip-end').value = end.toFixed(3);
    $('clip-position').max = Math.max(0, buffer.duration - (end - start));
    $('clip-position').value = start;
    $('clip-position').setAttribute('aria-valuetext', `${formatTime(start, true)}부터 ${formatTime(end, true)}까지`);
    $('clip-summary').textContent = `${formatTime(start, true)} → ${formatTime(end, true)} · ${(end - start).toFixed(1)}초`;
    const preset = [15, 30, 45, 60].find(value => Math.abs(end - start - value) < .01);
    $('clip-length').value = preset ? String(preset) : 'custom';
    onChange();
  }
  function setSelection(nextStart, nextEnd, manual = true) {
    if (!buffer) return;
    if (!Number.isFinite(nextStart) || !Number.isFinite(nextEnd)) return render();
    if (active) { active = false; audio.pause(); }
    const maxEnd = Math.floor(buffer.duration * 1000) / 1000;
    const gap = Math.min(.1, maxEnd);
    start = Math.max(0, Math.min(nextStart, maxEnd - gap));
    end = Math.max(start + gap, Math.min(nextEnd, maxEnd));
    edited = manual;
    render();
  }
  function scheduleBoundary() {
    clearTimeout(timer);
    if (!active || audio.paused) return;
    timer = setTimeout(() => { tick(); scheduleBoundary(); }, Math.max(10, (end - audio.currentTime) * 1000));
  }
  function tick() {
    if (!active || audio.currentTime < end - .005) return;
    if ($('clip-loop').checked) {
      audio.currentTime = start;
      if (audio.paused) audio.play().catch(() => {
        active = false;
        $('clip-status').textContent = '반복 재생이 중단됐어요. 구간 미리듣기를 다시 눌러주세요.';
      });
    } else {
      active = false;
      audio.pause();
      audio.currentTime = end;
      $('clip-status').textContent = '선택한 구간의 재생이 끝났어요.';
    }
    onPositionChange();
  }
  function refreshSuggestions(chooseBest = false) {
    if (!buffer) return;
    const length = end - start || Math.min(30, buffer.duration);
    const candidates = suggestHighlights(buffer, { length, bpm, offset });
    $('clip-suggestions').replaceChildren();
    for (const candidate of candidates) {
      const button = document.createElement('button');
      button.className = 'button secondary';
      button.textContent = `${candidate.label} · ${formatTime(candidate.start, true)}`;
      button.addEventListener('click', () => {
        setSelection(candidate.start, candidate.end);
        audio.currentTime = start;
        onPositionChange();
        $('clip-status').textContent = '추천 구간을 골랐어요. 구간 미리듣기로 확인하세요.';
      });
      $('clip-suggestions').append(button);
    }
    if (!candidates.length) $('clip-suggestions').textContent = '뚜렷한 에너지 구간을 찾지 못했어요. 직접 범위를 골라주세요.';
    if (chooseBest && candidates.length && !edited) setSelection(candidates[0].start, candidates[0].end, false);
  }
  $('clip-length').addEventListener('change', () => {
    const length = Number($('clip-length').value);
    if (!buffer || !length) return;
    const span = Math.min(length, buffer.duration);
    const position = Math.min(start, buffer.duration - span);
    setSelection(position, position + span);
    refreshSuggestions();
  });
  $('clip-start').addEventListener('change', () => {
    setSelection(Math.min(Number($('clip-start').value), end - .1), end);
    refreshSuggestions();
  });
  $('clip-end').addEventListener('change', () => {
    setSelection(start, Number($('clip-end').value));
    refreshSuggestions();
  });
  $('clip-position').addEventListener('input', () => {
    const position = Number($('clip-position').value);
    setSelection(position, position + end - start);
  });
  $('clip-preview').addEventListener('click', async () => {
    if (!buffer) return;
    active = true;
    audio.currentTime = start;
    onPositionChange();
    try {
      await audio.play();
      if (active && !audio.paused) {
        $('clip-status').textContent = $('clip-loop').checked ? '선택한 구간을 반복해서 듣고 있어요.' : '선택한 구간을 한 번 듣고 있어요.';
        scheduleBoundary();
      }
    } catch {
      if (!active) return;
      active = false;
      $('clip-status').textContent = '재생을 시작하지 못했어요. 구간 미리듣기를 다시 눌러주세요.';
    }
  });
  $('clip-full').addEventListener('click', async () => {
    active = false;
    clearTimeout(timer);
    audio.currentTime = 0;
    onPositionChange();
    try { await audio.play(); $('clip-status').textContent = '전체 음원을 재생하고 있어요.'; }
    catch { $('clip-status').textContent = '전체 재생을 시작하지 못했어요. 다시 눌러주세요.'; }
  });
  audio.addEventListener('play', scheduleBoundary);
  audio.addEventListener('pause', () => clearTimeout(timer));
  audio.addEventListener('seeked', scheduleBoundary);
  return {
    reset() {
      clearTimeout(timer);
      buffer = null; start = 0; end = 0; active = false; edited = false; bpm = null; offset = 0;
      for (const id of controlIds) $(id).disabled = true;
      $('clip-summary').textContent = '음원을 먼저 열어주세요';
      $('clip-suggestions').replaceChildren();
      $('clip-status').textContent = '노래를 열면 하이라이트 후보를 고를 수 있어요.';
    },
    load(decoded) {
      buffer = decoded; edited = false;
      for (const id of controlIds) $(id).disabled = false;
      $('clip-start').max = $('clip-end').max = Math.floor(buffer.duration * 1000) / 1000;
      for (const option of $('clip-length').options) option.disabled = option.value !== 'custom' && Number(option.value) > buffer.duration;
      setSelection(0, Math.min(30, buffer.duration), false);
      refreshSuggestions(true);
      $('clip-status').textContent = '구간을 골라 미리 듣고 조절하세요. 추천은 소리 에너지 기준이며 후렴·드롭 분류는 아니에요.';
    },
    updateAnalysis(tempo, phase) { bpm = tempo; offset = phase; refreshSuggestions(true); },
    getAudioSelection() { return buffer ? { buffer, start, end } : null; },
    getSelection() { return buffer ? { start, end } : null; },
    tick,
  };
}

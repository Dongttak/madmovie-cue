import { createMontageEditor } from './montage.js';
import { createNcsEditor } from './ncs.js';
import { extractPeaks, formatTime } from './waveform.js';
import { analyzeRhythm, beatGrid } from './rhythm.js';
import { createDemoFile } from './demo.js';
import { createShortsEditor } from './shorts.js';
import { createClipEditor } from './clip-editor.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const canvas = $('wave');
const ctx = canvas.getContext('2d');
const seek = $('seek');
let peaks = null;
let objectUrl = null;
let loadId = 0;
let ready = false;
let animation = 0;
let duration = 0;
let analysis = null;
let beats = [];
let onsets = [];
let clipEditor = null;
let shortsEditor = null;
const MAX_BYTES = 150 * 1024 * 1024;

function status(message, error = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', error);
}
function enableControls(enabled) {
  ready = enabled;
  for (const id of ['play', 'back', 'forward', 'seek']) $(id).disabled = !enabled;
}
function draw() {
  const { width, height } = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(width * dpr), h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.strokeStyle = '#253036';
  ctx.lineWidth = 1;
  for (let i = 1; i < 8; i++) {
    ctx.beginPath(); ctx.moveTo(width * i / 8, 0); ctx.lineTo(width * i / 8, height); ctx.stroke();
  }
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  if (!peaks) return;
  const progress = duration ? audio.currentTime / duration : 0;
  const clip = clipEditor?.getSelection();
  if (clip) {
    ctx.fillStyle = '#d9fb851e';
    ctx.fillRect(clip.start / duration * width, 0, (clip.end - clip.start) / duration * width, height);
    ctx.fillStyle = '#b9e478';
    ctx.fillRect(clip.start / duration * width, 0, 2, height);
    ctx.fillRect(clip.end / duration * width - 2, 0, 2, height);
  }
  const bars = Math.max(1, Math.floor(width / 3));
  for (let i = 0; i < bars; i++) {
    const from = Math.floor(i * peaks.length / bars);
    const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((i + 1) * peaks.length / bars)));
    let amplitude = 0;
    for (let p = from; p < to; p++) amplitude = Math.max(amplitude, peaks[p]);
    const barHeight = Math.max(2, amplitude * (height - 36));
    ctx.fillStyle = i / bars < progress ? '#d9fb85' : '#688a83';
    ctx.fillRect(i * width / bars, (height - barHeight) / 2, Math.max(1, width / bars - 1), barHeight);
  }
  if ($('show-beats').checked) {
    ctx.fillStyle = '#d9fb8570';
    const stride = Math.max(1, Math.ceil(beats.length / (width / 4)));
    for (let i = 0; i < beats.length; i += stride) {
      const x = beats[i] / duration * width;
      ctx.fillRect(x, height - 25, 1, 25);
    }
  }
  if ($('show-onsets').checked) {
    ctx.fillStyle = '#ffac7e';
    for (const onset of onsets) {
      const x = onset.time / duration * width;
      ctx.beginPath(); ctx.moveTo(x - 3, 0); ctx.lineTo(x + 3, 0); ctx.lineTo(x, 7); ctx.fill();
      ctx.fillRect(x, 8, 1, 8 + onset.strength * 20);
    }
  }
  const x = Math.max(1, Math.min(width - 1, progress * width));
  ctx.fillStyle = '#edffd1'; ctx.fillRect(x - .5, 0, 1, height);
  ctx.beginPath(); ctx.moveTo(x - 5, 0); ctx.lineTo(x + 5, 0); ctx.lineTo(x, 7); ctx.fill();
}
function updatePosition() {
  clipEditor?.tick();
  $('current').textContent = formatTime(audio.currentTime, true);
  seek.value = audio.currentTime;
  seek.setAttribute('aria-valuetext', `${formatTime(audio.currentTime, true)} / ${formatTime(duration, true)}`);
  draw();
}
function animate() {
  updatePosition();
  if (!audio.paused) animation = requestAnimationFrame(animate);
}
function moveTo(time) {
  if (!ready) return;
  audio.currentTime = Math.max(0, Math.min(duration, time));
  if (audio.paused) $('play').textContent = '재생';
  updatePosition();
}
async function togglePlay() {
  if (!ready) return;
  if (!audio.paused) { audio.pause(); return; }
  if (audio.ended || audio.currentTime >= duration) moveTo(0);
  try { await audio.play(); }
  catch { status('재생하지 못했어요. 재생 버튼을 다시 눌러주세요.', true); }
}
async function loadFile(file) {
  if (!file) return;
  if (file.size > MAX_BYTES) { status('이번 버전에서는 150MB 이하 음원을 열어주세요.', true); return; }
  $('sample-status').textContent = '';
  $('sample-status').classList.remove('error');
  const id = ++loadId;
  audio.pause();
  $('play').textContent = '재생';
  enableControls(false);
  peaks = null; duration = 0;
  clipEditor?.reset();
  shortsEditor?.refresh();
  analysis = null; beats = []; onsets = [];
  analysisControls(false);
  $('bpm').value = ''; $('offset').value = '0';
  $('analysis-summary').textContent = '음원 읽는 중';
  $('analysis-status').textContent = '음원을 읽은 뒤 박자와 타격 후보를 찾을게요.';
  $('analysis-status').classList.remove('error');
  $('onset-count').textContent = '0';
  $('onset-list').replaceChildren();
  if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
  audio.removeAttribute('src'); audio.load();
  $('track-name').textContent = file.name;
  $('track-info').textContent = `${(file.size / 1024 / 1024).toFixed(1)} MB · 음원 읽는 중`;
  $('empty').hidden = false;
  $('empty').querySelector('strong').textContent = '파형을 준비하고 있어요';
  $('current').textContent = $('total').textContent = '00:00.0';
  for (const name of ['quarter', 'half', 'three-quarter', 'duration-label']) $(name).textContent = '—';
  seek.value = 0; draw(); status('음원을 읽고 파형을 만들고 있어요. 긴 곡은 잠시 걸릴 수 있어요.');
  let context;
  try {
    context = new AudioContext();
    const buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (id !== loadId) return;
    peaks = extractPeaks(buffer);
    duration = buffer.duration;
    if (!duration) throw new Error('Empty audio');
    objectUrl = URL.createObjectURL(file);
    audio.src = objectUrl;
    seek.max = duration;
    $('total').textContent = formatTime(duration, true);
    ['quarter', 'half', 'three-quarter', 'duration-label'].forEach((name, i) => {
      $(name).textContent = formatTime(duration * (i + 1) / 4);
    });
    $('track-info').textContent = `${formatTime(duration)} · ${buffer.numberOfChannels === 1 ? '모노' : `${buffer.numberOfChannels}채널`} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
    $('empty').hidden = true;
    enableControls(true);
    clipEditor.load(buffer);
    updatePosition();
    status('준비됐어요. 재생하거나 파형을 눌러 원하는 순간으로 이동하세요.');
    void runAnalysis(buffer, id);
  } catch {
    if (id !== loadId) return;
    peaks = null; duration = 0; draw();
    $('empty').querySelector('strong').textContent = '다른 음원으로 다시 시도해 주세요';
    $('track-info').textContent = '음원을 열지 못했어요';
    $('analysis-summary').textContent = '분석할 음원이 없어요';
    $('analysis-status').textContent = '다른 음원을 열어주세요.';
    status('지원하지 않거나 손상된 음원이에요. MP3 또는 WAV 파일로 다시 시도해 주세요.', true);
  } finally {
    if (context) await context.close().catch(() => {});
  }
}
function analysisControls(enabled) {
  for (const id of ['bpm', 'offset', 'apply-beats', 'use-position']) $(id).disabled = !enabled;
  $('reset-beats').disabled = !enabled || !analysis?.bpm;
}
function refreshBeats() {
  beats = beatGrid(duration, Number($('bpm').value), Number($('offset').value));
  clipEditor?.updateAnalysis(Number($('bpm').value) || null, Number($('offset').value));
  $('analysis-summary').textContent = `${beats.length}개 박자 · ${onsets.length}개 타격 후보`;
  draw();
}
async function runAnalysis(buffer, id) {
  $('analysis-summary').textContent = '박자 분석 중';
  $('analysis-status').textContent = '타격 후보와 반복되는 박자를 찾고 있어요. 분석 중에도 재생할 수 있어요.';
  try {
    const result = await analyzeRhythm(buffer, () => id !== loadId);
    if (!result || id !== loadId) return;
    analysis = result;
    onsets = result.onsets;
    $('offset').max = Math.max(0, Math.floor((duration - .001) * 1000) / 1000);
    $('bpm').value = result.bpm ?? '';
    $('offset').value = result.offset;
    analysisControls(true);
    $('analysis-status').textContent = result.bpm
      ? `자동 추정 ${result.bpm} BPM · 박자 규칙성 ${result.regularity >= .5 ? '높음' : '낮음'}. 배수·분할 BPM일 수 있으니 들어보고 보정해 주세요.`
      : '규칙적인 박자를 추정하기 어려워요. 6초 이상 음원에서 다시 시도하거나 BPM과 첫 박자를 직접 입력해 주세요.';
    $('onset-count').textContent = onsets.length;
    const strongest = [...onsets].sort((a, b) => b.strength - a.strength).slice(0, 100).sort((a, b) => a.time - b.time);
    $('onset-list').replaceChildren();
    for (const onset of strongest) {
      const button = document.createElement('button');
      button.className = 'onset-button';
      button.textContent = formatTime(onset.time, true);
      button.setAttribute('aria-label', `${formatTime(onset.time, true)} 타격 후보로 이동`);
      const strength = document.createElement('span');
      strength.textContent = onset.strength >= .65 ? '강' : '후보';
      button.append(strength);
      button.addEventListener('click', () => moveTo(onset.time));
      $('onset-list').append(button);
    }
    if (!strongest.length) $('onset-list').textContent = '뚜렷한 타격 후보를 찾지 못했어요.';
    refreshBeats();
  } catch {
    if (id !== loadId) return;
    $('analysis-summary').textContent = '자동 분석 실패';
    $('analysis-status').textContent = '자동 분석을 마치지 못했어요. 재생과 수동 BPM 입력은 사용할 수 있어요.';
    $('analysis-status').classList.add('error');
    analysisControls(true);
  }
}
$('beat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!ready || !$('beat-form').reportValidity()) return;
  refreshBeats();
  $('analysis-status').textContent = `수동 보정: ${Number($('bpm').value)} BPM · 첫 박자 ${Number($('offset').value).toFixed(3)}초. 직접 들어보며 확인해 주세요.`;
  $('analysis-status').classList.remove('error');
});
$('use-position').addEventListener('click', () => { $('offset').value = Math.min(audio.currentTime, Number($('offset').max)).toFixed(3); });
$('reset-beats').addEventListener('click', () => {
  if (!analysis?.bpm) return;
  $('bpm').value = analysis.bpm; $('offset').value = analysis.offset;
  refreshBeats();
  $('analysis-status').textContent = `자동 추정 ${analysis.bpm} BPM으로 복원했어요.`;
  $('analysis-status').classList.remove('error');
});
clipEditor = createClipEditor({ audio, onChange: () => { draw(); shortsEditor?.refresh(); }, onPositionChange: updatePosition });
shortsEditor = createShortsEditor({ audio, getSelection: () => clipEditor.getAudioSelection() });
for (const id of ['show-beats', 'show-onsets']) $(id).addEventListener('change', draw);
$('sample-demo').addEventListener('click', () => loadFile(createDemoFile()));
$('open').addEventListener('click', () => $('file').click());
$('file').addEventListener('change', (event) => {
  loadFile(event.target.files[0]); event.target.value = '';
});
$('play').addEventListener('click', togglePlay);
$('back').addEventListener('click', () => moveTo(audio.currentTime - 5));
$('forward').addEventListener('click', () => moveTo(audio.currentTime + 5));
seek.addEventListener('input', () => moveTo(Number(seek.value)));
// A transparent native range retains keyboard accessibility; pointer placement is exact.
seek.addEventListener('pointerdown', (event) => {
  if (!ready) return;
  event.preventDefault(); seek.focus(); seek.setPointerCapture(event.pointerId);
  const rect = seek.getBoundingClientRect();
  moveTo((event.clientX - rect.left) / rect.width * duration);
});
seek.addEventListener('pointermove', (event) => {
  if (!seek.hasPointerCapture(event.pointerId)) return;
  const rect = seek.getBoundingClientRect();
  moveTo((event.clientX - rect.left) / rect.width * duration);
});
$('volume').addEventListener('input', (event) => { audio.volume = Number(event.target.value); });
audio.volume = .8;
audio.addEventListener('play', () => { $('play').textContent = '일시정지'; cancelAnimationFrame(animation); animate(); });
audio.addEventListener('pause', () => { $('play').textContent = '재생'; cancelAnimationFrame(animation); updatePosition(); });
audio.addEventListener('timeupdate', updatePosition);
audio.addEventListener('ended', () => { $('play').textContent = '다시 재생'; updatePosition(); });
audio.addEventListener('error', () => {
  if (audio.hasAttribute('src')) { enableControls(false); status('브라우저에서 재생하지 못했어요. MP3 또는 WAV로 다시 열어주세요.', true); }
});
document.addEventListener('keydown', (event) => {
  if (!ready || event.altKey || event.ctrlKey || event.metaKey || /INPUT|BUTTON|TEXTAREA|SELECT/.test(event.target.tagName)) return;
  if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
  if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
    event.preventDefault(); moveTo(audio.currentTime + (event.code === 'ArrowLeft' ? -5 : 5));
  }
});
let dragDepth = 0;
const zone = $('drop-zone');
// Prevent the browser from navigating away when a file is dropped outside the waveform.
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => event.preventDefault());
zone.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; zone.classList.add('drag'); });
zone.addEventListener('dragover', (event) => event.preventDefault());
zone.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; zone.classList.remove('drag'); } });
zone.addEventListener('drop', (event) => {
  event.preventDefault(); dragDepth = 0; zone.classList.remove('drag');
  loadFile(event.dataTransfer.files[0]);
});
new ResizeObserver(draw).observe(canvas);
window.addEventListener('pagehide', (event) => { audio.pause(); if (!event.persisted && objectUrl) URL.revokeObjectURL(objectUrl); });
draw();

createNcsEditor();

createMontageEditor();

import { formatTime } from './waveform.js';
import { continuitySegments, sourceAt, outputAt, withoutAccents } from './emphasis.js';

export function createMontageEditor() {
  const $ = id => document.getElementById(id);
  const select = $('mont-track');
  let tracks = [], clips = [], plan = null, busy = false, loading = false, controller, outputUrl, lastTrack = '', previewClip = null;
  let outputs = {}, waveform = null, waveformTrack = '', sourceView = true, displayedOutput = 'accent';
  const continuous = () => $('mont-mode').value === 'continuity';
  const MAX_BYTES = 150 * 1024 * 1024 - 65536;
  const status = message => { $('mont-status').textContent = message; };
  function clearOutput() {
    $('mont-result').pause(); $('mont-result').removeAttribute('src'); $('mont-result').load();
    $('mont-result').hidden = $('mont-download').hidden = true; $('mont-download').removeAttribute('href');
    for (const result of Object.values(outputs)) URL.revokeObjectURL(result.url);
    outputs = {}; $('mont-compare-label').hidden = true;
    outputUrl = null;
    sourceView = true;
  }
  function refresh() {
    const locked = busy || loading;
    for (const id of ['mont-search', 'mont-track', 'mont-music-start', 'mont-length', 'mont-bpm', 'mont-offset']) $(id).disabled = locked || !tracks.length;
    for (const id of ['mont-files', 'mont-upload', 'mont-mode', 'mont-layout', 'mont-fps', 'mont-game-audio']) $(id).disabled = locked;
    select.disabled = locked || !select.value;
    for (const control of $('mont-clips').querySelectorAll('button,input')) control.disabled = locked || control.dataset.boundary === 'true';
    $('mont-plan').disabled = locked || !tracks.some(track => track.id === select.value) || clips.length < (continuous() ? 1 : 2);
    $('mont-set-start').disabled = $('mont-set-end').disabled = locked || !previewClip;
    $('mont-render').disabled = $('mont-json').disabled = locked || !plan;
    $('mont-render-base').disabled = locked || !plan || !plan.segments.some(segment => segment.accent);
    $('mont-add-accent').disabled = locked || !previewClip || !continuous();
    $('mont-remove-accent').disabled = $('mont-accent-time').disabled = locked || !previewClip?.accent || !continuous();
    $('mont-accent-kind').disabled = locked || !continuous();
    $('mont-seek').disabled = locked;
    $('mont-cancel').hidden = !busy;
    $('mont-retry').disabled = locked;
    $('mont-empty').hidden = clips.length > 0;
    for (const row of $('mont-clips').children) row.dataset.selected = String(clips[Number(row.dataset.index)] === previewClip);
    const completed = Object.keys(outputs).length > 0;
    const step = completed ? 3 : plan ? 2 : clips.length ? 1 : 0;
    document.querySelectorAll('[data-editor-step]').forEach((node, index) => {
      if (index === step) node.setAttribute('aria-current', 'step'); else node.removeAttribute('aria-current');
      node.dataset.done = String(index < step);
    });
    $('mont-ready').textContent = busy ? '처리 중' : completed ? '저장 가능' : plan ? '선택 구간 확인됨' : clips.length ? '구간 확인 필요' : '영상 추가 대기';
    $('mont-next').textContent = !clips.length ? '먼저 교전 영상을 추가해보세요.'
      : !tracks.some(track => track.id === select.value) ? '음악을 선택하면 구간 확인과 영상 만들기를 진행할 수 있어요.'
      : !plan ? '교전의 시작·끝을 정하고 ‘선택 구간 확인’을 눌러주세요.'
      : completed ? '완성본을 확인하고 저장하세요. 강조본과 기본본을 모두 만들면 비교할 수 있어요.'
      : '준비됐어요. MP4를 만들거나 중요한 순간에 강조를 더해보세요.';
  }
  $('mont-upload').addEventListener('click', () => $('mont-files').click());
  function openPreview(clip) {
    sourceView = true; $('mont-result').pause(); previewClip = clip;
    $('mont-source').dataset.clipUrl = clip.url; $('mont-source').onloadedmetadata = null;
    $('mont-source').src = `${clip.url}#t=${clip.start},${clip.end}`;
    $('mont-source').hidden = $('mont-source-caption').hidden = $('mont-range-tools').hidden = false;
    updateCaption(); refresh(); drawTimeline();
  }
  function invalidate() {
    plan = null; clearOutput(); $('mont-plan-rows').replaceChildren();
    $('mont-summary').textContent = '교전의 시작·끝과 음악을 고른 뒤 선택 구간을 확인하세요.'; refresh(); drawTimeline();
  }
  function showClips() {
    $('mont-clips').replaceChildren();
    clips.forEach((clip, index) => {
      const row = document.createElement('li'); row.dataset.index = index;
      const title = document.createElement('strong'); title.textContent = `${index + 1}. ${clip.file.name}`;
      const info = document.createElement('span'); info.textContent = `${formatTime(clip.duration, true)} · ${(clip.file.size / 1024 / 1024).toFixed(1)} MB`;
      const label = document.createElement('label'); label.textContent = '시작 (초)';
      const start = document.createElement('input'); start.type = 'number'; start.min = '0'; start.max = Math.max(0, clip.end - .1); start.step = '.1'; start.value = clip.start;
      start.setAttribute('aria-label', `클립 ${index + 1} 시작 (초)`);
      start.addEventListener('change', () => {
        const value = Number(start.value);
        if (start.value === '' || !Number.isFinite(value) || value < 0 || value > clip.end - .1) {
          start.value = clip.start; status('클립 시작은 영상 길이보다 최소 0.1초 앞쪽으로 지정하세요.'); return;
        }
        clip.start = value; end.min = clip.start + .1; invalidate(); updateCaption();
      });
      label.append(start); row.append(title, info, label);
      const endLabel = document.createElement('label'); endLabel.textContent = '끝 (초)';
      const end = document.createElement('input'); end.type = 'number'; end.min = clip.start + .1; end.max = clip.duration; end.step = '.1'; end.value = clip.end;
      end.setAttribute('aria-label', `클립 ${index + 1} 끝 (초)`);
      end.addEventListener('change', () => {
        const value = Number(end.value);
        if (end.value === '' || !Number.isFinite(value) || value > clip.duration || value < clip.start + .1) {
          end.value = clip.end; status('클립 끝은 시작보다 최소 0.1초 뒤이며 영상 길이 안이어야 해요.'); return;
        }
        clip.end = value; start.max = clip.end - .1; invalidate(); updateCaption();
      });
      endLabel.append(end); row.append(endLabel);
      const actions = document.createElement('div'); actions.className = 'clip-buttons';
      function button(text, action, boundary = false) {
        const node = document.createElement('button'); node.className = 'button secondary'; node.textContent = text;
        node.setAttribute('aria-label', `클립 ${index + 1} ${text}`); node.dataset.boundary = String(boundary);
        node.addEventListener('click', action); actions.append(node);
      }
      button('미리보기', () => {
        openPreview(clip);
      });
      button('위로', () => { [clips[index - 1], clips[index]] = [clips[index], clips[index - 1]]; invalidate(); showClips(); }, index === 0);
      button('아래로', () => { [clips[index], clips[index + 1]] = [clips[index + 1], clips[index]]; invalidate(); showClips(); }, index === clips.length - 1);
      button('삭제', () => {
        $('mont-source').pause(); $('mont-source').removeAttribute('src'); $('mont-source').load(); $('mont-source').hidden = true;
        previewClip = null; $('mont-source-caption').hidden = $('mont-range-tools').hidden = true;
        URL.revokeObjectURL(clip.url); clips.splice(index, 1); invalidate(); showClips();
        if (clips.length) openPreview(clips[Math.min(index, clips.length-1)]);
      });
      row.append(actions); $('mont-clips').append(row);
    });
    $('mont-files-summary').textContent = `${clips.length} / 8개 · ${(clips.reduce((sum, clip) => sum + clip.file.size, 0) / 1024 / 1024).toFixed(1)} MB / 최대 150MB`;
    refresh(); drawTimeline();
  }
  function updateCaption() {
    if (previewClip) $('mont-source-caption').textContent = `${previewClip.file.name} · 선택 ${previewClip.start.toFixed(2)} → ${previewClip.end.toFixed(2)}초`;
    $('mont-accent-time').value = previewClip?.accent?.time ?? '';
    if (previewClip?.accent) $('mont-accent-kind').value = previewClip.accent.kind;
  }
  function timelineSegments() {
    if (!sourceView && outputs[$('mont-compare').value]) return outputs[$('mont-compare').value].segments;
    return plan?.segments || (continuous() ? continuitySegments(clips, Number($('mont-fps').value)) : []);
  }
  function drawTimeline() {
    const segments = timelineSegments();
    $('mont-timeline-wrap').hidden = !continuous() || !segments.length;
    if (!segments.length || !continuous()) return;
    const duration = segments.reduce((sum, segment) => sum + segment.duration, 0);
    if (!(duration > 0)) return;
    const canvas = $('mont-timeline'), width = canvas.getBoundingClientRect().width || 700, height = 150;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width*dpr); canvas.height = height*dpr;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#101a20'; ctx.fillRect(0, 0, width, height);
    const musicStart = Number($('mont-music-start').value);
    ctx.fillStyle = '#708a77';
    if (waveform?.duration > 0 && waveformTrack === select.value) {
      for (let x = 0; x < width; x += 2) {
        const bin = Math.floor((musicStart + x/width*duration)/waveform.duration*waveform.peaks.length);
        const amplitude = waveform.peaks[bin] || 0;
        ctx.fillRect(x, 40-amplitude*30, 1, Math.max(1, amplitude*60));
      }
    } else { ctx.font = '12px Pretendard, sans-serif'; ctx.fillText('선택 구간 확인 후 실제 음악 파형 표시', 12, 38); }
    let current = 0;
    segments.forEach(segment => {
      const clip = clips[segment.fileIndex];
      const x = segment.timelineStart/duration*width, w = segment.duration/duration*width;
      ctx.fillStyle = clip === previewClip ? '#42583a' : '#263c40'; ctx.fillRect(x+1, 82, Math.max(1, w-2), 38);
      ctx.save(); ctx.beginPath(); ctx.rect(x+4, 84, Math.max(0, w-8), 34); ctx.clip();
      ctx.fillStyle = '#e1e9d7'; ctx.font = '12px Pretendard, sans-serif'; ctx.fillText(`${segment.fileIndex+1} · ${clip.file.name}`, x+8, 105); ctx.restore();
      if (segment.accent) {
        const hit = outputAt(segment.accent.time, segment)/duration*width;
        ctx.fillStyle = '#ffb17d'; ctx.fillRect(hit-1, 6, 2, 115);
        ctx.beginPath(); ctx.moveTo(hit-5, 0); ctx.lineTo(hit+5, 0); ctx.lineTo(hit, 7); ctx.fill();
      }
      if (sourceView && clip === previewClip) current = outputAt(Math.max(segment.sourceStart, Math.min(segment.sourceStart+(segment.sourceDuration ?? segment.duration), $('mont-source').currentTime)), segment);
    });
    if (!sourceView) current = $('mont-result').currentTime;
    $('mont-seek').max = duration; $('mont-seek').value = Math.min(duration, current);
    $('mont-seek').setAttribute('aria-valuetext', `${current.toFixed(2)}초 / ${duration.toFixed(2)}초`);
    const x = Math.max(0, Math.min(width-1, current/duration*width)); ctx.fillStyle = '#e1ff90'; ctx.fillRect(x, 0, 2, 125);
    ctx.font = '11px Pretendard, sans-serif'; ctx.fillText('0s', 4, 143); ctx.fillText(`${duration.toFixed(2)}s`, Math.max(0,width-65), 143);
    $('mont-time').textContent = `${sourceView ? '원본 미리보기' : $('mont-compare').value === 'base' ? '기본 완성본' : '강조 완성본'} · ${current.toFixed(2)} / ${duration.toFixed(2)}초${previewClip ? ` · 원본 ${$('mont-source').currentTime.toFixed(2)}초` : ''}`;
  }
  function seekTimeline(position) {
    if (busy || loading) return;
    const segments = timelineSegments(), segment = segments.find(item => position < item.timelineStart+item.duration) || segments.at(-1);
    if (!segment) return;
    const clip = clips[segment.fileIndex], source = sourceAt(position-segment.timelineStart, segment);
    previewClip = clip;
    if (!sourceView) { $('mont-result').currentTime = position; $('mont-result').pause(); }
    const video = $('mont-source'); video.pause();
    if (video.dataset.clipUrl !== clip.url) {
      video.dataset.clipUrl = clip.url; video.src = clip.url;
      video.onloadedmetadata = () => { if (previewClip === clip) { video.currentTime = source; updateCaption(); drawTimeline(); } };
    } else video.currentTime = source;
    video.hidden = $('mont-source-caption').hidden = $('mont-range-tools').hidden = false;
    updateCaption(); refresh(); drawTimeline();
  }
  $('mont-seek').addEventListener('input', () => seekTimeline(Number($('mont-seek').value)));
  $('mont-timeline').addEventListener('click', event => {
    const box = $('mont-timeline').getBoundingClientRect();
    seekTimeline(Math.max(0, Math.min(1, (event.clientX-box.left)/box.width))*Number($('mont-seek').max));
  });
  function setAccent(at) {
    if (!previewClip || busy || loading || !continuous()) return;
    const fps = Number($('mont-fps').value);
    const start = Math.ceil(previewClip.start*fps-1e-7)/fps, end = Math.floor(previewClip.end*fps+1e-7)/fps;
    if (!Number.isFinite(at) || at < start+.3 || at > end-.3) { updateCaption(); return status('강조는 선택 구간의 시작·끝에서 0.3초 이상 떨어진 순간에 지정하세요.'); }
    $('mont-source').pause(); $('mont-result').pause();
    previewClip.accent = { time: at, kind: $('mont-accent-kind').value };
    invalidate(); updateCaption(); status('고른 순간만 강조해요. 선택 구간 확인 후 기본본·강조본을 만들어 비교하세요.');
  }
  $('mont-add-accent').addEventListener('click', () => setAccent($('mont-source').currentTime));
  $('mont-accent-time').addEventListener('change', () => setAccent(Number($('mont-accent-time').value)));
  $('mont-accent-kind').addEventListener('change', () => { if (previewClip?.accent) setAccent(previewClip.accent.time); });
  $('mont-remove-accent').addEventListener('click', () => { if (busy || loading || !previewClip) return; delete previewClip.accent; invalidate(); updateCaption(); });
  new ResizeObserver(drawTimeline).observe($('mont-timeline'));
  document.fonts.ready.then(drawTimeline);
  $('mont-result').addEventListener('timeupdate', drawTimeline);
  $('mont-result').addEventListener('play', () => { sourceView = false; $('mont-source').pause(); drawTimeline(); });
  $('mont-source').addEventListener('timeupdate', () => {
    if (previewClip && $('mont-source').currentTime >= previewClip.end && !$('mont-source').paused) $('mont-source').pause();
    drawTimeline();
  });
  $('mont-source').addEventListener('play', () => {
    sourceView = true; $('mont-result').pause();
    if (previewClip && ($('mont-source').currentTime < previewClip.start || $('mont-source').currentTime >= previewClip.end)) $('mont-source').currentTime = previewClip.start;
  });
  for (const edge of ['start', 'end']) $('mont-set-' + edge).addEventListener('click', () => {
    if (!previewClip || busy || loading) return;
    const position = $('mont-source').currentTime;
    if (!Number.isFinite(position) || (edge === 'start' ? position > previewClip.end-.1 : position < previewClip.start+.1)) return status('시작과 끝 사이에 최소 0.1초를 남겨주세요.');
    previewClip[edge] = Math.max(0, Math.min(previewClip.duration, position));
    $('mont-source').pause(); invalidate(); showClips(); updateCaption();
  });
  function modeChanged() {
    $('mont-length-label').hidden = $('mont-beat-settings').hidden = continuous();
    $('mont-plan').textContent = continuous() ? '선택 구간 확인' : '박자에 자동 배치';
    $('mont-mode-help').textContent = continuous()
      ? '선택한 교전 안을 자동으로 자르지 않아요. 직접 지정한 순간에만 줌·슬로모션을 적용해요. 와이드는 위아래 HUD 일부를 잘라 중앙 교전에 집중해요. 60fps는 원본에 없는 동작을 새로 만들지는 않아요.'
      : '선택 범위 안에서 길이를 나누고 박자에 컷을 맞춰요. 교전 마무리가 잘릴 수 있으니 배치를 확인하세요. 와이드는 상하 HUD 일부를 자르며, 가로는 전체 화면을 유지해요.';
    invalidate();
  }
  $('mont-mode').addEventListener('change', modeChanged);
  function metadata(file) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video'), url = URL.createObjectURL(file);
      const timeout = setTimeout(() => finish(new Error('영상 길이를 읽지 못했어요. 다른 파일로 시도하세요.')), 15000);
      function finish(error) {
        clearTimeout(timeout); video.onloadedmetadata = video.onerror = null;
        const duration = video.duration;
        video.removeAttribute('src'); video.load();
        if (error) { URL.revokeObjectURL(url); reject(error); }
        else resolve({ file, duration, start: 0, end: duration, url });
      }
      video.preload = 'metadata';
      video.onloadedmetadata = () => finish(Number.isFinite(video.duration) && video.duration >= .1 && video.videoWidth ? null : new Error('0.1초 이상인 재생 가능한 게임 영상을 골라주세요.'));
      video.onerror = () => finish(new Error('이 영상은 브라우저에서 읽지 못했어요. MP4로 시도하세요.'));
      video.src = url;
    });
  }
  $('mont-files').addEventListener('change', async event => {
    const files = Array.from(event.target.files); event.target.value = '';
    if (!files.length || busy || loading) return;
    if (clips.length + files.length > 8) return status('클립은 최대 8개까지 추가할 수 있어요. 기존 클립을 삭제하거나 파일 수를 줄여주세요.');
    if (clips.reduce((sum, clip) => sum + clip.file.size, 0) + files.reduce((sum, file) => sum + file.size, 0) > MAX_BYTES) return status('클립 전체 크기를 150MB 미만으로 줄여주세요.');
    loading = true; refresh(); const pending = [];
    try {
      for (const file of files) pending.push(await metadata(file));
      clips.push(...pending); invalidate(); showClips(); status('미리보기로 교전을 보고 시작·끝과 순서를 확인하세요.');
      if (!previewClip) openPreview(clips[0]);
    } catch (error) { pending.forEach(clip => URL.revokeObjectURL(clip.url)); status(error.message); }
    finally { loading = false; refresh(); }
  });
  function filterTracks() {
    const previous = select.value;
    const words = $('mont-search').value.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = tracks.filter(track => words.every(word => `${track.artist} ${track.title} ${track.genre || ''}`.normalize('NFKC').toLocaleLowerCase().includes(word)));
    select.replaceChildren(...matches.map(track => { const option = document.createElement('option'); option.value = track.id; option.textContent = `${track.artist} — ${track.title}`; return option; }));
    if (matches.some(track => track.id === previous)) select.value = previous;
    if (!matches.length) { const empty = document.createElement('option'); empty.value = ''; empty.textContent = '일치하는 곡이 없어요'; select.append(empty); }
    selected();
  }
  function selected() {
    if (lastTrack !== select.value) { invalidate(); $('mont-bpm').value = ''; $('mont-offset').value = '0'; }
    lastTrack = select.value;
    const track = tracks.find(track => track.id === select.value);
    $('mont-credit').value = track?.credit || ''; $('mont-listen').href = track?.page || 'https://ncs.io/'; refresh();
  }
  $('mont-search').addEventListener('input', filterTracks); select.addEventListener('change', selected);
  for (const id of ['mont-music-start', 'mont-length', 'mont-bpm', 'mont-offset', 'mont-layout', 'mont-fps', 'mont-game-audio']) $(id).addEventListener('change', invalidate);
  $('mont-cancel').addEventListener('click', () => controller?.abort());
  async function request(path, body, onSuccess, keepOutputs = false) {
    busy = true; if (!keepOutputs) clearOutput(); refresh(); $('mont-source').pause(); $('mont-result').pause(); controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 240000);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': body instanceof Blob ? 'application/octet-stream' : 'application/json' }, body, signal: controller.signal });
      if (response.status === 401) throw new Error('서버 로그인 링크에서 알파 계정으로 로그인한 뒤 다시 시도하세요.');
      if (!response.ok) { const data = await response.json().catch(() => ({})); throw new Error(data.error || '처리하지 못했어요. 클립과 시간을 확인하고 다시 시도하세요.'); }
      await onSuccess(response, controller.signal);
    } catch (error) { status(error.name === 'AbortError' ? (timedOut ? '처리 시간이 길어 요청을 중단했어요. 더 짧은 영상으로 다시 시도하세요.' : '요청을 취소했어요. 다시 시작할 수 있어요.') : error.message); }
    finally { clearTimeout(timeout); controller = null; busy = false; refresh(); }
  }
  $('mont-plan').addEventListener('click', async () => {
    const musicStart = Number($('mont-music-start').value), length = continuous() ? 60 : Number($('mont-length').value);
    const bpm = continuous() || $('mont-bpm').value === '' ? null : Number($('mont-bpm').value), offset = continuous() ? 0 : Number($('mont-offset').value);
    if (!Number.isFinite(musicStart) || musicStart < 0 || !Number.isFinite(length) || length <= 0 || length > 60 || (bpm !== null && (!Number.isFinite(bpm) || bpm < 30 || bpm > 300)) || !Number.isFinite(offset) || offset < 0) return status('음악 시작·첫 박자는 0초 이상, BPM은 30~300으로 지정하세요.');
    invalidate(); status(continuous() ? '선택 구간 전체와 음악 길이를 확인하는 중…' : '음악을 분석하고 클립을 박자에 배치하는 중…');
    const input = { track: select.value, musicStart, length, mode: $('mont-mode').value, layout: $('mont-layout').value, fps: Number($('mont-fps').value), gameAudio: $('mont-game-audio').checked, clips: clips.map(clip => ({ duration: clip.duration, start: clip.start, end: clip.end, ...(continuous() && clip.accent ? { accent: clip.accent } : {}) })) };
    if (bpm !== null) Object.assign(input, { bpm, offset });
    await request('/api/ncs/plan', JSON.stringify(input), async (response, signal) => {
      const data = await response.json(); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!Array.isArray(data.segments) || data.segments.length !== clips.length) throw new Error('배치 결과를 읽지 못했어요. 다시 시도하세요.');
      plan = data;
      if (data.waveform) { waveform = data.waveform; waveformTrack = select.value; }
      drawTimeline();
      $('mont-plan-rows').replaceChildren(...plan.segments.map(segment => {
        const row = document.createElement('tr');
        for (const value of [clips[segment.fileIndex].file.name, `${segment.timelineStart.toFixed(2)} → ${(segment.timelineStart + segment.duration).toFixed(2)}`, `${segment.sourceStart.toFixed(2)} → ${(segment.sourceStart + (segment.sourceDuration ?? segment.duration)).toFixed(2)}`]) {
          const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
        }
        return row;
      }));
      const mode = plan.mode === 'continuity' ? '교전 구간 전체 유지' : plan.mode === 'beats' ? '박자 기준 배치' : '균등 분할 배치';
      $('mont-summary').textContent = `${plan.duration.toFixed(2)}초 · ${clips.length}클립 · ${mode} · ${input.fps}fps · ${input.layout === 'wide' ? '와이드' : input.layout === 'landscape' ? '가로' : '세로'}${plan.bpm ? ` · ${plan.bpm} BPM` : ''}`;
      status(plan.warning || '사용할 원본 구간을 확인했으면 MP4를 만드세요. 시작·끝·순서를 바꾸면 다시 확인해야 해요.');
    });
  });
  function showOutput(kind) {
    const next = outputs[kind]; if (!next) return;
    const video = $('mont-result'), old = outputs[displayedOutput];
    const previous = old?.segments.find(segment => video.currentTime < segment.timelineStart+segment.duration) || old?.segments.at(-1);
    const source = previous ? sourceAt(video.currentTime-previous.timelineStart, previous) : null;
    const target = previous ? next.segments.find(segment => segment.fileIndex === previous.fileIndex) : null;
    const position = target ? outputAt(source, target) : 0;
    video.pause(); $('mont-source').pause(); sourceView = false; displayedOutput = kind;
    video.src = next.url; video.hidden = false;
    video.onloadedmetadata = () => { video.currentTime = Math.max(0, Math.min(position, video.duration)); drawTimeline(); };
    outputUrl = next.url; $('mont-download').href = outputUrl;
    $('mont-download').download = `CUE-${select.value}-${kind === 'base' ? 'baseline' : 'montage'}.mp4`; $('mont-download').hidden = false;
    $('mont-compare').value = kind; $('mont-compare-label').hidden = false;
    for (const option of $('mont-compare').options) option.disabled = !outputs[option.value];
    drawTimeline();
  }
  $('mont-compare').addEventListener('change', () => showOutput($('mont-compare').value));
  async function renderComparison(base) {
    if (!plan || busy) return;
    const segments = base ? withoutAccents(plan.segments) : plan.segments;
    const manifest = { track: select.value, musicStart: Number($('mont-music-start').value), mode: $('mont-mode').value, layout: $('mont-layout').value, fps: Number($('mont-fps').value), gameAudio: $('mont-game-audio').checked, segments, files: clips.map(clip => ({ size: clip.file.size })) };
    const json = new TextEncoder().encode(JSON.stringify(manifest));
    const header = new Uint8Array(4); new DataView(header.buffer).setUint32(0, json.byteLength);
    status(base ? '같은 교전을 강조 없이 만드는 중…' : '선택한 순간을 강조하고 교전 전체를 이어 만드는 중…');
    await request('/api/ncs/montage', new Blob([header, json, ...clips.map(clip => clip.file)]), async (response, signal) => {
      if (!(response.headers.get('Content-Type') || '').startsWith('video/mp4')) throw new Error('완성 영상 응답을 확인하지 못했어요.');
      const blob = await response.blob(); if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!blob.size) throw new Error('완성 영상이 비어 있어요.');
      const kind = base ? 'base' : 'accent';
      if (outputs[kind]) URL.revokeObjectURL(outputs[kind].url);
      outputs[kind] = { url: URL.createObjectURL(blob), segments }; showOutput(kind);
      status('완성됐어요. 기본본과 강조본을 모두 만들면 같은 원본 순간을 기준으로 바꿔 보며 비교할 수 있어요.');
    }, true);
  }
  $('mont-render').addEventListener('click', () => renderComparison(false));
  $('mont-render-base').addEventListener('click', () => renderComparison(true));
  $('mont-json').addEventListener('click', () => {
    if (!plan) return;
    const data = { version: plan.segments.some(segment => segment.accent) ? 3 : 2, music: { track: select.value, start: Number($('mont-music-start').value) }, clips: clips.map(clip => ({ name: clip.file.name, start: clip.start, end: clip.end, duration: clip.duration })), ...plan };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'CUE-cut-plan.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  async function loadCatalog() {
    try {
      const response = await fetch('/api/ncs/catalog'); if (!response.ok) throw new Error();
      const data = await response.json(); if (!Array.isArray(data.tracks) || !data.tracks.length) throw new Error();
      tracks = data.tracks; filterTracks(); status(`NCS ${tracks.length}곡 준비 완료. 교전 영상 1~8개를 추가하세요.`);
    } catch { status('음악 목록을 불러오지 못했어요. 목록 다시 불러오기를 눌러주세요.'); }
    refresh();
  }
  $('mont-retry').addEventListener('click', loadCatalog);
  window.addEventListener('pagehide', event => {
    controller?.abort(); $('mont-source').pause(); $('mont-result').pause();
    if (!event.persisted) { clips.forEach(clip => URL.revokeObjectURL(clip.url)); Object.values(outputs).forEach(result => URL.revokeObjectURL(result.url)); }
  });
  showClips(); loadCatalog();
}

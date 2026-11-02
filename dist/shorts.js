export function createShortsEditor({ audio, getSelection }) {
  const $ = id => document.getElementById(id);
  const video = $('shorts-source'), result = $('shorts-result');
  let inputUrl, outputUrl, cancel, busy = false, loadId = 0, selectedBuffer, selectedStart, selectedEnd;
  const status = text => { $('shorts-status').textContent = text; };
  function clearOutput() {
    result.pause(); result.removeAttribute('src'); result.load(); result.hidden = true;
    $('shorts-download').hidden = true;
    $('shorts-download').removeAttribute('href');
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
  }
  function refresh() {
    const selection = getSelection();
    const changed = selection?.buffer !== selectedBuffer || selection?.start !== selectedStart || selection?.end !== selectedEnd;
    if (busy && changed) cancel?.();
    if (changed) clearOutput();
    selectedBuffer = selection?.buffer; selectedStart = selection?.start; selectedEnd = selection?.end;
    $('shorts-render').disabled = busy || !selection || !Number.isFinite(video.duration) || video.duration <= 0;
  }
  $('shorts-file').addEventListener('change', async event => {
    cancel?.(); clearOutput();
    const id = ++loadId;
    const file = event.target.files[0];
    video.pause(); video.removeAttribute('src'); video.load(); video.hidden = true;
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    inputUrl = null; refresh();
    if (!file) return;
    if (file.size > 500 * 1024 * 1024) return status('영상은 500MB 이하로 골라주세요.');
    inputUrl = URL.createObjectURL(file);
    video.src = inputUrl;
    try {
      await new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error('브라우저가 이 영상을 열지 못했어요. 다른 파일로 시도하세요.'));
      });
      if (id !== loadId) return;
      if (!Number.isFinite(video.duration) || !video.videoWidth) throw new Error('길이를 확인할 수 있는 영상 파일을 골라주세요.');
      video.hidden = false; $('shorts-start').value = '0';
      status(`영상 ${video.duration.toFixed(1)}초 준비 완료. 음악 구간을 고르고 쇼츠를 만드세요.`);
    } catch (error) { if (id === loadId) status(error.message); }
    refresh();
  });
  $('shorts-start').addEventListener('change', () => { clearOutput(); refresh(); });
  $('shorts-cancel').addEventListener('click', () => cancel?.());
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel?.(); });
  window.addEventListener('pagehide', () => cancel?.());
  $('shorts-render').addEventListener('click', async () => {
    if (busy) return;
    const selection = getSelection(), from = Number($('shorts-start').value);
    if (!selection || !Number.isFinite(from) || from < 0 || from >= video.duration) return status('음악을 고르고 영상 시작 시간을 영상 길이 안으로 지정하세요.');
    const { buffer, start, end } = selection;
    const length = Math.min(60, end - start, buffer.duration - start, video.duration - from);
    if (!(length > 0)) return status('선택한 구간이 비어 있어요.');
    const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus'];
    const mimeType = typeof MediaRecorder !== 'undefined' && types.find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) return status('이 브라우저에서는 영상 저장을 지원하지 않아요. 최신 Chrome 또는 Edge에서 시도하세요.');
    busy = true; clearOutput(); audio.pause(); video.pause(); video.controls = false;
    $('shorts-render').disabled = true; $('shorts-cancel').hidden = false;
    $('shorts-file').disabled = $('shorts-start').disabled = true;
    let context, destination, source, stream, recorder, frame = 0, cancelled = false, fail;
    const aborted = new Promise((_, reject) => { fail = reject; });
    // A cancellation can arrive while seeking or preparing the recorder.
    aborted.catch(() => {});
    cancel = () => { cancelled = true; fail(new Error('만들기를 취소했어요. 탭을 열어둔 상태에서 다시 시작하세요.')); };
    try {
      status(`${length.toFixed(1)}초 영상 준비 중…`);
      if (Math.abs(video.currentTime - from) > .001) {
        await Promise.race([new Promise((resolve, reject) => {
          video.onseeked = resolve;
          video.onerror = () => reject(new Error('영상 위치를 이동하지 못했어요.'));
          video.currentTime = from;
        }), aborted]);
      }
      context = new AudioContext();
      await Promise.race([context.resume(), aborted]);
      destination = context.createMediaStreamDestination();
      source = context.createBufferSource(); source.buffer = buffer; source.connect(destination);
      const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280;
      const ctx = canvas.getContext('2d');
      const scale = Math.min(720 / video.videoWidth, 1280 / video.videoHeight);
      const width = video.videoWidth * scale, height = video.videoHeight * scale;
      function paint() {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 720, 1280);
        ctx.drawImage(video, (720 - width) / 2, (1280 - height) / 2, width, height);
        frame = requestAnimationFrame(paint);
      }
      paint();
      stream = canvas.captureStream(30);
      stream.addTrack(destination.stream.getAudioTracks()[0]);
      recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 4000000, audioBitsPerSecond: 128000 });
      const chunks = [];
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      const stopped = new Promise(resolve => { recorder.onstop = resolve; });
      recorder.onerror = () => fail(new Error('영상 저장 중 오류가 발생했어요.'));
      const ended = new Promise(resolve => { source.onended = resolve; });
      video.onended = () => { source.stop(); };
      video.onwaiting = () => fail(new Error('영상 재생이 지연돼 만들기를 중단했어요. 더 짧은 영상으로 다시 시도하세요.'));
      video.onerror = () => fail(new Error('영상 재생에 실패했어요.'));
      // shortcut: real-time browser recording; use an offline encoder for frame-accurate exports.
      await Promise.race([video.play(), aborted]);
      recorder.start(); source.start(0, start, length);
      video.onpause = () => { if (!video.ended) fail(new Error('영상 재생이 중단돼 만들기를 취소했어요.')); };
      context.onstatechange = () => { if (context.state !== 'running') fail(new Error('음악 재생이 중단돼 만들기를 취소했어요.')); };
      const update = () => {
        if (busy && context.state === 'running') status(`쇼츠 만드는 중… ${Math.min(length, context.currentTime - began).toFixed(1)} / ${length.toFixed(1)}초 · 이 탭을 열어두세요.`);
      };
      const began = context.currentTime;
      const progress = setInterval(update, 200);
      try { await Promise.race([ended, aborted]); } finally { clearInterval(progress); }
      if (cancelled) throw new Error('만들기를 취소했어요.');
      recorder.stop(); await Promise.race([stopped, aborted]);
      if (cancelled) throw new Error('만들기를 취소했어요.');
      const blob = new Blob(chunks, { type: recorder.mimeType });
      if (!blob.size) throw new Error('영상이 생성되지 않았어요. 다시 시도하세요.');
      outputUrl = URL.createObjectURL(blob);
      result.src = outputUrl; result.hidden = false;
      const link = $('shorts-download');
      link.href = outputUrl; link.download = `CUE-shorts.${recorder.mimeType.includes('mp4') ? 'mp4' : 'webm'}`; link.hidden = false;
      status(`${length.toFixed(1)}초 쇼츠 완성 · ${recorder.mimeType.includes('mp4') ? 'MP4' : 'WebM'} · 미리 보고 완성 영상을 저장하세요.`);
    } catch (error) { status(error.message || '영상을 만들지 못했어요. 더 짧은 구간으로 다시 시도하세요.'); }
    finally {
      video.onpause = video.onwaiting = video.onended = video.onerror = video.onseeked = null;
      if (context) context.onstatechange = null;
      video.pause(); cancelAnimationFrame(frame);
      if (source) { try { source.stop(); } catch {} source.disconnect(); }
      if (recorder?.state !== 'inactive' && recorder) recorder.stop();
      destination?.stream.getTracks().forEach(track => track.stop());
      stream?.getTracks().forEach(track => track.stop());
      if (context) await context.close();
      cancel = null; busy = false; video.controls = true;
      $('shorts-file').disabled = $('shorts-start').disabled = false;
      $('shorts-cancel').hidden = true; refresh();
    }
  });
  return { refresh };
}

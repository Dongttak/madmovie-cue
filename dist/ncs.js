export function createNcsEditor() {
  const $ = id => document.getElementById(id);
  if (location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) {
    $('server-login').href = `https://${location.host}/api/ncs/access`;
  }
  const select = $('ncs-track'), input = $('ncs-file');
  let tracks = [], outputUrl, inputUrl, controller, busy = false, lastSelectedId = '';
  const status = text => { $('ncs-status').textContent = text; };
  function clearOutput() {
    $('ncs-result').pause(); $('ncs-result').removeAttribute('src'); $('ncs-result').load();
    $('ncs-result').hidden = $('ncs-download').hidden = true;
    $('ncs-download').removeAttribute('href');
    if (outputUrl) URL.revokeObjectURL(outputUrl);
    outputUrl = null;
  }
  function refresh() {
    $('ncs-render').disabled = busy || !tracks.some(track => track.id === select.value) || !input.files[0];
    for (const id of ['ncs-search', 'ncs-track', 'ncs-file', 'ncs-music-start', 'ncs-length', 'ncs-video-start']) $(id).disabled = busy || !tracks.length;
    select.disabled = busy || !select.value;
    $('ncs-cancel').hidden = !busy;
    $('ncs-retry').disabled = busy;
  }
  function selected() {
    if (select.value !== lastSelectedId) clearOutput();
    lastSelectedId = select.value;
    const track = tracks.find(track => track.id === select.value);
    $('ncs-credit').value = track?.credit || '';
    $('ncs-listen').href = track?.page || 'https://ncs.io/';
    refresh();
  }
  function filterTracks(preferred = select.value) {
    const words = $('ncs-search').value.normalize('NFKC').toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = tracks.filter(track => {
      const text = `${track.title} ${track.artist} ${track.genre || ''}`.normalize('NFKC').toLocaleLowerCase();
      return words.every(word => text.includes(word));
    });
    select.replaceChildren(...matches.map(track => {
      const option = document.createElement('option'); option.value = track.id;
      option.textContent = `${track.artist} — ${track.title}${track.genre ? ` · ${track.genre}` : ''}`;
      return option;
    }));
    if (matches.some(track => track.id === preferred)) select.value = preferred;
    if (!matches.length) {
      const option = document.createElement('option'); option.value = ''; option.textContent = '일치하는 곡이 없어요'; select.append(option);
    }
    $('ncs-count').textContent = `전체 ${tracks.length}곡 · 검색 ${matches.length}곡`;
    selected();
  }
  $('ncs-search').addEventListener('input', () => filterTracks());
  select.addEventListener('change', selected);
  for (const id of ['ncs-music-start', 'ncs-length', 'ncs-video-start']) $(id).addEventListener('change', clearOutput);
  input.addEventListener('change', () => {
    clearOutput();
    const source = $('ncs-source'); source.pause(); source.removeAttribute('src'); source.load(); source.hidden = true;
    if (inputUrl) URL.revokeObjectURL(inputUrl);
    inputUrl = null;
    const file = input.files[0];
    if (file && file.size > 150 * 1024 * 1024) {
      input.value = ''; status('서버 합성에는 150MB 이하 게임 영상을 골라주세요.');
    } else if (file) {
      inputUrl = URL.createObjectURL(file); source.src = inputUrl; source.hidden = false;
      $('ncs-video-start').value = '0';
      status('게임 영상 준비 완료. 곡과 음악 시작 시간을 고르고 NCS 쇼츠를 만드세요.');
    }
    refresh();
  });
  $('ncs-cancel').addEventListener('click', () => controller?.abort());
  $('ncs-render').addEventListener('click', async () => {
    if (busy) return;
    const file = input.files[0], track = tracks.find(track => track.id === select.value);
    const musicStart = Number($('ncs-music-start').value), length = Number($('ncs-length').value), videoStart = Number($('ncs-video-start').value);
    if (!file || !track) return;
    if (![musicStart, length, videoStart].every(Number.isFinite) || musicStart < 0 || videoStart < 0 || length <= 0 || length > 60) return status('시작 시간은 0초 이상, 구간 길이는 60초 이하로 지정하세요.');
    busy = true; clearOutput(); refresh(); $('ncs-source').pause();
    controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 240000);
    try {
      status('게임 영상을 보내고 NCS 음악을 입히는 중… 완료까지 잠시 기다려주세요.');
      const query = new URLSearchParams({ track: track.id, musicStart, length, videoStart });
      const response = await fetch(`/api/ncs/render?${query}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal: controller.signal });
      if (response.status === 401) throw new Error('서버 로그인 링크에서 알파 계정으로 로그인한 뒤 다시 시도하세요.');
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.error || '서버에서 영상을 만들지 못했어요. 잠시 뒤 다시 시도하세요.');
      }
      if (!(response.headers.get('content-type') || '').startsWith('video/mp4')) throw new Error('영상 응답을 확인하지 못했어요. 다시 시도하세요.');
      const blob = await response.blob();
      if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (!blob.size) throw new Error('생성된 영상이 비어 있어요. 다른 구간으로 시도하세요.');
      outputUrl = URL.createObjectURL(blob);
      $('ncs-result').src = outputUrl; $('ncs-result').hidden = false;
      $('ncs-download').href = outputUrl; $('ncs-download').download = `CUE-${track.id}-shorts.mp4`; $('ncs-download').hidden = false;
      status(`${track.title} 쇼츠 완성 · MP4 · 영상과 출처를 확인하고 저장하세요.`);
    } catch (error) {
      status(error.name === 'AbortError' ? (timedOut ? '처리 시간이 길어 요청을 중단했어요. 더 짧은 영상으로 다시 시도하세요.' : '요청을 취소했어요. 다시 만들 수 있어요.') : error.message);
    } finally {
      clearTimeout(timeout); controller = null; busy = false; refresh();
    }
  });
  window.addEventListener('pagehide', () => controller?.abort());
  async function loadCatalog() {
    try {
      const response = await fetch('/api/ncs/catalog');
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!Array.isArray(data.tracks) || !data.tracks.length) throw new Error();
      tracks = data.tracks;
      document.querySelector('.ncs-catalog summary').textContent = `NCS ${tracks.length}곡에서 골라 쇼츠 만들기`;
      filterTracks(); status(`NCS ${tracks.length}곡 준비 완료. 곡명·아티스트·장르로 검색하고 게임 영상을 추가하세요.`);
    } catch {
      status('NCS 가져오기 서버에 연결하지 못했어요. 잠시 뒤 목록을 다시 불러와 주세요.');
    }
    refresh();
  }
  $('ncs-retry').addEventListener('click', loadCatalog);
  loadCatalog();
}

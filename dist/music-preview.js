// A visible official player, loaded only by a click; CUE never supplies its audio.
export function createMusicPreview(prefix, getTrack, getStart) {
  const $ = name => document.getElementById(`${prefix}-${name}`);
  const button = $('preview-open'), panel = $('preview-panel'), host = $('preview-player');
  let videoId = null;
  function stop() {
    host.replaceChildren(); panel.hidden = true; button.setAttribute('aria-expanded', 'false');
  }
  function update() {
    const track = getTrack();
    const id = typeof track?.youtubeId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(track.youtubeId) ? track.youtubeId : null;
    if (id !== videoId) stop();
    videoId = id; button.disabled = !id;
    $('preview-note').textContent = id ? 'YouTube 공식 플레이어로 재생해요. 외부 서비스에 연결됩니다.'
      : '이 곡의 공식 미리듣기가 없어요. 공식 페이지에서 들어주세요.';
  }
  button.addEventListener('click', () => {
    update(); if (!videoId) return;
    const start = Number(getStart());
    if (!Number.isFinite(start) || start < 0 || start > 86400) { $('preview-note').textContent = '음악 시작을 0~86400초 안의 숫자로 입력하세요.'; return; }
    window.dispatchEvent(new Event('cue-stop-previews'));
    document.querySelectorAll('audio,video').forEach(media => media.pause());
    const frame = document.createElement('iframe');
    const url = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
    url.search = new URLSearchParams({ start: Math.floor(start), autoplay: '1', playsinline: '1', rel: '0', origin: location.origin }).toString();
    frame.title = `${getTrack().artist} — ${getTrack().title} 공식 미리듣기`;
    frame.referrerPolicy = 'strict-origin-when-cross-origin'; frame.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    frame.allowFullscreen = true; frame.src = url.href;
    host.replaceChildren(frame); panel.hidden = false; button.setAttribute('aria-expanded', 'true');
  });
  $('preview-close').addEventListener('click', stop);
  window.addEventListener('cue-stop-previews', stop);
  window.addEventListener('cue-workspace-change', stop);
  window.addEventListener('pagehide', stop);
  return { update, stop };
}

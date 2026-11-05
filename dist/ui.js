export function createWorkspaceNavigation() {
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')];
  const compact = matchMedia('(max-width: 900px)');
  const orient = () => tabs[0].parentElement.setAttribute('aria-orientation', compact.matches ? 'horizontal' : 'vertical');
  compact.addEventListener('change', orient); orient();
  const descriptions = { edit: '교전을 고르고, 중요한 순간만 강조하세요.',
    analyze: '내 음원에서 박자와 타격점을 찾고, 귀로 확인하세요.',
    quick: '한 곡과 한 장면을 골라, 세로 쇼츠로 만들어보세요.' };
  const alert = document.createElement('p'); alert.className = 'navigation-alert';
  alert.setAttribute('role', 'status'); alert.hidden = true;
  document.querySelector('.page-intro').after(alert);
  let selected = 'edit';
  function activate(key, focus = false) {
    const next = tabs.find(tab => tab.dataset.view === key); if (!next) return;
    if (key !== selected && ['mont-cancel', 'ncs-cancel', 'shorts-cancel'].some(id => !document.getElementById(id).hidden)) {
      alert.textContent = '영상 작업이 진행 중이에요. 완료하거나 요청을 취소한 뒤 다른 작업으로 이동하세요.';
      alert.hidden = false; return;
    }
    if (key !== selected) {
      document.querySelectorAll('audio,video').forEach(media => media.pause());
      window.dispatchEvent(new Event('cue-workspace-change'));
    }
    alert.hidden = true; selected = key;
    for (const tab of tabs) {
      const active = tab === next;
      tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    document.getElementById('workspace-title').textContent = next.querySelector('span').firstChild.textContent;
    document.getElementById('workspace-description').textContent = descriptions[key];
    history.replaceState(null, '', `#${key}`);
    if (focus) next.focus();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => activate(tab.dataset.view));
    tab.addEventListener('keydown', event => {
      let target;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) target = (index+1)%tabs.length;
      if (['ArrowLeft', 'ArrowUp'].includes(event.key)) target = (index+tabs.length-1)%tabs.length;
      if (event.key === 'Home') target = 0;
      if (event.key === 'End') target = tabs.length-1;
      if (target !== undefined) { event.preventDefault(); event.stopPropagation(); activate(tabs[target].dataset.view, true); }
    });
  });
  window.addEventListener('hashchange', () => activate(location.hash.slice(1)));
  activate(descriptions[location.hash.slice(1)] ? location.hash.slice(1) : 'edit');
}

import { el, installTooltips } from './ui/components';
import { createProcessView, hasUnsavedResults, syncPatternChanges } from './ui/process-view';
import { createPatternsView } from './ui/patterns-view';
import { createRestoreView } from './ui/restore-view';

type TabId = 'process' | 'patterns' | 'restore';

const TABS: { id: TabId; label: string; create: () => HTMLElement }[] = [
  { id: 'process', label: '去識別化', create: createProcessView },
  { id: 'patterns', label: '偵測規則', create: createPatternsView },
  { id: 'restore', label: '還原', create: createRestoreView },
];

function mount(): void {
  const app = document.getElementById('app')!;
  // Static about/FAQ content shipped in index.html for crawlers; after mount it lives in a dialog opened from the footer.
  const siteInfo = document.getElementById('site-info');
  app.replaceChildren(); // drop the static SEO fallback
  const infoDialog = el('dialog', { class: 'site-info-dialog', 'aria-label': '常見問題' });
  if (siteInfo) {
    infoDialog.append(
      el('button', { class: 'dialog-close', type: 'button', 'aria-label': '關閉', onClick: () => infoDialog.close() }, '✕'),
      siteInfo,
    );
    infoDialog.addEventListener('click', (e) => {
      if (e.target === infoDialog) infoDialog.close(); // backdrop click
    });
  }
  const nav = el('nav', { class: 'tabs' });
  const panels = el('main', { class: 'panels' });
  const views = new Map<TabId, HTMLElement>();

  const activate = (id: TabId) => {
    // Popups are attached to <body>, so they would otherwise linger over the other tabs.
    document.querySelector('.add-popup')?.remove();
    window.getSelection()?.removeAllRanges();
    for (const t of TABS) {
      nav.querySelector(`[data-tab="${t.id}"]`)?.classList.toggle('active', t.id === id);
      let v = views.get(t.id);
      if (!v && t.id === id) {
        v = t.create();
        views.set(t.id, v);
        panels.append(v);
      }
      if (v) v.hidden = t.id !== id;
    }
    // Pattern changes made in another tab should be visible on return.
    if (id === 'patterns') {
      const fresh = createPatternsView();
      views.get('patterns')?.replaceWith(fresh);
      views.set('patterns', fresh);
    }
    if (id === 'process') syncPatternChanges();
  };

  for (const t of TABS) {
    nav.append(el('button', { class: 'tab', 'data-tab': t.id, type: 'button', onClick: () => activate(t.id) }, t.label));
  }
  app.append(
    el('header', { class: 'header' },
      el('a', { class: 'brand', href: import.meta.env.BASE_URL, 'aria-label': 'DeID｜醫療資料去識別化首頁' },
        el('span', { class: 'brand-symbol', 'aria-hidden': 'true' }, '＋'),
        el('div', {}, el('h1', {}, 'DeID｜醫療資料去識別化'), el('span', { class: 'brand-subtitle' }, '辨識個資・人工覆核・編碼還原'))),
      el('a', { class: 'btn new-session', href: import.meta.env.BASE_URL, target: '_blank', rel: 'noopener', title: '在新分頁從首頁開始，保留目前工作' }, '＋ 開始新的辨識 ↗'),
    ),
    el('div', { class: 'navigation' }, nav),
    panels,
    el('footer', { class: 'footer' },
      el('div', { class: 'footer-inner' },
        el('span', { class: 'muted small' }, 'DeID · 請先覆核，再分享'),
        el('div', { class: 'footer-links' },
          el('a', { href: 'https://github.com/gemini960114/medical-deidentification', target: '_blank', rel: 'noopener' }, '原始碼 ↗'),
          siteInfo ? el('span', { class: 'muted' }, '・') : null,
          siteInfo ? el('button', { class: 'link-btn', type: 'button', onClick: () => infoDialog.showModal() }, '常見問題') : null,
        ),
      ),
    ),
    infoDialog,
  );
  activate('process');
  document.documentElement.classList.remove('app-booting');

  window.addEventListener('beforeunload', (e) => {
    if (hasUnsavedResults()) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
}

mount();
installTooltips();

// Info / help page: features, live keyboard shortcuts, troubleshooting, support link.
const $ = (id) => document.getElementById(id);
let lang = KaraokeI18n.resolve();
const t = (key, vars) => KaraokeI18n.t(lang, key, vars);

// Command name in manifest.json → label key in i18n.js
const COMMAND_LABELS = {
  'key-up': 'infoCmdKeyUp',
  'key-down': 'infoCmdKeyDown',
  'toggle-vocal': 'infoCmdVocal',
  'toggle-lyrics': 'infoCmdLyrics',
  'speed-up': 'infoCmdSpeedUp',
  'speed-down': 'infoCmdSpeedDown',
};
let commands = [];

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const btn of document.querySelectorAll('.lang button')) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  document.title = `${t('infoPageTitle')} – Karaoke for YouTube`;
  renderShortcuts();
}

// "Alt+Shift+Up" → <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd>; macOS gives "⌥⇧↑" without separators
function keyParts(shortcut) {
  const arrows = { Up: '↑', Down: '↓', Left: '←', Right: '→' };
  const parts = shortcut.includes('+') ? shortcut.split('+') : [...shortcut];
  return parts.map((p) => arrows[p] || p);
}

function renderShortcuts() {
  const body = $('shortcutRows');
  body.textContent = '';
  for (const c of commands) {
    if (!COMMAND_LABELS[c.name]) continue;
    const tr = document.createElement('tr');
    const action = document.createElement('td');
    action.textContent = t(COMMAND_LABELS[c.name]);
    const keys = document.createElement('td');
    if (c.shortcut) {
      keyParts(c.shortcut).forEach((p, i) => {
        if (i) keys.append('+');
        const k = document.createElement('kbd');
        k.textContent = p;
        keys.append(k);
      });
    } else {
      const s = document.createElement('span');
      s.className = 'unset';
      s.textContent = t('infoShortcutUnset');
      keys.append(s);
    }
    tr.append(action, keys);
    body.append(tr);
  }
}

function loadCommands() {
  chrome.commands.getAll((list) => {
    // Chrome's order is arbitrary; show them in the same order as COMMAND_LABELS
    const order = Object.keys(COMMAND_LABELS);
    commands = (list || []).sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    renderShortcuts();
  });
}

$('openShortcuts').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

for (const btn of document.querySelectorAll('.lang button')) {
  btn.addEventListener('click', () => {
    lang = btn.dataset.lang;
    applyLanguage();
    chrome.storage.local.set({ uiLang: lang });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.uiLang) {
    lang = KaraokeI18n.resolve(changes.uiLang.newValue);
    applyLanguage();
  }
});

// Shortcuts may be changed on chrome://extensions/shortcuts in another tab; refresh when we're back
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadCommands();
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;
chrome.storage.local.get('uiLang', ({ uiLang }) => {
  lang = KaraokeI18n.resolve(uiLang);
  applyLanguage();
});
applyLanguage();
loadCommands();

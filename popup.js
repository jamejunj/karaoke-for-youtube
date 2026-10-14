const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1, showLyrics: false, lyricsOverlay: true, lyricsStyle: 'panel', lyricsWipe: true, lyricsBg: true, lyricsHl: '#ffd23f', lyricsFg: '#ffffff', lyricsPreferCC: true };
const MIN_KEY = -12;
const MAX_KEY = 12;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const SPEED_STEP = 0.05;
const clampSpeed = (v) => Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)) * 100) / 100;

const $ = (id) => document.getElementById(id);
let settings = { ...DEFAULTS };
let lang = KaraokeI18n.resolve();
let lastStatus = null;

const t = (key, vars) => KaraokeI18n.t(lang, key, vars);

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
  for (const el of document.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const btn of document.querySelectorAll('.lang button')) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  render();
  if (lastStatus) showStatus(lastStatus);
  if (lyricsState) renderLyrics(lyricsState);
  if (shownResults) renderResults(shownResults);
}

function render() {
  const n = settings.semitones;
  $('keyValue').textContent = n > 0 ? `+${n}` : String(n).replace('-', '−');
  $('keyLabel').textContent = n === 0 ? t('keyOriginal') : t('keyShift', { n });
  $('keySlider').value = n;
  $('keyDown').disabled = n <= MIN_KEY;
  $('keyUp').disabled = n >= MAX_KEY;
  $('keyReset').disabled = n === 0;

  const sp = settings.speed;
  $('speedValue').textContent = `${sp.toFixed(2)}×`;
  $('speedLabel').textContent = sp === 1 ? t('speedNormal') : t('speedChange', { n: Math.round((sp - 1) * 100) });
  $('speedSlider').value = sp;
  $('speedDown').disabled = sp <= MIN_SPEED;
  $('speedUp').disabled = sp >= MAX_SPEED;
  $('speedReset').disabled = sp === 1;

  const strength = settings.vocalStrength;
  const extra = strength > 100;
  $('vocalToggle').checked = settings.vocalRemoval;
  $('vocalStrength').value = strength;
  $('strengthValue').textContent = extra ? `${strength}% · ${t('strengthExtra')}` : `${strength}%`;
  $('vocalHint').textContent = t(extra ? 'vocalHintExtra' : 'vocalHint');
  $('strengthRow').classList.toggle('off', !settings.vocalRemoval);

  $('lyricsToggle').checked = settings.showLyrics;
  renderLook();
}

function save(patch) {
  settings = { ...settings, ...patch };
  settings.semitones = Math.max(MIN_KEY, Math.min(MAX_KEY, settings.semitones));
  settings.speed = clampSpeed(settings.speed);
  render();
  chrome.storage.local.set({ settings });
}

$('keyDown').addEventListener('click', () => save({ semitones: settings.semitones - 1 }));
$('keyUp').addEventListener('click', () => save({ semitones: settings.semitones + 1 }));
$('keyReset').addEventListener('click', () => save({ semitones: 0 }));
$('keySlider').addEventListener('input', (e) => save({ semitones: Number(e.target.value) }));
$('speedDown').addEventListener('click', () => save({ speed: settings.speed - SPEED_STEP }));
$('speedUp').addEventListener('click', () => save({ speed: settings.speed + SPEED_STEP }));
$('speedReset').addEventListener('click', () => save({ speed: 1 }));
$('speedSlider').addEventListener('input', (e) => save({ speed: Number(e.target.value) }));
$('vocalToggle').addEventListener('change', (e) => save({ vocalRemoval: e.target.checked }));
$('vocalStrength').addEventListener('input', (e) => save({ vocalStrength: Number(e.target.value) }));
$('lyricsToggle').addEventListener('change', (e) => save({ showLyrics: e.target.checked }));

for (const btn of document.querySelectorAll('.lang button')) {
  btn.addEventListener('click', () => {
    lang = btn.dataset.lang;
    applyLanguage();
    chrome.storage.local.set({ uiLang: lang });
  });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.settings) {
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    render();
  }
  if (changes.uiLang) {
    lang = KaraokeI18n.resolve(changes.uiLang.newValue);
    applyLanguage();
  }
});

// ---------- status of the current tab ----------
const STATUS = {
  idle: ['statusIdle', ''],
  bypass: ['statusBypass', ''],
  active: ['statusActive', 'ok'],
  'waiting-gesture': ['statusGesture', 'warn'],
  error: ['statusError', 'warn'],
  'no-tab': ['statusNoTab', 'warn'],
  'no-video': ['statusNoVideo', 'warn'],
  disconnected: ['statusDisconnected', 'warn'],
  'needs-refresh': ['statusNeedsRefresh', 'warn'],
};

function showStatus(res) {
  lastStatus = res;
  const [key, cls] = STATUS[res.status] || STATUS.idle;
  const text = t(key);
  const el = $('status');
  el.textContent = res.status === 'error' && res.error ? `${text}: ${res.error}` : text;
  el.className = `status ${cls}`;
}

const YOUTUBE_RE = /^https:\/\/(www|m|music)\.youtube\.com\//;
const CONTENT_SCRIPTS = ['i18n.js', 'lyrics-core.js', 'content.js', 'lyrics.js'];
let connection = 'unknown'; // ok | disconnected (YouTube tab not answering) | not-youtube
const injectedTabs = new Set();

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function activeTabId() {
  return (await activeTab())?.id;
}

async function sendTab(msg) {
  const id = await activeTabId();
  if (!id) return null;
  return new Promise((resolve) =>
    chrome.tabs.sendMessage(id, msg, (res) => resolve(chrome.runtime.lastError ? null : res || null))
  );
}

// After the extension is reloaded/updated, YouTube tabs that were already open lose their
// content scripts until refreshed. Re-inject them once so the popup works without a refresh.
async function reconnect(tab) {
  if (injectedTabs.has(tab.id)) return false;
  injectedTabs.add(tab.id);
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['yt-bridge.js'], world: 'MAIN' });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_SCRIPTS });
    return true;
  } catch (err) {
    console.warn('[YouTube Karaoke] re-inject failed', err);
    return false;
  }
}

async function refreshStatus() {
  const tab = await activeTab();
  const isYouTube = !!(tab && tab.url && YOUTUBE_RE.test(tab.url));
  let res = await sendTab({ type: 'karaoke:status' });
  if (!res && isYouTube && (await reconnect(tab))) res = await sendTab({ type: 'karaoke:status' });

  connection = res ? 'ok' : isYouTube ? 'disconnected' : 'not-youtube';
  $('reloadTab').hidden = !(connection === 'disconnected' || (res && res.status === 'needs-refresh'));
  if (!res) showStatus({ status: isYouTube ? 'disconnected' : 'no-tab' });
  else if (!res.hasVideo) showStatus({ status: 'no-video' });
  else showStatus(res);
  renderLyrics(res ? await sendTab({ type: 'lyrics:state' }) : null);
}

$('reloadTab').addEventListener('click', async () => {
  const id = await activeTabId();
  if (!id) return;
  injectedTabs.delete(id);
  chrome.tabs.reload(id);
});

// ---------- lyrics ----------
let lyricsState = null;
let shownResults = null; // results currently listed: { items, fromSearch }
let searchPrefilled = false;

const fmtTime = (s) => (s ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

function sourceLabel(src) {
  if (!src) return '';
  if (src.kind === 'custom' && !src.trackName && !src.artistName) return t('lyricsCustom');
  const name = KaraokeLyrics.displayName(src);
  return src.selfSynced ? t('selfSynced', { name }) : name;
}

// Badge + detail line: [badge class, badge key, detail text, show retry]
function lyricsStatusView(st) {
  if (!st) {
    if (!settings.showLyrics) return ['', 'lyricsBadgeOff', t('lyricsOff'), false];
    if (connection === 'disconnected') return ['fail', 'lyricsBadgeDisconnected', t('statusDisconnected'), false];
    return ['', 'lyricsBadgeNoVideo', t('statusNoTab'), false];
  }
  if (!st.show) return ['', 'lyricsBadgeOff', t('lyricsOff'), false];
  if (!st.videoId) return ['', 'lyricsBadgeNoVideo', t('lyricsNoVideo'), false];
  switch (st.status) {
    case 'found': {
      const name = sourceLabel(st.source);
      return ['ok', 'lyricsBadgeOk', t('lyricsDetailOk', { synced: st.synced, n: st.lineCount, name }), false];
    }
    case 'notfound':
      return ['fail', 'lyricsBadgeFail', t('lyricsDetailNotFound'), true];
    case 'error':
      return ['fail', 'lyricsBadgeFail', t('lyricsDetailError', { e: st.error }), true];
    case 'searching':
      return ['loading', 'lyricsBadgeLoading', t('lyricsSearching'), false];
    default:
      return ['loading', 'lyricsBadgeLoading', t('lyricsWaiting'), false];
  }
}

function renderLyrics(st) {
  lyricsState = st;
  const [cls, badgeKey, detail, retry] = lyricsStatusView(st);
  $('lyrBadge').className = `badge ${cls}`;
  $('lyrBadge').textContent = t(badgeKey);
  $('lyrDetail').textContent = detail;
  $('lyrRetry').hidden = !retry;

  const active = !!(st && st.show && st.videoId);
  $('lyricsTools').hidden = !active;
  $('overlayToggle').checked = settings.lyricsOverlay !== false;
  $('preferCCToggle').checked = settings.lyricsPreferCC !== false;
  $('styleRow').hidden = settings.lyricsOverlay === false;
  for (const b of document.querySelectorAll('[data-style]')) b.setAttribute('aria-pressed', String(b.dataset.style === (settings.lyricsStyle === 'lines' ? 'lines' : 'panel')));
  if (active) {
    if (!searchPrefilled && st.query) {
      $('searchInput').value = st.query;
      searchPrefilled = true;
    }
    if (st.status === 'notfound' && !$('searchBox').open && !$('pasteBox').open) $('searchBox').open = true;
    if (!shownResults?.fromSearch && st.candidates?.length) renderResults({ items: st.candidates, fromSearch: false });
  }
  $('offsetRow').hidden = !(st && st.status === 'found' && st.synced);
  if (st) $('offValue').textContent = t('offsetValue', { n: st.offset || 0 });
  syncViewer(active && st.status === 'found' ? st.docKey : null);
}

// ---------- lyrics viewer in the popup ----------
let viewerKey = null; // docKey of the lyrics currently rendered in the viewer
let viewerLines = null;
let viewerSynced = false;
let viewerCur = -2;
let viewerScrollAt = 0;

async function syncViewer(docKey) {
  if (docKey === viewerKey) return;
  viewerKey = docKey;
  viewerCur = -2;
  const box = $('viewer');
  box.textContent = '';
  if (docKey == null) {
    box.hidden = true;
    $('viewerHint').hidden = true;
    viewerLines = null;
    return;
  }
  const res = await sendTab({ type: 'lyrics:lines' });
  if (!res || res.docKey !== viewerKey) return;
  viewerLines = res.lines;
  viewerSynced = res.synced;
  const frag = document.createDocumentFragment();
  for (const line of res.lines) {
    if (res.synced) {
      const b = document.createElement('button');
      b.type = 'button';
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = fmtTime(line.t) || '0:00';
      const tx = document.createElement('span');
      tx.className = 'tx';
      tx.textContent = line.text || '♪';
      b.append(ts, tx);
      b.addEventListener('click', () => sendTab({ type: 'lyrics:seek', t: line.t }).then(updateViewerPos));
      frag.append(b);
    } else {
      const p = document.createElement('p');
      p.textContent = line;
      frag.append(p);
    }
  }
  box.append(frag);
  box.hidden = false;
  box.scrollTop = 0;
  $('viewerHint').textContent = t(res.synced ? 'viewerHint' : 'popupPlainHint');
  $('viewerHint').hidden = false;
  updateViewerPos();
}

async function updateViewerPos() {
  if (!viewerLines || !viewerSynced || $('viewer').hidden) return;
  const pos = await sendTab({ type: 'lyrics:pos' });
  if (!pos || !viewerLines) return;
  const idx = KaraokeLyrics.lineAt(viewerLines, pos.t);
  if (idx === viewerCur) return;
  viewerCur = idx;
  const box = $('viewer');
  [...box.children].forEach((el, i) => {
    el.classList.toggle('cur', i === idx);
    el.classList.toggle('past', i < idx);
  });
  // Follow the song unless the user scrolled the list in the last few seconds
  const cur = box.children[Math.max(0, idx)];
  if (cur && performance.now() - viewerScrollAt > 3000) {
    box.scrollTo({ top: cur.offsetTop - box.clientHeight / 2 + cur.offsetHeight / 2, behavior: 'smooth' });
  }
}

$('viewer').addEventListener('wheel', () => (viewerScrollAt = performance.now()), { passive: true });
$('viewer').addEventListener('pointerdown', () => (viewerScrollAt = performance.now()));
setInterval(updateViewerPos, 300);

$('lyrRetry').addEventListener('click', async () => {
  await sendTab({ type: 'lyrics:retry' });
  refreshStatus();
});
$('overlayToggle').addEventListener('change', (e) => save({ lyricsOverlay: e.target.checked }));
$('preferCCToggle').addEventListener('change', async (e) => {
  save({ lyricsPreferCC: e.target.checked });
  // re-run the automatic choice with the new preference (keeps lyrics you picked or pasted)
  if (!lyricsState || !lyricsState.source || lyricsState.source.kind !== 'custom') await sendTab({ type: 'lyrics:auto' });
});
for (const b of document.querySelectorAll('[data-style]')) b.addEventListener('click', () => save({ lyricsStyle: b.dataset.style }));

// ---------- lyrics look: running highlight, panel background, colours ----------
function renderLook() {
  $('lookBox').hidden = settings.lyricsOverlay === false;
  $('wipeToggle').checked = settings.lyricsWipe !== false;
  $('bgToggle').checked = settings.lyricsBg !== false;
  if (document.activeElement !== $('hlColor')) $('hlColor').value = settings.lyricsHl || DEFAULTS.lyricsHl;
  if (document.activeElement !== $('fgColor')) $('fgColor').value = settings.lyricsFg || DEFAULTS.lyricsFg;
  const pv = $('lookPreview');
  pv.style.setProperty('--hl', settings.lyricsHl || DEFAULTS.lyricsHl);
  pv.style.setProperty('--fg', settings.lyricsFg || DEFAULTS.lyricsFg);
  pv.classList.toggle('nowipe', settings.lyricsWipe === false);
  pv.classList.toggle('bg', settings.lyricsBg !== false);
  $('colorReset').disabled = (settings.lyricsHl || DEFAULTS.lyricsHl) === DEFAULTS.lyricsHl && (settings.lyricsFg || DEFAULTS.lyricsFg) === DEFAULTS.lyricsFg;
}

$('wipeToggle').addEventListener('change', (e) => save({ lyricsWipe: e.target.checked }));
$('bgToggle').addEventListener('change', (e) => save({ lyricsBg: e.target.checked }));
$('hlColor').addEventListener('input', (e) => save({ lyricsHl: e.target.value }));
$('fgColor').addEventListener('input', (e) => save({ lyricsFg: e.target.value }));
$('colorReset').addEventListener('click', () => save({ lyricsHl: DEFAULTS.lyricsHl, lyricsFg: DEFAULTS.lyricsFg }));

function renderResults(res) {
  shownResults = res;
  const list = $('results');
  list.textContent = '';
  const currentId = lyricsState?.source?.kind === 'lrclib' ? lyricsState.source.id : null;
  for (const r of res.items) {
    const synced = r.synced ?? !!r.syncedLyrics;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const title = document.createElement('span');
    title.className = 't';
    title.textContent = KaraokeLyrics.displayName(r) || '?';
    const m = document.createElement('span');
    m.className = 'm';
    const kind = document.createElement('span');
    kind.className = synced ? 's' : '';
    kind.textContent = synced ? t('resultSynced') : t('resultPlain');
    m.append(`${fmtTime(r.duration)} · `, kind);
    if (r.id === currentId) {
      const cur = document.createElement('span');
      cur.className = 'cur';
      cur.textContent = ` · ${t('resultCurrent')}`;
      m.append(cur);
    }
    btn.append(title, m);
    btn.addEventListener('click', async () => {
      await sendTab(res.fromSearch ? { type: 'lyrics:use', record: r } : { type: 'lyrics:use', id: r.id });
      refreshStatus();
    });
    li.append(btn);
    list.append(li);
  }
}

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('searchInput').value.trim();
  if (!q) return;
  $('searchMsg').textContent = t('searchBusy');
  chrome.runtime.sendMessage({ type: 'lyrics:bg:search', q }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      $('searchMsg').textContent = `${t('lyricsError')}${res && res.error ? `: ${res.error}` : ''}`;
      return;
    }
    const items = res.results.filter((r) => !r.instrumental && (r.syncedLyrics || r.plainLyrics));
    $('searchMsg').textContent = items.length ? '' : t('searchNone');
    renderResults({ items, fromSearch: true });
  });
});

$('pasteSave').addEventListener('click', async () => {
  const text = $('pasteText').value.trim();
  if (!text) return;
  await sendTab({ type: 'lyrics:custom', text });
  $('pasteBox').open = false;
  refreshStatus();
});

$('offEarlier').addEventListener('click', async () => {
  await sendTab({ type: 'lyrics:offset', delta: 0.5 });
  refreshStatus();
});
$('offLater').addEventListener('click', async () => {
  await sendTab({ type: 'lyrics:offset', delta: -0.5 });
  refreshStatus();
});
$('lyricsAuto').addEventListener('click', async () => {
  shownResults = null;
  $('results').textContent = '';
  await sendTab({ type: 'lyrics:auto' });
  refreshStatus();
});

$('version').textContent = `v${chrome.runtime.getManifest().version}`;

chrome.storage.local.get(['settings', 'uiLang'], ({ settings: saved, uiLang }) => {
  settings = { ...DEFAULTS, ...saved };
  lang = KaraokeI18n.resolve(uiLang);
  applyLanguage();
});
applyLanguage();
refreshStatus();
setInterval(refreshStatus, 1000);

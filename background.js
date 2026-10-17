importScripts('lyrics-core.js');

const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1, showLyrics: false, lyricsOverlay: true, lyricsStyle: 'panel', lyricsWipe: true, lyricsBg: true, lyricsHl: '#ffd23f', lyricsFg: '#ffffff', lyricsPreferCC: true, queueAutoplay: true };
const MIN_KEY = -12;
const MAX_KEY = 12;
const MIN_SPEED = 0.5;
const MAX_SPEED = 2;
const SPEED_STEP = 0.05;
const clampSpeed = (v) => Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, v)) * 100) / 100;

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULTS, ...settings };
}

function updateBadge(s) {
  let text = '';
  if (s.semitones !== 0) text = (s.semitones > 0 ? '+' : '') + s.semitones;
  if (s.vocalRemoval) text += 'V';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: '#e5243b' });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
}

chrome.runtime.onInstalled.addListener(async () => updateBadge(await getSettings()));
chrome.runtime.onStartup.addListener(async () => updateBadge(await getSettings()));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) updateBadge({ ...DEFAULTS, ...changes.settings.newValue });
});

chrome.commands.onCommand.addListener(async (command) => {
  const s = await getSettings();
  if (command === 'key-up') s.semitones = Math.min(MAX_KEY, s.semitones + 1);
  else if (command === 'key-down') s.semitones = Math.max(MIN_KEY, s.semitones - 1);
  else if (command === 'toggle-vocal') s.vocalRemoval = !s.vocalRemoval;
  else if (command === 'speed-up') s.speed = clampSpeed(s.speed + SPEED_STEP);
  else if (command === 'speed-down') s.speed = clampSpeed(s.speed - SPEED_STEP);
  else if (command === 'toggle-lyrics') s.showLyrics = !s.showLyrics;
  else return;
  await chrome.storage.local.set({ settings: s });
});

// ---------- lyrics (LRCLIB) ----------
const LRCLIB = 'https://lrclib.net/api';
const MAX_AUTO_QUERIES = 4;

async function lrclib(path, params, retries = 1) {
  const url = new URL(LRCLIB + path);
  for (const [k, v] of Object.entries(params || {})) if (v) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { 'Lrclib-Client': `YouTube Karaoke Extension v${chrome.runtime.getManifest().version}` },
  });
  if (res.status === 404) return null;
  if (res.status >= 500 && retries > 0) {
    await new Promise((r) => setTimeout(r, 1000));
    return lrclib(path, params, retries - 1);
  }
  if (!res.ok) throw new Error(`LRCLIB ${res.status}`);
  return res.json();
}

// Try queries from most to least specific; stop at the first synced match with a close duration
async function findLyrics(meta) {
  const queries = KaraokeLyrics.buildQueries(meta).slice(0, MAX_AUTO_QUERIES);
  const seen = new Map();
  let best = null;
  let lastError = null;
  let succeeded = 0;
  for (const q of queries) {
    let results;
    try {
      results = (await lrclib('/search', q)) || [];
      succeeded++;
    } catch (err) {
      lastError = err;
      continue;
    }
    for (const r of results) if (!seen.has(r.id)) seen.set(r.id, KaraokeLyrics.slim(r));
    best = KaraokeLyrics.pickBest([...seen.values()], meta.duration);
    if (KaraokeLyrics.isGoodMatch(best, meta.duration)) break;
  }
  if (!succeeded && lastError) throw lastError;
  return { best, candidates: [...seen.values()].slice(0, 30), queries };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('lyrics:bg:')) return;
  const job =
    msg.type === 'lyrics:bg:find'
      ? findLyrics(msg.meta)
      : msg.type === 'lyrics:bg:search'
        ? lrclib('/search', { q: msg.q }).then((r) => ({ results: (r || []).map(KaraokeLyrics.slim) }))
        : msg.type === 'lyrics:bg:get'
          ? lrclib(`/get/${encodeURIComponent(msg.id)}`).then((r) => ({ record: r && KaraokeLyrics.slim(r) }))
          : Promise.reject(new Error('unknown message'));
  job.then(
    (data) => sendResponse({ ok: true, ...data }),
    (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
  );
  return true;
});
// ---------- karaoke queue ----------
// Stored as `queue`: [{ key, videoId, title, channel }]. All edits go through withQueue() so
// concurrent requests (popup, context menu, a tab finishing a song) can't overwrite each other.
const QUEUE_KEY = 'queue';
let queueLock = Promise.resolve();

function withQueue(fn) {
  const run = queueLock.then(async () => {
    const q = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY] || [];
    const result = await fn(q);
    await chrome.storage.local.set({ [QUEUE_KEY]: q });
    return result;
  });
  queueLock = run.catch(() => {});
  return run;
}

// Title and channel from YouTube's oEmbed endpoint (falls back to the bare ID)
async function videoInfo(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
    const res = await fetch(url);
    if (!res.ok) return {};
    const j = await res.json();
    return { title: j.title, channel: j.author_name };
  } catch {
    return {};
  }
}

async function queueAdd(videoId, info) {
  if (!videoId) return { ok: false, error: 'bad-link' };
  const meta = info && info.title ? info : await videoInfo(videoId);
  return withQueue((q) => {
    if (q.some((x) => x.videoId === videoId)) return { ok: false, error: 'exists', size: q.length };
    q.push({ key: crypto.randomUUID(), videoId, title: meta.title || videoId, channel: meta.channel || '' });
    return { ok: true, size: q.length, title: meta.title || videoId };
  });
}

// Remove an item (the first one by default) and remember it as "now playing" for the tab's toast
function queueTake(key) {
  return withQueue(async (q) => {
    const i = key ? q.findIndex((x) => x.key === key) : 0;
    if (i < 0 || !q[i]) return { item: null };
    const [item] = q.splice(i, 1);
    await chrome.storage.local.set({ queueNow: { videoId: item.videoId, title: item.title, at: Date.now() } });
    return { item };
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('queue:') || msg.type === 'queue:toast') return;
  let job;
  switch (msg.type) {
    case 'queue:add':
      job = queueAdd(msg.videoId || KaraokeLyrics.parseVideoId(msg.input), msg.title ? { title: msg.title, channel: msg.channel } : null);
      break;
    case 'queue:take':
      job = queueTake(msg.key);
      break;
    case 'queue:remove':
      job = withQueue((q) => {
        const i = q.findIndex((x) => x.key === msg.key);
        if (i >= 0) q.splice(i, 1);
        return { ok: i >= 0 };
      });
      break;
    case 'queue:move':
      job = withQueue((q) => {
        const i = q.findIndex((x) => x.key === msg.key);
        const j = i + (msg.delta < 0 ? -1 : 1);
        if (i < 0 || j < 0 || j >= q.length) return { ok: false };
        [q[i], q[j]] = [q[j], q[i]];
        return { ok: true };
      });
      break;
    case 'queue:clear':
      job = withQueue((q) => {
        q.length = 0;
        return { ok: true };
      });
      break;
    default:
      return;
  }
  job.then(sendResponse, (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
  return true;
});

// Right-click a YouTube video link/thumbnail (or the watch page itself) → add to the queue
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'queue-add-link',
      title: chrome.i18n.getMessage('ctxQueueAdd'),
      contexts: ['link'],
      targetUrlPatterns: ['*://*.youtube.com/watch*', '*://youtu.be/*', '*://*.youtube.com/shorts/*'],
    });
    chrome.contextMenus.create({
      id: 'queue-add-page',
      title: chrome.i18n.getMessage('ctxQueueAddPage'),
      contexts: ['page', 'video'],
      documentUrlPatterns: ['*://*.youtube.com/watch*'],
    });
  });
}
chrome.runtime.onInstalled.addListener(setupMenus);
chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const url = info.menuItemId === 'queue-add-link' ? info.linkUrl : info.pageUrl || (tab && tab.url);
  const res = await queueAdd(KaraokeLyrics.parseVideoId(url));
  if (tab && tab.id >= 0) chrome.tabs.sendMessage(tab.id, { type: 'queue:toast', result: res }, () => void chrome.runtime.lastError);
});
// Welcome: show the guide once, right after a fresh install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});
// ---------- toolbar icon: colour on YouTube, grey elsewhere ----------
// The manifest's default action icon is grey; YouTube tabs get the colour icon as a per-tab override.
// Tab URLs are only visible for sites we have host access to, which is exactly the YouTube hosts.
const ICON_ON = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
const ICON_OFF = { 16: 'icons/icon-gray16.png', 32: 'icons/icon-gray32.png', 48: 'icons/icon-gray48.png', 128: 'icons/icon-gray128.png' };
const isYouTubeUrl = (url) => /^https:\/\/(www|m|music)\.youtube\.com\//.test(url || '');

function paintIcon(tab) {
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) return;
  chrome.action.setIcon({ tabId: tab.id, path: isYouTubeUrl(tab.url) ? ICON_ON : ICON_OFF }).catch(() => {});
}

function paintAllTabs() {
  chrome.tabs.query({}, (tabs) => (tabs || []).forEach(paintIcon));
}

chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  if (change.url || change.status) paintIcon(tab);
});
chrome.runtime.onInstalled.addListener(paintAllTabs);
chrome.runtime.onStartup.addListener(paintAllTabs);
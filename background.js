importScripts('lyrics-core.js');

const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1, showLyrics: false, lyricsOverlay: true, lyricsStyle: 'panel', lyricsWipe: true, lyricsBg: true, lyricsHl: '#ffd23f', lyricsFg: '#ffffff' };
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
// Lyrics overlay: finds lyrics for the current video (LRCLIB via background),
// shows synced lines karaoke-style over the player, or a scrollable panel for plain text.
(() => {
  // Newest copy wins. After an extension reload the old copy in an open tab is orphaned but keeps
  // running (and may share this isolated world's globals), and the popup re-injects a fresh copy.
  // Each copy claims the page via a DOM attribute; older copies see the takeover event and shut down.
  const instanceId = Math.random().toString(36).slice(2);
  const OWNER_ATTR = 'data-yt-karaoke-lyrics';
  let dead = false;
  document.documentElement.setAttribute(OWNER_ATTR, instanceId);
  document.dispatchEvent(new Event('yt-karaoke-lyrics-takeover'));
  document.addEventListener('yt-karaoke-lyrics-takeover', () => {
    if (document.documentElement.getAttribute(OWNER_ATTR) !== instanceId) teardown();
  });

  const L = KaraokeLyrics;
  const I = KaraokeI18n;
  const OFFSET_STEP = 0.5;
  const META_WAIT_MS = 1500;

  let lang = I.resolve();
  const t = (k, v) => I.t(lang, k, v);

  let show = false; // lyrics loading enabled (popup switch)
  let overlayOn = true; // also draw them over the video
  let preferCC = true; // use the video's own uploaded captions before LRCLIB
  let docVersion = 0; // bumps whenever the loaded lyrics change
  let videoId = null;
  let status = 'off'; // off | waiting | searching | found | notfound | error | no-video
  let lastError = '';
  let doc = null; // parsed lyrics: { synced, lines }
  let source = null; // { kind: 'lrclib' | 'custom', id, trackName, artistName }
  let offset = 0; // seconds; positive = lyrics appear earlier
  let candidates = [];
  let meta = null;
  let loadToken = 0;
  let loadTimer = 0;

  const isMusic = location.hostname === 'music.youtube.com';
  const pickKey = (id) => `lyrics:${id}`;
  const video = () => document.querySelector('#movie_player video, .html5-video-player video, video');

  function currentVideoId() {
    const u = new URL(location.href);
    return u.searchParams.get('v') || null;
  }

  // ---------- metadata ----------
  function readMeta() {
    const v = video();
    const duration = v && Number.isFinite(v.duration) ? v.duration : 0;
    const ms = navigator.mediaSession && navigator.mediaSession.metadata;
    let title = '';
    let channel = '';
    let artist = '';
    if (isMusic) {
      title = (ms && ms.title) || document.querySelector('ytmusic-player-bar .title')?.textContent || '';
      artist = (ms && ms.artist) || '';
      channel = artist;
    } else {
      const flexy = document.querySelector('ytd-watch-flexy');
      if (flexy && flexy.getAttribute('video-id') === videoId) {
        title = flexy.querySelector('ytd-watch-metadata h1')?.textContent || '';
        channel = flexy.querySelector('ytd-watch-metadata ytd-channel-name a')?.textContent || '';
      }
      if (!title && ms) {
        title = ms.title || '';
        channel = ms.artist || '';
      }
      if (!title) title = document.title.replace(/\s*-\s*YouTube$/, '');
    }
    return { title: title.trim(), artist: artist.trim(), channel: channel.trim(), duration, isMusic };
  }

  // ---------- loading ----------
  const sendBg = (msg) =>
    new Promise((resolve) =>
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res || { ok: false }))
    );

  function setDoc(text, src) {
    const parsed = L.parseLrc(text);
    if (!parsed.lines.length) {
      doc = null;
      source = null;
      status = 'notfound';
    } else {
      doc = parsed;
      source = src;
      status = 'found';
    }
    docVersion++;
    rebuildLines();
    renderNow();
  }

  function resetLyrics() {
    loadToken++;
    rec = null;
    clearTimeout(loadTimer);
    doc = null;
    source = null;
    candidates = [];
    meta = null;
    offset = 0;
    lastError = '';
    status = show ? (videoId ? 'waiting' : 'no-video') : 'off';
    docVersion++;
    rebuildLines();
    renderNow();
  }

  // Lyrics the user chose, pasted or synced win over an automatic search still in flight
  function cancelAutoLoad() {
    loadToken++;
    clearTimeout(loadTimer);
  }

  function scheduleLoad(delay = META_WAIT_MS) {
    clearTimeout(loadTimer);
    if (!show || !videoId) return;
    loadTimer = setTimeout(load, delay);
  }

  // ---------- YouTube captions (CC) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Ask yt-bridge.js (page MAIN world) for the player's caption tracks
  function playerCaptions() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).slice(2);
      const done = (value) => {
        document.removeEventListener('yt-karaoke-cc-response', onResponse);
        clearTimeout(timer);
        resolve(value);
      };
      const onResponse = (e) => {
        let d;
        try {
          d = JSON.parse(e.detail);
        } catch {
          return;
        }
        if (d && d.id === id) done(d);
      };
      const timer = setTimeout(() => done(null), 1500);
      document.addEventListener('yt-karaoke-cc-response', onResponse);
      document.dispatchEvent(new CustomEvent('yt-karaoke-cc-request', { detail: id }));
    });
  }

  // Caption tracks for the current video, waiting briefly for the player to switch videos
  async function captionTracks(vid, token) {
    for (let i = 0; i < 6; i++) {
      const r = await playerCaptions();
      if (token !== loadToken) return null;
      if (r && r.videoId === vid) return r;
      await sleep(700);
    }
    return null;
  }

  // YouTube now often returns an empty body for caption URLs without the player's own token.
  // Remember the timedtext requests the player itself makes (they carry that token).
  const signedCaptionUrls = new Map(); // videoId -> URL
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (!e.name.includes('/api/timedtext')) continue;
        try {
          const u = new URL(e.name);
          const v = u.searchParams.get('v');
          if (v) signedCaptionUrls.set(v, u.href);
        } catch {}
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}

  async function fetchJson3(url) {
    try {
      const u = new URL(url, location.origin);
      u.searchParams.set('fmt', 'json3');
      const res = await fetch(u.href, { credentials: 'include' });
      if (!res.ok) return null;
      const body = await res.text();
      return body.trim() ? JSON.parse(body) : null;
    } catch {
      return null;
    }
  }

  // Let the player load captions once (as if CC were pressed) so its signed URL appears, then
  // put the CC button back the way it was.
  async function captureSignedUrl(vid) {
    if (signedCaptionUrls.has(vid)) return signedCaptionUrls.get(vid);
    const btn = document.querySelector('#movie_player .ytp-subtitles-button, .ytp-subtitles-button');
    if (!btn) return null;
    const wasOn = btn.getAttribute('aria-pressed') === 'true';
    if (!wasOn) btn.click();
    for (let i = 0; i < 25 && !signedCaptionUrls.has(vid); i++) await sleep(200);
    if (!wasOn && btn.getAttribute('aria-pressed') === 'true') btn.click();
    return signedCaptionUrls.get(vid) || null;
  }

  async function captionLrc(track, vid) {
    let data = await fetchJson3(track.baseUrl);
    if (!data) {
      const signed = await captureSignedUrl(vid);
      if (signed) {
        // Keep the player's token parameters, switch to the requested track
        const u = new URL(signed);
        const want = new URL(track.baseUrl, location.origin);
        for (const k of ['lang', 'kind', 'name', 'tlang']) {
          if (want.searchParams.has(k)) u.searchParams.set(k, want.searchParams.get(k));
          else u.searchParams.delete(k);
        }
        data = await fetchJson3(u.href);
      }
    }
    return data ? L.json3ToLrc(data) : '';
  }

  const ccName = (track) => `CC · ${track.name || track.lang}${track.kind === 'asr' && !/auto/i.test(track.name) ? ` (${t('ccAuto')})` : ''}`;

  const ccCandidate = (track) => ({
    id: `cc:${track.vssId}`,
    cc: track,
    trackName: ccName(track),
    artistName: 'YouTube',
    duration: (video() && video().duration) || 0,
  });

  // Load a caption track as the lyrics; false if YouTube gave nothing usable
  async function useCaption(track, token, persist) {
    const lrc = await captionLrc(track, videoId);
    if (token !== loadToken || !lrc) return false;
    setDoc(lrc, { kind: 'cc', trackName: ccName(track), artistName: null, lang: track.lang });
    if (persist) savePick({ mode: 'cc', vssId: track.vssId, id: null, text: null, offset: 0 });
    return status === 'found';
  }

  async function load() {
    const token = ++loadToken;
    const vid = videoId;
    const stored = (await chrome.storage.local.get(pickKey(vid)))[pickKey(vid)] || {};
    if (token !== loadToken) return;
    offset = stored.offset || 0;

    if (stored.mode === 'custom' && stored.text) {
      setDoc(stored.text, { kind: 'custom', selfSynced: !!stored.selfSynced, trackName: stored.trackName || null, artistName: stored.artistName || null });
      return;
    }

    status = 'searching';
    renderNow();

    if (stored.mode === 'lrclib' && stored.id) {
      const res = await sendBg({ type: 'lyrics:bg:get', id: stored.id });
      if (token !== loadToken) return;
      if (res.ok && res.record) {
        useRecord(res.record, false);
        return;
      }
    }

    // Caption tracks from the player (empty when the video has no CC)
    const cc = await captionTracks(vid, token);
    if (token !== loadToken) return;
    const ccTracks = (cc && cc.tracks) || [];
    const ccPick = L.pickCaptionTracks(ccTracks, cc && cc.defaultIndex);
    const ccCandidates = ccTracks.map(ccCandidate);

    if (stored.mode === 'cc' && stored.vssId) {
      const track = ccTracks.find((x) => x.vssId === stored.vssId);
      if (track && (await useCaption(track, token, false))) {
        candidates = ccCandidates;
        return;
      }
      if (token !== loadToken) return;
    }

    // Uploaded captions in the song's language usually are the lyrics
    if (preferCC && ccPick.best && (await useCaption(ccPick.best, token, false))) {
      candidates = ccCandidates;
      return;
    }
    if (token !== loadToken) return;

    // Wait until the page shows this video's title and duration
    for (let i = 0; i < 10; i++) {
      meta = readMeta();
      if (meta.title && meta.duration) break;
      await sleep(1000);
      if (token !== loadToken) return;
    }
    const res = await sendBg({ type: 'lyrics:bg:find', meta });
    if (token !== loadToken) return;
    candidates = [...ccCandidates, ...((res.ok && res.candidates) || [])];
    if (res.ok && res.best) {
      useRecord(res.best, false);
      return;
    }
    // Nothing on LRCLIB: fall back to uploaded captions (if not preferred) or auto-generated ones
    for (const track of [preferCC ? null : ccPick.best, ccPick.asr]) {
      if (track && (await useCaption(track, token, false))) return;
      if (token !== loadToken) return;
    }
    if (!res.ok) {
      status = 'error';
      lastError = res.error || '';
    } else status = 'notfound';
    renderNow();
  }

  function useRecord(rec, persist) {
    if (!candidates.some((c) => c.id === rec.id)) candidates.unshift(rec);
    setDoc(rec.syncedLyrics || rec.plainLyrics || '', {
      kind: 'lrclib',
      id: rec.id,
      trackName: rec.trackName,
      artistName: rec.artistName,
    });
    if (persist) savePick({ mode: 'lrclib', id: rec.id });
  }

  // Writes are queued: two quick read-modify-writes would otherwise overwrite each other
  let pickQueue = Promise.resolve();
  function savePick(patch) {
    if (!videoId) return;
    const key = pickKey(videoId);
    pickQueue = pickQueue
      .then(async () => {
        const r = await chrome.storage.local.get(key);
        await chrome.storage.local.set({ [key]: { ...(r[key] || {}), ...patch } });
      })
      .catch(() => {});
  }

  // ---------- overlay ----------
  let host = null;
  let ui = null;
  let observedPlayer = null;
  let playerObserver = null;
  let raf = 0;
  let builtVersion = -1; // docVersion currently rendered into the panel list
  let lastIdx = -2;
  let lastMain = null;
  let userScrollAt = 0;
  let style = 'panel'; // 'panel' = full lyrics, 'lines' = two-line karaoke
  let box = null; // saved panel geometry as fractions of the player: { x, y, w, h }
  let rec = null; // tap-to-sync session: { times: [], next }
  // Look settings from the popup
  const DEFAULT_HL = '#ffd23f';
  const DEFAULT_FG = '#ffffff';
  let look = { wipe: true, bg: true, hl: DEFAULT_HL, fg: DEFAULT_FG };

  const CSS = `
    :host { all: initial; }
    .wrap { --hl: #ffd23f; --fg: #ffffff; position: absolute; inset: 0; pointer-events: none; container-type: size;
            font-family: system-ui, "Segoe UI", "Noto Sans Thai", "Leelawadee UI", Tahoma, sans-serif; }
    [hidden] { display: none !important; }

    /* two-line karaoke */
    .sync { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%);
            width: max-content; max-width: 88%; text-align: center; pointer-events: auto; transition: bottom .2s; }
    .wrap.controls .sync { bottom: 17%; }
    .line { position: relative; display: grid; font-weight: 800; line-height: 1.25; font-size: clamp(18px, 4.4cqw, 60px); }
    .line > span, .ln > span { grid-area: 1 / 1; white-space: pre-wrap; }
    .base { color: var(--fg); -webkit-text-stroke: .06em rgba(0,0,0,.85); paint-order: stroke fill;
            text-shadow: 0 .05em .25em rgba(0,0,0,.6); }
    .hi { color: var(--hl); -webkit-text-stroke: .06em rgba(40,20,0,.9); paint-order: stroke fill;
          clip-path: inset(0 calc(100% - var(--p, 0%)) 0 0); }
    .next { margin-top: .35em; color: color-mix(in srgb, var(--fg) 82%, transparent); font-weight: 700; font-size: clamp(13px, 2.8cqw, 38px);
            -webkit-text-stroke: .05em rgba(0,0,0,.8); paint-order: stroke fill; white-space: pre-wrap; }
    .dots { height: 1em; font-size: clamp(10px, 2cqw, 26px); color: var(--hl); letter-spacing: .3em;
            -webkit-text-stroke: .05em rgba(0,0,0,.8); paint-order: stroke fill; }
    .tools { position: absolute; left: 50%; bottom: 100%; transform: translateX(-50%); display: flex; gap: 2px;
             align-items: center; padding: 4px; margin-bottom: 6px; border-radius: 999px; background: rgba(15,15,18,.85);
             opacity: 0; transition: opacity .15s; white-space: nowrap; }
    .sync:hover .tools, .tools:focus-within { opacity: 1; }

    button.hb { all: unset; cursor: pointer; color: #fff; font-size: 12px; font-weight: 600; line-height: 1;
                padding: 6px 9px; border-radius: 999px; white-space: nowrap; }
    button.hb:hover, button.hb:focus-visible { background: rgba(255,255,255,.18); }
    .off { color: #ffd23f; font-size: 12px; font-weight: 600; padding: 0 2px; min-width: 40px; text-align: center; }

    /* full-lyrics panel: draggable by its header, resizable from the corner */
    .panel { position: absolute; left: 62%; top: 6%; width: 34%; height: 76%;
             min-width: 220px; min-height: 160px; max-width: 100%; max-height: 100%;
             display: flex; flex-direction: column; pointer-events: auto; overflow: hidden;
             background: rgba(10,10,14,.76); backdrop-filter: blur(8px); border-radius: 14px; color: #fff;
             box-shadow: 0 8px 30px rgba(0,0,0,.35); container-type: inline-size; }
    .head { display: flex; align-items: center; gap: 2px; padding: 6px 6px 6px 10px; cursor: grab;
            user-select: none; touch-action: none; }
    .panel.dragging { opacity: .92; }
    .panel.dragging .head { cursor: grabbing; }
    .bar { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; padding: 0 6px 6px; }
    .bar .sp { flex: 1; }
    .grip { font-size: 13px; opacity: .45; letter-spacing: -3px; margin-right: 6px; }
    .name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            font-size: 13px; font-weight: 600; color: rgba(255,255,255,.82); }
    .note { padding: 0 12px 6px; font-size: 12px; color: rgba(255,255,255,.62); }
    .recbar { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; padding: 6px 10px;
              background: rgba(229,36,59,.22); font-size: 12px; }
    .recbar .msg { flex: 1 1 120px; min-width: 0; }
    button.big { all: unset; cursor: pointer; background: #e5243b; color: #fff; font-weight: 700;
                 font-size: 13px; padding: 7px 14px; border-radius: 999px; }
    button.big:focus-visible { outline: 2px solid #fff; }
    .body { position: relative; flex: 1; overflow-y: auto; padding: 18cqh 12px 40cqh; scrollbar-width: thin;
            margin: 0 8px 8px; /* keep the scrollbar clear of the resize edges */ }
    /* resize handles: left / right / bottom edges and both bottom corners */
    .rz { position: absolute; z-index: 2; touch-action: none; }
    .rz-l, .rz-r { top: 14px; bottom: 14px; width: 8px; cursor: ew-resize; }
    .rz-l { left: 0; } .rz-r { right: 0; }
    .rz-b { left: 14px; right: 14px; bottom: 0; height: 8px; cursor: ns-resize; }
    .rz-bl, .rz-br { bottom: 0; width: 16px; height: 16px; }
    .rz-bl { left: 0; cursor: nesw-resize; } .rz-br { right: 0; cursor: nwse-resize; }
    .rz:hover, .panel.dragging .rz { background: rgba(255,210,63,.25); }
    .rz-bl:hover, .rz-br:hover { border-radius: 6px; }
    .ln { position: relative; display: grid; margin: .08em 0; padding: .12em .35em; border-radius: 8px;
          font-size: clamp(14px, 5cqw, 30px); line-height: 1.4; font-weight: 600; color: color-mix(in srgb, var(--fg) 82%, transparent);
          transition: font-size .18s ease, opacity .18s ease; }
    .ln .hi { visibility: hidden; }
    .ln.gap { min-height: .7em; }
    .panel.synced .ln, .panel.recording .ln { cursor: pointer; }
    .panel.synced .ln:hover, .panel.recording .ln:hover { background: rgba(255,255,255,.08); }
    .ln.past { opacity: .4; }
    .ln.cur { font-size: clamp(18px, 7.2cqw, 46px); font-weight: 800; color: var(--fg); opacity: 1; }
    .ln.cur .base { -webkit-text-stroke: .04em rgba(0,0,0,.6); paint-order: stroke fill; text-shadow: none; }
    .ln.cur .hi { visibility: visible; -webkit-text-stroke: .04em rgba(40,20,0,.8); }
    .ln .base { -webkit-text-stroke: 0; text-shadow: none; }
    .ln.tapped { color: #9fe7b8; }
    .ln.nexttap { outline: 2px dashed rgba(255,210,63,.85); outline-offset: -2px; }
    @media (prefers-reduced-motion: reduce) { .ln { transition: none; } }

    /* No running highlight: the current line is simply shown in the highlight colour */
    .wrap.nowipe .hi { clip-path: none; }

    /* No dark panel background: transparent panel, outlined text, controls appear on hover */
    .wrap.nobg .panel { background: transparent; backdrop-filter: none; box-shadow: none; }
    .wrap.nobg .ln .base { -webkit-text-stroke: .06em rgba(0,0,0,.85); paint-order: stroke fill;
                           text-shadow: 0 .05em .25em rgba(0,0,0,.6); }
    .wrap.nobg .ln.cur .hi { -webkit-text-stroke: .06em rgba(40,20,0,.9); }
    .wrap.nobg .head, .wrap.nobg .bar, .wrap.nobg .note { background: rgba(10,10,14,.7); opacity: 0; transition: opacity .15s; }
    .wrap.nobg .head { border-radius: 10px 10px 0 0; }
    .wrap.nobg .panel:hover :is(.head, .bar, .note), .wrap.nobg .panel:focus-within :is(.head, .bar, .note),
    .wrap.nobg .panel.dragging .head, .wrap.nobg .panel.recording :is(.head, .bar) { opacity: 1; }
    .wrap.nobg .body { scrollbar-width: none; }

    .pill { position: absolute; left: 50%; bottom: 12%; transform: translateX(-50%); max-width: 80%;
            padding: 8px 14px; border-radius: 999px; pointer-events: none; background: rgba(15,15,18,.88);
            color: #fff; text-align: center; font-size: clamp(11px, 1.6cqw, 16px); font-weight: 600;
            line-height: 1.35; transition: opacity .3s; }
    .pill.hide { opacity: 0; }
  `;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  function build() {
    host = document.createElement('div');
    host.className = 'yt-karaoke-lyrics';
    host.dataset.owner = instanceId;
    host.style.cssText = 'position:absolute;inset:0;z-index:36;pointer-events:none;';
    const root = host.attachShadow({ mode: 'open' });
    // YouTube enforces Trusted Types, so innerHTML throws — build the tree with DOM APIs
    const css = document.createElement('style');
    css.textContent = CSS;
    // data-k / data-title name i18n keys; labels are (re)applied by applyLabels()
    const hb = (act, label, titleKey) =>
      h('button', { type: 'button', class: 'hb', 'data-act': act, ...(titleKey ? { 'data-title': titleKey } : {}) }, label);
    const kb = (act, key, cls = 'hb') => h('button', { type: 'button', class: cls, 'data-act': act, 'data-k': key });
    root.append(
      css,
      h('div', { class: 'wrap', hidden: '' },
        h('div', { class: 'sync', hidden: '' },
          h('div', { class: 'tools' },
            hb('minus', `−${OFFSET_STEP}s`, 'offsetLater'),
            h('span', { class: 'off' }),
            hb('plus', `+${OFFSET_STEP}s`, 'offsetEarlier'),
            kb('style-panel', 'stylePanel'),
            hb('close', '✕', 'overlayHide')),
          h('div', { class: 'dots' }),
          h('div', { class: 'line' }, h('span', { class: 'base' }), h('span', { class: 'hi', 'aria-hidden': 'true' })),
          h('div', { class: 'next' })),
        h('div', { class: 'panel', hidden: '' },
          // Header row is the drag handle: keep it to grip + name + close so there's room to grab
          h('div', { class: 'head', 'data-title': 'dragHint' },
            h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
            h('span', { class: 'name' }),
            hb('close', '✕', 'overlayHide')),
          h('div', { class: 'bar' },
            hb('minus', `−${OFFSET_STEP}s`, 'offsetLater'),
            h('span', { class: 'off' }),
            hb('plus', `+${OFFSET_STEP}s`, 'offsetEarlier'),
            h('span', { class: 'sp' }),
            kb('rec', 'recStart'),
            kb('style-lines', 'styleLines')),
          h('div', { class: 'note' }),
          h('div', { class: 'recbar', hidden: '' },
            h('span', { class: 'msg' }),
            kb('rec-next', 'recNext', 'big'),
            kb('rec-done', 'recDone'),
            kb('rec-cancel', 'recCancel')),
          h('div', { class: 'body' }),
          ...['l', 'r', 'b', 'bl', 'br'].map((edge) => h('div', { class: `rz rz-${edge}`, 'data-edge': edge, 'aria-hidden': 'true' }))),
        h('div', { class: 'pill hide' }))
    );
    const q = (s) => root.querySelector(s);
    const qa = (s) => [...root.querySelectorAll(s)];
    ui = {
      root,
      wrap: q('.wrap'),
      sync: q('.sync'),
      base: q('.sync .base'),
      hi: q('.sync .hi'),
      line: q('.sync .line'),
      next: q('.sync .next'),
      dots: q('.sync .dots'),
      offs: qa('.off'),
      panel: q('.panel'),
      head: q('.panel .head'),
      bar: q('.panel .bar'),
      name: q('.panel .name'),
      note: q('.panel .note'),
      recbar: q('.recbar'),
      recMsg: q('.recbar .msg'),
      body: q('.panel .body'),
      pill: q('.pill'),
      byAct: (act) => qa(`[data-act="${act}"]`),
    };

    root.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      const ln = e.target.closest('.ln');
      if (btn) onAction(btn.dataset.act);
      else if (ln) onLineClick(Number(ln.dataset.i));
    });
    // Keep clicks/drags on the lyrics from reaching YouTube's player (pause, seek, fullscreen…)
    for (const ev of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'wheel', 'contextmenu']) {
      root.addEventListener(ev, (e) => e.stopPropagation());
    }
    ui.body.addEventListener('wheel', () => (userScrollAt = performance.now()), { passive: true });
    ui.body.addEventListener('touchmove', () => (userScrollAt = performance.now()), { passive: true });
    ui.head.addEventListener('pointerdown', startDrag);
    for (const el of root.querySelectorAll('.rz')) el.addEventListener('pointerdown', (e) => startResize(e, el.dataset.edge));

    applyLabels();
    applyBox();
    applyLook();
  }

  function applyLook() {
    if (!ui) return;
    ui.wrap.classList.toggle('nowipe', !look.wipe);
    ui.wrap.classList.toggle('nobg', !look.bg);
    ui.wrap.style.setProperty('--hl', look.hl);
    ui.wrap.style.setProperty('--fg', look.fg);
  }

  function applyLabels() {
    if (!ui) return;
    for (const el of ui.root.querySelectorAll('[data-k]')) el.textContent = t(el.dataset.k);
    for (const el of ui.root.querySelectorAll('[data-title]')) el.title = t(el.dataset.title);
  }

  function ensureOverlay() {
    const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    if (!player) return false;
    if (!host) build();
    // Overlays left behind by an older copy of this script (orphaned by an extension reload) can no
    // longer be controlled; keep them hidden so only this copy's overlay shows.
    for (const other of document.querySelectorAll('.yt-karaoke-lyrics')) {
      if (other !== host && other.style.display !== 'none') other.style.setProperty('display', 'none', 'important');
    }
    if (host.parentElement !== player) player.appendChild(host);
    if (observedPlayer !== player) {
      playerObserver?.disconnect();
      playerObserver = new MutationObserver(syncPlayerState);
      playerObserver.observe(player, { attributes: true, attributeFilter: ['class'] });
      observedPlayer = player;
      syncPlayerState();
    }
    return true;
  }

  function syncPlayerState() {
    if (!observedPlayer || !ui) return;
    const cl = observedPlayer.classList;
    ui.wrap.classList.toggle('controls', !cl.contains('ytp-autohide'));
    ui.wrap.classList.toggle('ad', cl.contains('ad-showing'));
    renderNow();
  }

  // ---------- panel position / size ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function applyBox() {
    if (!ui || !box) return;
    const w = clamp(box.w, 0.15, 1);
    const hh = clamp(box.h, 0.2, 1);
    const s = ui.panel.style;
    s.width = `${w * 100}%`;
    s.height = `${hh * 100}%`;
    s.left = `${clamp(box.x, 0, 1 - w) * 100}%`;
    s.top = `${clamp(box.y, 0, 1 - hh) * 100}%`;
  }

  function measureBox() {
    const pr = observedPlayer?.getBoundingClientRect();
    const r = ui.panel.getBoundingClientRect();
    if (!pr || !pr.width || !pr.height || !r.width) return null;
    return { x: (r.left - pr.left) / pr.width, y: (r.top - pr.top) / pr.height, w: r.width / pr.width, h: r.height / pr.height };
  }

  function saveBox() {
    const b = measureBox();
    if (!b) return;
    box = b;
    applyBox(); // store as percentages so the panel scales with the player (e.g. fullscreen)
    chrome.storage.local.set({ lyricsPanelBox: box });
  }

  function startDrag(e) {
    if (e.button !== 0 || e.target.closest('button')) return;
    const pr = observedPlayer.getBoundingClientRect();
    const r = ui.panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    ui.head.setPointerCapture(e.pointerId);
    ui.panel.classList.add('dragging');
    const move = (ev) => {
      const x = clamp(ev.clientX - pr.left - dx, 0, pr.width - r.width);
      const y = clamp(ev.clientY - pr.top - dy, 0, pr.height - r.height);
      ui.panel.style.left = `${(x / pr.width) * 100}%`;
      ui.panel.style.top = `${(y / pr.height) * 100}%`;
    };
    const up = () => {
      ui.head.removeEventListener('pointermove', move);
      ui.head.removeEventListener('pointerup', up);
      ui.head.removeEventListener('pointercancel', up);
      ui.panel.classList.remove('dragging');
      saveBox();
    };
    ui.head.addEventListener('pointermove', move);
    ui.head.addEventListener('pointerup', up);
    ui.head.addEventListener('pointercancel', up);
    e.preventDefault();
  }

  // Resize from the left, right or bottom edge, or a bottom corner. edge: 'l' | 'r' | 'b' | 'bl' | 'br'
  const MIN_W = 220;
  const MIN_H = 160;
  function startResize(e, edge) {
    if (e.button !== 0) return;
    const handle = e.currentTarget;
    const pr = observedPlayer.getBoundingClientRect();
    const r = ui.panel.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: r.left - pr.left, top: r.top - pr.top, w: r.width, h: r.height };
    handle.setPointerCapture(e.pointerId);
    ui.panel.classList.add('dragging');
    const move = (ev) => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      let { left, w, h } = start;
      if (edge.includes('r')) w = clamp(start.w + dx, MIN_W, pr.width - start.left);
      if (edge.includes('l')) {
        left = clamp(start.left + dx, 0, start.left + start.w - MIN_W);
        w = start.w + (start.left - left);
      }
      if (edge.includes('b')) h = clamp(start.h + dy, MIN_H, pr.height - start.top);
      const s = ui.panel.style;
      s.left = `${(left / pr.width) * 100}%`;
      s.width = `${(w / pr.width) * 100}%`;
      s.height = `${(h / pr.height) * 100}%`;
      if (!s.top) s.top = `${(start.top / pr.height) * 100}%`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      ui.panel.classList.remove('dragging');
      saveBox();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
    e.preventDefault();
  }

  // ---------- rendering ----------
  let pillTimer = 0;
  let lastPillKey = '';
  function pill(text, sticky) {
    if (!ui) return;
    ui.pill.textContent = text;
    ui.pill.classList.toggle('hide', !text);
    clearTimeout(pillTimer);
    if (text && !sticky) pillTimer = setTimeout(() => ui.pill.classList.add('hide'), 4000);
  }

  function sourceName() {
    if (!source) return '';
    if (source.kind === 'custom') {
      if (!source.trackName && !source.artistName) return t('lyricsCustom');
      const name = L.displayName(source);
      return source.selfSynced ? t('selfSynced', { name }) : name;
    }
    return L.displayName(source);
  }

  const lineTexts = () => (doc ? (doc.synced ? doc.lines.map((l) => l.text) : doc.lines) : []);

  function rebuildLines() {
    if (!ui) return;
    builtVersion = docVersion;
    lastIdx = -2;
    lastMain = null;
    ui.body.textContent = '';
    if (!doc) return;
    const frag = document.createDocumentFragment();
    lineTexts().forEach((text, i) => {
      const shown = text || (doc.synced ? '♪' : '');
      const el = h('div', { class: shown ? 'ln' : 'ln gap', 'data-i': String(i) },
        h('span', { class: 'base' }, shown), h('span', { class: 'hi', 'aria-hidden': 'true' }, shown));
      frag.appendChild(el);
    });
    ui.body.appendChild(frag);
    ui.body.scrollTop = 0;
    if (rec) markRec();
  }

  function formatOffset() {
    const n = Math.round(offset * 10) / 10;
    return `${n > 0 ? '+' : ''}${n.toFixed(1)}s`;
  }

  function renderNow() {
    if (dead) return;
    try {
      render();
    } catch (err) {
      console.error('[YouTube Karaoke] lyrics overlay', err);
      status = 'error';
      lastError = String((err && err.message) || err);
    }
  }

  function render() {
    if (!ensureOverlay()) return;
    const inAd = ui.wrap.classList.contains('ad');
    const visible = show && overlayOn && !!videoId && !inAd;
    ui.wrap.hidden = !visible;
    if (!visible) {
      stopLoop();
      return;
    }

    // Update the status pill only when the status (or the chosen lyrics) changes
    const pillKey = `${status}|${sourceName()}|${lang}`;
    if (pillKey !== lastPillKey) {
      lastPillKey = pillKey;
      if (status === 'searching') pill(t('overlaySearching'), true);
      else if (status === 'notfound') pill(t('overlayNotFound'));
      else if (status === 'error') pill(t('overlayError'));
      else if (status === 'found') pill(t('overlayFound', { name: sourceName() }));
      else pill('');
    }

    const synced = !!(doc && doc.synced);
    const mode = !doc ? 'none' : synced && style === 'lines' && !rec ? 'lines' : 'panel';
    ui.sync.hidden = mode !== 'lines';
    ui.panel.hidden = mode !== 'panel';
    if (!doc) {
      stopLoop();
      return;
    }
    if (builtVersion !== docVersion) rebuildLines();

    ui.name.textContent = sourceName();
    for (const el of ui.offs) {
      el.textContent = formatOffset();
      el.hidden = !synced || !!rec;
    }
    for (const b of [...ui.byAct('minus'), ...ui.byAct('plus')]) b.hidden = !synced || !!rec;
    for (const b of ui.byAct('style-lines')) b.hidden = !synced || !!rec;
    for (const b of ui.byAct('rec')) b.hidden = !!rec;
    ui.panel.classList.toggle('synced', synced && !rec);
    ui.panel.classList.toggle('recording', !!rec);
    ui.note.textContent = !synced && !rec ? t('panelPlainHint') : '';
    ui.note.hidden = !ui.note.textContent;
    ui.recbar.hidden = !rec;
    ui.bar.hidden = !!rec;
    if (rec) updateRecMsg();
    startLoop();
  }

  function startLoop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  function stopLoop() {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function scrollToLine(i, force) {
    if (!force && performance.now() - userScrollAt < 4000) return;
    const el = ui.body.children[Math.max(0, i)];
    if (!el) return;
    const top = el.offsetTop - ui.body.clientHeight / 2 + el.offsetHeight / 2;
    ui.body.scrollTo({ top, behavior: 'smooth' });
  }

  // Karaoke wipe that follows wrapped text: fill the first visual row completely, then the next.
  // A plain horizontal inset() would sweep every wrapped row at the same time.
  function wipeRows(base, hi, p) {
    if (!base || !hi) return;
    if (!look.wipe) {
      if (hi.style.clipPath !== 'none') hi.style.clipPath = 'none';
      return;
    }
    const origin = hi.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(base);
    const rows = [];
    for (const r of range.getClientRects()) {
      if (r.width < 1) continue;
      const top = r.top - origin.top;
      const row = rows.find((x) => Math.abs(x.top - top) < r.height / 2);
      if (row) {
        row.left = Math.min(row.left, r.left - origin.left);
        row.right = Math.max(row.right, r.right - origin.left);
        row.bottom = Math.max(row.bottom, r.bottom - origin.top);
      } else rows.push({ top, bottom: r.bottom - origin.top, left: r.left - origin.left, right: r.right - origin.left });
    }
    rows.sort((a, b) => a.top - b.top);
    const total = rows.reduce((sum, r) => sum + (r.right - r.left), 0);
    let remain = p * total;
    const padX = 6; // room for the text stroke
    const parts = [];
    rows.forEach((r, i) => {
      const w = r.right - r.left;
      const take = Math.min(Math.max(remain, 0), w);
      if (take > 0) {
        // Split overlapping row boxes halfway, so marks above/below a row (Thai vowels, tone marks)
        // light up with their own row, not with the neighbour
        const y0 = i === 0 ? r.top - 4 : (rows[i - 1].bottom + r.top) / 2;
        const y1 = i === rows.length - 1 ? r.bottom + 4 : (r.bottom + rows[i + 1].top) / 2;
        const x0 = (r.left - padX).toFixed(1);
        const x1 = (r.left + take + (take >= w ? padX : 0)).toFixed(1);
        parts.push(`M${x0},${y0.toFixed(1)} H${x1} V${y1.toFixed(1)} H${x0} Z`);
      }
      remain -= w;
    });
    const clip = parts.length ? `path('${parts.join(' ')}')` : 'inset(0 100% 0 0)';
    if (hi.style.clipPath !== clip) hi.style.clipPath = clip;
  }

  function frame() {
    raf = 0;
    const v = video();
    if (!doc || !v || !ui || ui.wrap.hidden) return;
    const now = v.currentTime + offset;

    if (rec) {
      // timing comes from the user's taps
    } else if (doc.synced) {
      const lines = doc.lines;
      const idx = L.lineAt(lines, now);
      const cur = idx >= 0 ? lines[idx] : null;
      const next = lines[idx + 1] || null;
      const lineEnd = next ? next.t : cur ? cur.t + 6 : 0;
      const span = cur ? lineEnd - cur.t : 0;
      // Long instrumental gap after a line, or an empty marker line → show ♪
      const inGap = !cur || !cur.text || (span > 10 && now - cur.t > 7);
      const wipe = inGap || !cur ? 0 : Math.min(1, (now - cur.t) / Math.max(0.5, Math.min(span * 0.92, 8)));

      if (!ui.sync.hidden) {
        const main = inGap ? (cur ? '♪' : '') : cur.text;
        let upcoming = next ? next.text : '';
        if (!cur && lines[0]) upcoming = lines[0].text;
        if (main !== lastMain) {
          setText(ui.base, main);
          setText(ui.hi, main);
          lastMain = main;
        }
        setText(ui.next, upcoming || '');
        wipeRows(ui.base, ui.hi, wipe);
        const nextStart = next ? next.t : cur ? Infinity : lines[0]?.t ?? Infinity;
        const remain = nextStart - now;
        setText(ui.dots, inGap && remain > 0 && remain <= 3 ? '●'.repeat(Math.ceil(remain)) : '');
      }

      if (!ui.panel.hidden) {
        const items = ui.body.children;
        if (idx !== lastIdx) {
          for (let i = 0; i < items.length; i++) {
            items[i].classList.toggle('past', i < idx);
            items[i].classList.toggle('cur', i === idx);
          }
          lastIdx = idx;
          scrollToLine(idx);
        }
        if (items[idx]) wipeRows(items[idx].querySelector('.base'), items[idx].querySelector('.hi'), wipe);
      }
    } else if (!ui.panel.hidden && v.duration && performance.now() - userScrollAt > 6000) {
      // Plain lyrics: follow the song roughly by position
      const body = ui.body;
      const target = (v.currentTime / v.duration) * (body.scrollHeight - body.clientHeight);
      body.scrollTop += (target - body.scrollTop) * 0.05;
    }
    raf = requestAnimationFrame(frame);
  }

  // ---------- overlay actions ----------
  function onAction(act) {
    if (act === 'plus') changeOffset(OFFSET_STEP);
    else if (act === 'minus') changeOffset(-OFFSET_STEP);
    else if (act === 'close') setOverlay(false);
    else if (act === 'style-lines') setStyle('lines');
    else if (act === 'style-panel') setStyle('panel');
    else if (act === 'rec') startRec();
    else if (act === 'rec-next') recTap();
    else if (act === 'rec-done') finishRec();
    else if (act === 'rec-cancel') cancelRec();
  }

  function onLineClick(i) {
    if (!doc || !Number.isInteger(i)) return;
    if (rec) recTapAt(i);
    else if (doc.synced) {
      const v = video();
      if (v) v.currentTime = Math.max(0, doc.lines[i].t - offset);
      userScrollAt = 0;
    }
  }

  // ---------- tap-to-sync ----------
  // For lyrics without timestamps: the user taps each line as it starts; the result is saved
  // as LRC for this video, so it highlights line by line from then on.
  const nextNonEmpty = (from) => {
    const texts = lineTexts();
    for (let i = Math.max(0, from); i < texts.length; i++) if (texts[i]) return i;
    return -1;
  };

  function startRec() {
    if (!doc) return;
    rec = { times: new Array(lineTexts().length).fill(null), next: nextNonEmpty(0) };
    builtVersion = -1;
    renderNow();
    scrollToLine(rec.next, true);
  }

  function recTapAt(i) {
    const v = video();
    if (!v || !rec || !lineTexts()[i]) return;
    rec.times[i] = v.currentTime;
    rec.next = nextNonEmpty(i + 1);
    markRec();
    updateRecMsg();
    if (rec.next >= 0) scrollToLine(rec.next, true);
  }

  function recTap() {
    if (rec && rec.next >= 0) recTapAt(rec.next);
  }

  function markRec() {
    if (!rec || !ui) return;
    const items = ui.body.children;
    for (let i = 0; i < items.length; i++) {
      items[i].classList.toggle('tapped', rec.times[i] != null);
      items[i].classList.toggle('nexttap', i === rec.next);
      items[i].classList.remove('cur', 'past');
    }
  }

  function updateRecMsg() {
    const texts = lineTexts();
    const total = texts.filter(Boolean).length;
    const n = rec.times.filter((x, i) => x != null && texts[i]).length;
    ui.recMsg.textContent = `${t('recHint')} · ${n}/${total}`;
  }

  const fmtLrc = (s) => {
    const m = Math.floor(s / 60);
    const sec = (s - m * 60).toFixed(2).padStart(5, '0');
    return `[${String(m).padStart(2, '0')}:${sec}]`;
  };

  function finishRec() {
    if (!rec) return;
    cancelAutoLoad();
    const texts = lineTexts();
    const idxs = texts.map((x, i) => (x ? i : -1)).filter((i) => i >= 0);
    const tapped = idxs.filter((i) => rec.times[i] != null);
    if (tapped.length < 2) {
      pill(t('recNeedMore'));
      return;
    }
    // Fill untapped lines by interpolating between their tapped neighbours
    const times = idxs.map((i) => {
      if (rec.times[i] != null) return rec.times[i];
      const a = [...tapped].reverse().find((j) => j < i);
      const b = tapped.find((j) => j > i);
      if (a != null && b != null) return rec.times[a] + ((rec.times[b] - rec.times[a]) * (i - a)) / (b - a);
      if (b != null) return Math.max(0, rec.times[b] - (b - i) * 2);
      return rec.times[a] + (i - a) * 3;
    });
    const lrc = idxs
      .map((i, k) => ({ t: times[k], text: texts[i] }))
      .sort((p, q) => p.t - q.t)
      .map((l) => `${fmtLrc(l.t)}${l.text}`)
      .join('\n');
    const name = source && (source.trackName || source.artistName) ? { trackName: source.trackName || null, artistName: source.artistName || null } : {};
    rec = null;
    offset = 0;
    savePick({ mode: 'custom', text: lrc, id: null, offset: 0, selfSynced: true, ...name });
    setDoc(lrc, { kind: 'custom', selfSynced: true, ...name });
  }

  function cancelRec() {
    rec = null;
    builtVersion = -1;
    renderNow();
  }

  // ---------- actions ----------
  // The ✕ on the overlay hides it from the video only; lyrics stay available in the popup
  function setOverlay(on) {
    chrome.storage.local.get('settings', ({ settings }) => chrome.storage.local.set({ settings: { ...settings, lyricsOverlay: on } }));
  }

  function setStyle(next) {
    chrome.storage.local.get('settings', ({ settings }) => chrome.storage.local.set({ settings: { ...settings, lyricsStyle: next } }));
  }

  function applySettings(s) {
    overlayOn = !(s && s.lyricsOverlay === false);
    preferCC = !(s && s.lyricsPreferCC === false);
    style = s && s.lyricsStyle === 'lines' ? 'lines' : 'panel';
    const color = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d);
    look = {
      wipe: !(s && s.lyricsWipe === false),
      bg: !(s && s.lyricsBg === false),
      hl: color(s && s.lyricsHl, DEFAULT_HL),
      fg: color(s && s.lyricsFg, DEFAULT_FG),
    };
    applyLook();
    applyShow(!!(s && s.showLyrics));
    renderNow();
  }

  function changeOffset(delta) {
    offset = Math.round((offset + delta) * 10) / 10;
    savePick({ offset });
    renderNow();
  }

  function applyShow(on) {
    if (on === show) return;
    show = on;
    if (!show) {
      loadToken++;
      clearTimeout(loadTimer);
      if (status !== 'found') status = 'off';
      renderNow();
      return;
    }
    if (doc) {
      status = 'found';
      renderNow();
    } else {
      status = videoId ? 'waiting' : 'no-video';
      renderNow();
      scheduleLoad(0);
    }
  }

  // After the extension is reloaded/updated this copy is orphaned: chrome.* stops working, so
  // nothing could control the overlay any more. Remove it and stop.
  const alive = () => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  };

  function teardown() {
    dead = true;
    clearTimeout(loadTimer);
    loadToken++;
    clearInterval(tickTimer);
    stopLoop();
    playerObserver?.disconnect();
    host?.remove();
    host = null;
    ui = null;
  }

  function tick() {
    if (dead) return;
    if (!alive()) {
      teardown();
      return;
    }
    const vid = currentVideoId();
    if (vid !== videoId) {
      videoId = vid;
      resetLyrics();
      scheduleLoad();
    }
    if (show) renderNow();
  }

  // ---------- wiring ----------
  chrome.storage.local.get(['settings', 'uiLang', 'lyricsPanelBox'], ({ settings, uiLang, lyricsPanelBox }) => {
    lang = I.resolve(uiLang);
    box = lyricsPanelBox || null;
    videoId = currentVideoId();
    applySettings(settings);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (dead || area !== 'local') return;
    if (changes.uiLang) {
      lang = I.resolve(changes.uiLang.newValue);
      applyLabels();
      renderNow();
    }
    if (changes.settings) applySettings(changes.settings.newValue);
  });

  const tickTimer = setInterval(tick, 1000);
  document.addEventListener('yt-navigate-finish', () => setTimeout(tick, 0));

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (dead || !msg || typeof msg.type !== 'string' || !msg.type.startsWith('lyrics:') || msg.type.startsWith('lyrics:bg:')) return;
    switch (msg.type) {
      case 'lyrics:state': {
        const m = meta || (videoId ? readMeta() : null);
        sendResponse({
          show,
          overlay: overlayOn,
          videoId,
          docKey: docVersion,
          lineCount: doc ? doc.lines.length : 0,
          status,
          error: lastError,
          synced: !!(doc && doc.synced),
          source,
          offset,
          query: m ? L.cleanTitle(m.title) : '',
          candidates: candidates.map(({ syncedLyrics, plainLyrics, cc, ...c }) => ({ ...c, synced: !!syncedLyrics || !!cc })),
        });
        break;
      }
      case 'lyrics:use': {
        const rec = msg.record || candidates.find((c) => c.id === msg.id);
        if (rec && rec.cc) {
          // A YouTube caption track picked in the popup
          const token = ++loadToken;
          offset = 0;
          status = 'searching';
          renderNow();
          useCaption(rec.cc, token, true).then((ok) => {
            if (token !== loadToken) return;
            if (!ok) {
              status = 'error';
              lastError = t('ccFailed');
              renderNow();
            }
            sendResponse({ ok });
          });
          return true; // async response
        }
        if (rec) {
          cancelAutoLoad();
          offset = 0;
          savePick({ mode: 'lrclib', id: rec.id, offset: 0, text: null });
          useRecord(rec, false);
        }
        sendResponse({ ok: !!rec });
        break;
      }
      case 'lyrics:custom':
        cancelAutoLoad();
        offset = 0;
        savePick({ mode: 'custom', text: msg.text, id: null, offset: 0 });
        setDoc(msg.text, { kind: 'custom' });
        sendResponse({ ok: status === 'found' });
        break;
      case 'lyrics:offset':
        changeOffset(msg.delta || 0);
        sendResponse({ ok: true, offset });
        break;
      case 'lyrics:lines':
        sendResponse({ docKey: docVersion, synced: !!(doc && doc.synced), lines: doc ? doc.lines : [] });
        break;
      case 'lyrics:pos': {
        const v = video();
        sendResponse(v ? { t: v.currentTime + offset, duration: v.duration || 0, paused: v.paused } : null);
        break;
      }
      case 'lyrics:seek': {
        const v = video();
        if (v && Number.isFinite(msg.t)) v.currentTime = Math.max(0, msg.t - offset);
        sendResponse({ ok: !!v });
        break;
      }
      case 'lyrics:retry':
        resetLyrics();
        scheduleLoad(0);
        sendResponse({ ok: true });
        break;
      case 'lyrics:auto':
        if (videoId) chrome.storage.local.remove(pickKey(videoId));
        resetLyrics();
        scheduleLoad(0);
        sendResponse({ ok: true });
        break;
      default:
        return;
    }
  });
})();

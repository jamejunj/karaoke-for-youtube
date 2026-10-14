(() => {
  // Newest copy wins (see lyrics.js): after an extension reload the popup re-injects this script,
  // and an older copy that is still running stops answering and stops touching the page.
  const instanceId = Math.random().toString(36).slice(2);
  const OWNER_ATTR = 'data-yt-karaoke-audio';
  let dead = false;
  document.documentElement.setAttribute(OWNER_ATTR, instanceId);
  document.dispatchEvent(new Event('yt-karaoke-audio-takeover'));
  document.addEventListener('yt-karaoke-audio-takeover', () => {
    if (document.documentElement.getAttribute(OWNER_ATTR) !== instanceId) dead = true;
  });

  const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1, showLyrics: false, lyricsOverlay: true, lyricsStyle: 'panel', lyricsWipe: true, lyricsBg: true, lyricsHl: '#ffd23f', lyricsFg: '#ffffff', lyricsPreferCC: true };

  let settings = { ...DEFAULTS };
  let lang = KaraokeI18n.resolve();
  const t = (key, vars) => KaraokeI18n.t(lang, key, vars);
  let ctx = null;
  let fxNode = null;
  let enginePromise = null;
  let status = 'idle'; // idle | waiting-gesture | active | bypass | error
  let lastError = '';
  let gestureArmed = false;
  let routedMode = null;
  const sources = new Map(); // video element -> MediaElementAudioSourceNode

  const needsFx = (s) => s.semitones !== 0 || s.vocalRemoval;

  function ensureEngine() {
    if (!enginePromise) {
      ctx = new AudioContext();
      enginePromise = ctx.audioWorklet
        .addModule(chrome.runtime.getURL('karaoke-processor.js'))
        .then(() => {
          fxNode = new AudioWorkletNode(ctx, 'karaoke-processor', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
          });
          fxNode.connect(ctx.destination);
          pushParams();
        });
    }
    return enginePromise;
  }

  async function contextRunning() {
    if (ctx.state === 'running') return true;
    // resume() stays pending until the page has had a user gesture, so don't wait forever
    await Promise.race([ctx.resume().catch(() => {}), new Promise((r) => setTimeout(r, 300))]);
    return ctx.state === 'running';
  }

  function pushParams() {
    if (!fxNode) return;
    fxNode.port.postMessage({
      semitones: settings.semitones,
      vocal: settings.vocalRemoval,
      strength: settings.vocalStrength / 100,
    });
  }

  function armGesture() {
    if (gestureArmed) return;
    gestureArmed = true;
    const onGesture = () => {
      gestureArmed = false;
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
      update();
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
  }

  function route() {
    const mode = needsFx(settings) ? 'fx' : 'direct';
    if (mode === routedMode) return;
    for (const src of sources.values()) {
      src.disconnect();
      src.connect(mode === 'fx' ? fxNode : ctx.destination);
    }
    routedMode = mode;
  }

  function hook(video) {
    if (sources.has(video)) return;
    let src;
    try {
      src = ctx.createMediaElementSource(video);
    } catch (err) {
      // An older copy of the extension (before an update) already owns this video's audio
      if (err && err.name === 'InvalidStateError') {
        const e = new Error('needs-refresh');
        e.needsRefresh = true;
        throw e;
      }
      throw err;
    }
    src.connect(routedMode === 'fx' ? fxNode : ctx.destination);
    sources.set(video, src);
  }

  // ---------- speed (browser time-stretch, pitch preserved) ----------
  let speedTouched = false;
  function applySpeed(video) {
    if (dead) return;
    const speed = settings.speed;
    // At 1× leave YouTube's own speed menu in charge, unless we changed it earlier
    if (speed === 1 && !speedTouched) return;
    speedTouched = speed !== 1;
    const targets = video ? [video] : document.querySelectorAll('video');
    for (const v of targets) {
      v.preservesPitch = true;
      if (Math.abs(v.playbackRate - speed) > 0.001) v.playbackRate = speed;
    }
  }

  async function update() {
    if (dead) return;
    applySpeed();
    pushParams();
    // Leave YouTube's audio untouched until an effect is actually needed
    if (!needsFx(settings) && sources.size === 0) {
      status = 'idle';
      return;
    }
    const videos = [...document.querySelectorAll('video')];
    if (videos.length === 0) return;

    try {
      await ensureEngine();
      if (!(await contextRunning())) {
        status = 'waiting-gesture';
        armGesture();
        toast(t('toastGesture'));
        return;
      }
      if (routedMode === null) routedMode = needsFx(settings) ? 'fx' : 'direct';
      for (const v of videos) hook(v);
      route();
      status = routedMode === 'fx' ? 'active' : 'bypass';
      lastError = '';
    } catch (err) {
      status = err && err.needsRefresh ? 'needs-refresh' : 'error';
      lastError = String((err && err.message) || err);
      console.error('[YouTube Karaoke]', err);
    }
  }

  // ---------- on-page toast ----------
  let toastHost = null;
  let toastTimer = 0;
  function toast(text) {
    // Hide toasts left by an orphaned older copy of this script
    for (const other of document.querySelectorAll('.yt-karaoke-toast')) if (other !== toastHost) other.remove();
    if (!toastHost) {
      toastHost = document.createElement('div');
      toastHost.className = 'yt-karaoke-toast';
      const root = toastHost.attachShadow({ mode: 'open' });
      // No innerHTML: YouTube enforces Trusted Types
      const style = document.createElement('style');
      style.textContent = `
        .t { position: fixed; top: 72px; left: 50%; transform: translate(-50%, -8px);
             z-index: 2147483647; padding: 10px 18px; border-radius: 999px;
             background: rgba(20, 20, 24, .92); color: #fff; opacity: 0;
             font: 600 14px/1.3 system-ui, "Noto Sans Thai", sans-serif;
             box-shadow: 0 6px 24px rgba(0,0,0,.35); pointer-events: none;
             transition: opacity .2s, transform .2s; }
        .t.show { opacity: 1; transform: translate(-50%, 0); }`;
      const box = document.createElement('div');
      box.className = 't';
      root.append(style, box);
      document.documentElement.appendChild(toastHost);
    }
    const el = toastHost.shadowRoot.querySelector('.t');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
  }

  function describe(s) {
    const key = t('toastKey', { n: s.semitones });
    const vocal = s.vocalRemoval ? t('toastVocalOn', { n: s.vocalStrength }) : t('toastVocalOff');
    const speed = s.speed !== 1 ? ` · ${t('toastSpeed', { n: s.speed })}` : '';
    return `🎤 ${key} · ${vocal}${speed}`;
  }

  // ---------- wiring ----------
  chrome.storage.local.get(['settings', 'uiLang'], ({ settings: saved, uiLang }) => {
    settings = { ...DEFAULTS, ...saved };
    lang = KaraokeI18n.resolve(uiLang);
    update();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (dead || area !== 'local') return;
    if (changes.uiLang) lang = KaraokeI18n.resolve(changes.uiLang.newValue);
    if (!changes.settings) return;
    settings = { ...DEFAULTS, ...changes.settings.newValue };
    update();
    if (document.visibilityState === 'visible') toast(describe(settings));
  });

  // YouTube resets playbackRate when a new video loads; keep our speed while it's not 1×
  document.addEventListener(
    'ratechange',
    (e) => {
      if (e.target instanceof HTMLVideoElement && settings.speed !== 1) applySpeed(e.target);
    },
    true
  );

  // Hook videos that start playing later (SPA navigation, new player elements)
  document.addEventListener(
    'play',
    (e) => {
      if (e.target instanceof HTMLVideoElement && settings.speed !== 1) applySpeed(e.target);
      if (e.target instanceof HTMLVideoElement && !sources.has(e.target) && needsFx(settings)) update();
      else if (ctx && ctx.state !== 'running') update();
    },
    true
  );

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (dead) return;
    if (msg && msg.type === 'karaoke:status') {
      sendResponse({ status, error: lastError, hasVideo: !!document.querySelector('video'), version: chrome.runtime.getManifest().version });
    }
  });
})();

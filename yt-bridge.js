// Runs in the page's MAIN world: the caption track list lives in YouTube's own player object,
// which the extension's isolated content scripts can't see. Answers a DOM-event request with
// the current video's caption tracks as a JSON string. No extension APIs are used here.
(() => {
  if (window.__ytKaraokeBridge) return;
  window.__ytKaraokeBridge = true;

  document.addEventListener('yt-karaoke-cc-request', (e) => {
    const out = { id: String(e.detail || ''), videoId: null, defaultIndex: null, tracks: [] };
    try {
      const player = document.querySelector('#movie_player');
      const pr = player && typeof player.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
      out.videoId = (pr && pr.videoDetails && pr.videoDetails.videoId) || null;
      const list = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
      const audio = list && list.audioTracks && list.audioTracks[0];
      if (audio && Number.isInteger(audio.defaultCaptionTrackIndex)) out.defaultIndex = audio.defaultCaptionTrackIndex;
      out.tracks = ((list && list.captionTracks) || []).map((t) => ({
        baseUrl: t.baseUrl,
        lang: t.languageCode || '',
        kind: t.kind || '',
        vssId: t.vssId || `${t.kind === 'asr' ? 'a' : ''}.${t.languageCode}`,
        name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode || '',
      }));
    } catch (err) {
      out.error = String(err);
    }
    document.dispatchEvent(new CustomEvent('yt-karaoke-cc-response', { detail: JSON.stringify(out) }));
  });
})();

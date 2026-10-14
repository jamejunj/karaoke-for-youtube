// Pure helpers shared by the content script and the background worker:
// title cleaning, LRC parsing and picking the best LRCLIB match.
(() => {
  // Words inside brackets that mark a segment as noise, e.g. "(Official MV)", "[เนื้อเพลง]"
  const NOISE_RE =
    /(official|music\s*video|\bm\/?v\b|\bvideo\b|\baudio\b|lyric|visuali[sz]er|\b4k\b|\bhd\b|\bhq\b|\blive\b|teaser|karaoke|remaster|explicit|color\s*coded|\bsub(s|title)?\b|\bprod\b|\bfeat\b|\bft\.|\bver\.?\b|version|full\s*song|เนื้อเพลง|คาราโอเกะ|ซับ|แปล|มิวสิค|ออฟฟิ|เวอร์ชั่น|เวอร์ชัน|ไลฟ์|คอนเสิร์ต|เพลงประกอบ|ost\b)/i;
  const BRACKET_RE = /[(\[【「『{（〔]([^)\]】」』}）〕]*)[)\]】」』}）〕]/g;
  const TRAILING_RE =
    /\s*[-–—|:]?\s*(official\s*(music\s*)?(video|mv|m\/v|audio|lyric\s*video|visuali[sz]er)|lyric\s*video|lyrics?|\bm\/?v\b|\b(4k|8k|hd|hq|\d{3,4}p)\b|เนื้อเพลง|คาราโอเกะ)\s*$/i;
  const FEAT_RE = /\s+(feat\.?|ft\.?|featuring)\s+.*$/i;
  const SEPARATOR_RE = /\s+[-–—~]\s+|\s*[|｜]\s*|\s*[:：]\s+/;

  const squash = (s) => s.replace(/\s+/g, ' ').trim();

  function cleanTitle(raw) {
    let s = String(raw || '');
    s = s.replace(BRACKET_RE, (m, inner) => (NOISE_RE.test(inner) ? ' ' : m));
    s = s.replace(/["“”«»《》＂]/g, ' ');
    s = s.replace(/#\S+/g, ' ');
    let prev;
    do {
      prev = s;
      s = s.replace(TRAILING_RE, '');
    } while (s !== prev);
    return squash(s);
  }

  const stripBrackets = (s) => squash(s.replace(BRACKET_RE, ' '));

  function cleanChannel(raw) {
    // Lyric / karaoke upload channels are not the artist
    if (/lyric|karaoke|คาราโอเกะ|เนื้อเพลง|cover/i.test(raw || '')) return '';
    return squash(
      String(raw || '')
        .replace(/\s*-\s*topic$/i, '')
        .replace(/vevo$/i, '')
        .replace(/\b(official|channel|music|records?|entertainment)\b/gi, ' ')
    );
  }

  // Split "Artist - Title" (or "Title | Artist") into meaningful parts
  function splitParts(clean) {
    return clean
      .split(SEPARATOR_RE)
      .map((p) => squash(p.replace(FEAT_RE, '')))
      // Drop short leftovers that are only noise ("Official MV", "4K"); keep real names
      .filter((p) => p && !(NOISE_RE.test(p) && p.length <= 24));
  }

  // Ordered LRCLIB queries for a video, most specific first
  function buildQueries({ title, artist, channel, isMusic }) {
    const clean = cleanTitle(title);
    const parts = splitParts(clean);
    const ch = cleanChannel(channel || artist);
    const out = [];
    if (isMusic && artist) out.push({ track_name: clean.replace(FEAT_RE, ''), artist_name: cleanChannel(artist) });
    if (parts.length >= 2) {
      out.push({ q: `${parts[0]} ${parts[1]}` });
      out.push({ track_name: parts[1], artist_name: parts[0] });
      out.push({ track_name: parts[0], artist_name: parts[1] });
    } else if (parts.length === 1) {
      if (ch) out.push({ q: `${ch} ${parts[0]}` });
      out.push({ q: parts[0] });
    }
    const loose = stripBrackets(clean);
    if (loose) out.push({ q: loose });
    const seen = new Set();
    return out.filter((q) => {
      const key = JSON.stringify(q).toLowerCase();
      if (seen.has(key) || Object.values(q).some((v) => !v)) return false;
      seen.add(key);
      return true;
    });
  }

  // Lower is better. Prefers synced lyrics, close duration and the API's own ranking.
  function score(rec, index, duration) {
    if (!rec || rec.instrumental || (!rec.syncedLyrics && !rec.plainLyrics)) return Infinity;
    const dd = duration && rec.duration ? Math.abs(rec.duration - duration) : 0;
    if (dd > 120) return Infinity;
    return index + (rec.syncedLyrics ? 0 : 8) + Math.min(dd, 120) * 0.4;
  }

  function pickBest(results, duration) {
    let best = null;
    let bestScore = Infinity;
    results.forEach((r, i) => {
      const s = score(r, i, duration);
      if (s < bestScore) {
        bestScore = s;
        best = r;
      }
    });
    return best;
  }

  const isGoodMatch = (rec, duration) =>
    !!rec && !!rec.syncedLyrics && (!duration || Math.abs(rec.duration - duration) <= 10);

  // Returns { synced: true, lines: [{ t, text }] } or { synced: false, lines: [string] }
  function parseLrc(text) {
    const timed = [];
    const plain = [];
    let offset = 0;
    const stamp = /^\s*\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const off = raw.match(/^\s*\[offset:\s*([+-]?\d+)\s*\]/i);
      if (off) {
        offset = Number(off[1]) / 1000;
        continue;
      }
      const times = [];
      let rest = raw;
      let m;
      while ((m = rest.match(stamp))) {
        times.push(Number(m[1]) * 60 + parseFloat(m[2].replace(':', '.')));
        rest = rest.slice(m[0].length);
      }
      if (times.length) {
        const line = squash(rest.replace(/<\d+:\d+(?:[.:]\d+)?>/g, ''));
        for (const t of times) timed.push({ t, text: line });
      } else if (!/^\s*\[[a-z#]+:.*\]\s*$/i.test(raw)) {
        plain.push(raw.trim());
      }
    }
    if (timed.length) {
      timed.sort((a, b) => a.t - b.t);
      for (const l of timed) l.t = Math.max(0, l.t - offset);
      return { synced: true, lines: timed };
    }
    while (plain.length && !plain[0]) plain.shift();
    while (plain.length && !plain[plain.length - 1]) plain.pop();
    return { synced: false, lines: plain };
  }

  // Index of the last line whose time is <= t (−1 before the first line)
  function lineAt(lines, t) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].t <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  const slim = (r) => ({
    id: r.id,
    trackName: r.trackName,
    artistName: r.artistName,
    albumName: r.albumName,
    duration: r.duration,
    instrumental: !!r.instrumental,
    syncedLyrics: r.syncedLyrics || null,
    plainLyrics: r.plainLyrics || null,
  });

  // ---------- YouTube captions (CC) ----------
  const lrcStamp = (s) => {
    const m = Math.floor(s / 60);
    return `[${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(2).padStart(5, '0')}]`;
  };
  // Caption cues that only mark music/applause become empty lines (shown as ♪ gaps)
  const CUE_ONLY_RE = /^[\[(（【]?\s*(music|musique|música|applause|instrumental|เพลง|ดนตรี|เสียงดนตรี|♪+|♫+)\s*[\])）】]?$/i;

  // YouTube timedtext "json3" → LRC text. Works for both uploaded and auto-generated (ASR) tracks:
  // ASR "append" events that only carry a newline are skipped.
  function json3ToLrc(data) {
    const lines = [];
    for (const ev of (data && data.events) || []) {
      if (!ev.segs || ev.aAppend || typeof ev.tStartMs !== 'number') continue;
      let text = squash(ev.segs.map((s) => s.utf8 || '').join('').replace(/\n/g, ' '));
      if (!text) continue;
      text = text.replace(/^[♪♫\s]+|[♪♫\s]+$/g, '').trim() || text;
      if (CUE_ONLY_RE.test(text) || /^[♪♫\s]+$/.test(text)) text = '';
      const t = ev.tStartMs / 1000;
      const prev = lines[lines.length - 1];
      if (prev && prev.text === text && t - prev.t < 1) continue;
      lines.push({ t, text });
    }
    if (!lines.some((l) => l.text)) return '';
    return lines.map((l) => `${lrcStamp(l.t)}${l.text}`).join('\n');
  }

  // Best caption track for lyrics: an uploaded track in the song's own language (the ASR track's
  // language tells us what is sung), then YouTube's default track, then any uploaded track.
  // Auto-generated tracks are returned separately as a last resort.
  function pickCaptionTracks(tracks, defaultIndex) {
    const list = tracks || [];
    const manual = list.filter((t) => t.kind !== 'asr');
    const asr = list.find((t) => t.kind === 'asr') || null;
    const sameLang = (a, b) => a && b && a.split('-')[0].toLowerCase() === b.split('-')[0].toLowerCase();
    const def = Number.isInteger(defaultIndex) ? list[defaultIndex] : null;
    const best =
      (asr && manual.find((t) => sameLang(t.lang, asr.lang))) ||
      (def && def.kind !== 'asr' ? def : null) ||
      manual[0] ||
      null;
    return { best, asr };
  }

  // "Track – Artist", without repeating the artist when the track name already contains it
  function displayName({ trackName, artistName }) {
    const track = trackName || '';
    const artist = artistName || '';
    if (!artist || track.toLowerCase().includes(artist.toLowerCase())) return track || artist;
    return track ? `${track} – ${artist}` : artist;
  }

  globalThis.KaraokeLyrics = {
    displayName,
    json3ToLrc,
    pickCaptionTracks,
    cleanTitle,
    cleanChannel,
    splitParts,
    buildQueries,
    pickBest,
    isGoodMatch,
    parseLrc,
    lineAt,
    slim,
  };
})();

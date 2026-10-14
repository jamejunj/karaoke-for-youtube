# Chrome Web Store submission — Karaoke for YouTube™ v1.3.0

## 1. Before you start
- [ ] Register a developer account at https://chrome.google.com/webstore/devconsole (one-time US$5 fee, Google account with 2-Step Verification).
- [ ] Put your contact email in `store/privacy-policy.html` (two places: `[YOUR CONTACT EMAIL]`, `[อีเมลติดต่อของคุณ]`).
- [ ] Host the privacy policy at a public URL (e.g. GitHub Pages) — the dashboard needs a link, not a file.
- [ ] Take 1–5 screenshots at 1280×800 (see `store/listing.md`).
- [ ] Build the package: `powershell -ExecutionPolicy Bypass -File .\build.ps1` → `dist/karaoke-for-youtube-<version>.zip`

## 2. Upload
Developer Dashboard → **New item** → upload the zip.

## 3. Store listing tab
Paste from `store/listing.md` (English + add Thai). Category: **Entertainment**. Upload icon and screenshots.

## 4. Privacy tab — answers

**Single purpose**
> Karaoke tools for YouTube videos: change the key, remove vocals, change the speed, and show the song's lyrics while it plays.

**Permission justifications**

| Permission | Justification to paste |
|---|---|
| `storage` | Saves the user's settings (key, vocal removal, speed, lyrics display options, colours, language) and per-video lyrics choices locally in the browser. |
| `scripting` | When the extension is updated while a YouTube tab is already open, the popup re-injects the extension's own bundled content scripts into that YouTube tab so it keeps working without a page refresh. No remote code is injected. |
| Host `https://www.youtube.com/*`, `https://m.youtube.com/*`, `https://music.youtube.com/*` | The extension's features run on YouTube pages: it routes the video's audio through a Web Audio processor (key change, vocal removal), sets playback speed, draws the lyrics overlay on the player, and loads the video's own captions (CC) from YouTube to use as lyrics. A small bundled script (`yt-bridge.js`, page main world) reads the player's caption track list, because that list isn't visible to isolated content scripts. |
| Host `https://lrclib.net/*` | Looks up lyrics for the current song from the LRCLIB public lyrics API (only while the user has Lyrics switched on). |

**Remote code**: **No, I am not using remote code.** (All JavaScript is in the package; LRCLIB returns JSON text only.)

**Data usage** — tick:
- [x] **Website content** — the video's title, channel name and length are sent to lrclib.net to find lyrics, only while Lyrics is on.

Leave everything else unticked (no personally identifiable info, health, financial, authentication, personal communications, location, web history, user activity).

Certify all three statements:
- [x] I do not sell or transfer user data to third parties, outside of the approved use cases
- [x] I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- [x] I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**: the public URL of `store/privacy-policy.html`.

## 5. Distribution tab
Visibility: Public (or Unlisted for a soft launch). Regions: all, or choose.

## 6. Submit for review
Reviews usually take from a few days up to a few weeks. Extensions with broad host permissions can take longer.

## Updating later
1. Bump `"version"` in `manifest.json` (it must be higher than the published one).
2. Run `build.ps1` and upload the new zip in the dashboard → **Package** → **Upload new package**.

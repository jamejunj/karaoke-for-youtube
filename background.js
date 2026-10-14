const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1 };
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
  else return;
  await chrome.storage.local.set({ settings: s });
});

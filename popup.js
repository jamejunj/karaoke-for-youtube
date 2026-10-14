const DEFAULTS = { semitones: 0, vocalRemoval: false, vocalStrength: 100, speed: 1 };
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
  for (const btn of document.querySelectorAll('.lang button')) btn.setAttribute('aria-pressed', String(btn.dataset.lang === lang));
  render();
  if (lastStatus) showStatus(lastStatus);
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
};

function showStatus(res) {
  lastStatus = res;
  const [key, cls] = STATUS[res.status] || STATUS.idle;
  const text = t(key);
  const el = $('status');
  el.textContent = res.status === 'error' && res.error ? `${text}: ${res.error}` : text;
  el.className = `status ${cls}`;
}

async function refreshStatus() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: 'karaoke:status' }, (res) => {
    if (chrome.runtime.lastError || !res) showStatus({ status: 'no-tab' });
    else if (!res.hasVideo) showStatus({ status: 'no-video' });
    else showStatus(res);
  });
}

chrome.storage.local.get(['settings', 'uiLang'], ({ settings: saved, uiLang }) => {
  settings = { ...DEFAULTS, ...saved };
  lang = KaraokeI18n.resolve(uiLang);
  applyLanguage();
});
applyLanguage();
refreshStatus();
setInterval(refreshStatus, 1000);

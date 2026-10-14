// Shared UI strings for the popup and the on-page toast.
// Language preference is stored as `uiLang` ('th' | 'en'); when unset it follows the browser.
(() => {
  const plural = (n, one, many) => (Math.abs(n) === 1 ? one : many);

  const STRINGS = {
    th: {
      statusChecking: 'กำลังตรวจสอบ…',
      statusIdle: 'พร้อมใช้งาน',
      statusBypass: 'พร้อมใช้งาน (เสียงต้นฉบับ)',
      statusActive: '● กำลังทำงาน',
      statusGesture: 'คลิกที่หน้า YouTube หนึ่งครั้งเพื่อเริ่มเอฟเฟกต์',
      statusError: 'เกิดข้อผิดพลาด',
      statusNoTab: 'เปิดวิดีโอ YouTube เพื่อใช้งาน (ถ้าเปิดอยู่แล้วให้รีเฟรชหน้า)',
      statusNoVideo: 'ยังไม่พบวิดีโอในหน้านี้',

      keyTitle: 'ปรับคีย์',
      reset: 'รีเซ็ต',
      keyDown: 'ลดคีย์',
      keyUp: 'เพิ่มคีย์',
      keySlider: 'คีย์ (ครึ่งเสียง)',
      keyOriginal: 'คีย์เดิม',
      keyShift: ({ n }) => {
        const abs = Math.abs(n);
        const whole = abs % 2 === 0 ? ` (${abs / 2} เสียงเต็ม)` : '';
        return `${n > 0 ? 'สูงขึ้น' : 'ต่ำลง'} ${abs} ครึ่งเสียง${whole}`;
      },

      speedTitle: 'ความเร็ว',
      speedDown: 'ลดความเร็ว',
      speedUp: 'เพิ่มความเร็ว',
      speedSlider: 'ความเร็ว',
      speedNormal: 'ความเร็วปกติ',
      speedChange: ({ n }) => `${n > 0 ? 'เร็วขึ้น' : 'ช้าลง'} ${Math.abs(n)}% · คีย์ไม่เปลี่ยน`,

      vocalTitle: 'ตัดเสียงนักร้อง',
      strength: 'ความแรง',
      strengthExtra: 'แรงพิเศษ',
      vocalHint: 'ได้ผลดีกับเพลงสเตอริโอที่เสียงร้องอยู่ตรงกลาง เสียงก้อง (reverb) ของนักร้องอาจยังหลงเหลืออยู่บ้าง',
      vocalHintExtra: 'เกิน 100%: ตัดเสียงร้องที่ไม่ได้อยู่ตรงกลางพอดี เสียง ซ/ส และเสียงก้องได้มากขึ้น แต่เครื่องดนตรีที่อยู่ค่อนไปทางกลางจะเบาลงด้วย',

      shortcuts: 'คีย์ลัด:',
      shortcutKey: 'ปรับคีย์',
      shortcutVocal: 'ตัดเสียงร้อง',
      language: 'ภาษา',

      toastGesture: 'คลิกที่หน้า YouTube หนึ่งครั้งเพื่อเปิดเอฟเฟกต์คาราโอเกะ',
      toastKey: ({ n }) => (n === 0 ? 'คีย์เดิม' : `คีย์ ${n > 0 ? '+' : ''}${n}`),
      toastVocalOn: ({ n }) => `ตัดเสียงร้อง ${n}%`,
      toastVocalOff: 'เสียงร้องปกติ',
      toastSpeed: ({ n }) => `ความเร็ว ${n}×`,
    },
    en: {
      statusChecking: 'Checking…',
      statusIdle: 'Ready',
      statusBypass: 'Ready (original audio)',
      statusActive: '● Active',
      statusGesture: 'Click anywhere on the YouTube page once to start the effect',
      statusError: 'Error',
      statusNoTab: 'Open a YouTube video to use this (refresh the page if it is already open)',
      statusNoVideo: 'No video found on this page yet',

      keyTitle: 'Key',
      reset: 'Reset',
      keyDown: 'Lower key',
      keyUp: 'Raise key',
      keySlider: 'Key (semitones)',
      keyOriginal: 'Original key',
      keyShift: ({ n }) => {
        const abs = Math.abs(n);
        const whole = abs % 2 === 0 ? ` (${abs / 2} ${plural(abs / 2, 'whole step', 'whole steps')})` : '';
        return `${n > 0 ? 'Up' : 'Down'} ${abs} ${plural(abs, 'semitone', 'semitones')}${whole}`;
      },

      speedTitle: 'Speed',
      speedDown: 'Slow down',
      speedUp: 'Speed up',
      speedSlider: 'Speed',
      speedNormal: 'Normal speed',
      speedChange: ({ n }) => `${Math.abs(n)}% ${n > 0 ? 'faster' : 'slower'} · key unchanged`,

      vocalTitle: 'Remove vocals',
      strength: 'Strength',
      strengthExtra: 'extra strong',
      vocalHint: 'Works best on stereo songs with centred vocals. Some vocal reverb may remain.',
      vocalHintExtra: 'Above 100%: also removes slightly off-centre vocals, sibilance and more reverb, but instruments near the centre get quieter too.',

      shortcuts: 'Shortcuts:',
      shortcutKey: 'key',
      shortcutVocal: 'vocals',
      language: 'Language',

      toastGesture: 'Click the YouTube page once to enable the karaoke effect',
      toastKey: ({ n }) => (n === 0 ? 'Original key' : `Key ${n > 0 ? '+' : ''}${n}`),
      toastVocalOn: ({ n }) => `Vocals removed ${n}%`,
      toastVocalOff: 'Vocals on',
      toastSpeed: ({ n }) => `Speed ${n}×`,
    },
  };

  function resolve(pref) {
    if (pref === 'th' || pref === 'en') return pref;
    const ui = (chrome.i18n && chrome.i18n.getUILanguage()) || navigator.language || '';
    return ui.toLowerCase().startsWith('th') ? 'th' : 'en';
  }

  function t(lang, key, vars) {
    const v = (STRINGS[lang] || STRINGS.en)[key] ?? STRINGS.en[key] ?? key;
    return typeof v === 'function' ? v(vars || {}) : v;
  }

  globalThis.KaraokeI18n = { resolve, t, languages: Object.keys(STRINGS) };
})();

// AudioWorklet: STFT-based karaoke processor
// - Vocal removal: attenuates bins that are centre-panned (L ≈ R) inside the vocal band
// - Key change: phase-vocoder pitch shift (tempo unchanged)

const FFT_SIZE = 2048;
const OSAMP = 8;
const HOP = FFT_SIZE / OSAMP;
const HALF = FFT_SIZE / 2;
const TWO_PI = Math.PI * 2;
const EXPCT = TWO_PI / OSAMP;

// Vocal band and centre-detection thresholds.
// Strength 0–1 scales removal depth; 1–2 ("extra") widens the band and the
// centre window so slightly off-centre vocals, sibilance and some reverb go too.
const VOCAL_LOW_HZ = 100;
const VOCAL_LOW_HZ_MAX = 80;
const VOCAL_HIGH_HZ = 8000;
const VOCAL_HIGH_HZ_MAX = 16000;
const EDGE_BINS = 6;
const CENTER_LO = 0.7;
const CENTER_LO_MAX = 0.1;
const CENTER_HI = 0.98;
const CENTER_HI_MAX = 0.85;
const MASK_RELEASE = 0.5;

// Peaks quieter than this (relative to the loudest bin, ≈ -60 dB) join a neighbour's region
const PEAK_FLOOR = 0.001;

function makePvState() {
  return {
    last: new Float64Array(HALF + 1), // analysis phase of the current frame
    mag: new Float64Array(HALF + 1),
    freq: new Float64Array(HALF + 1), // true frequency, in bins
    regionPhase: new Float64Array(HALF + 1), // synthesis peak phase covering each output bin
    nextRegionPhase: new Float64Array(HALF + 1),
    inRe: new Float64Array(HALF + 1),
    inIm: new Float64Array(HALF + 1),
    peaks: new Int32Array(HALF),
  };
}

class KaraokeProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const N = FFT_SIZE;

    this.ratio = 1;
    this.vocal = false;
    this.strength = 1;

    this.window = new Float64Array(N);
    for (let i = 0; i < N; i++) this.window[i] = 0.5 - 0.5 * Math.cos((TWO_PI * i) / N);
    // Sum of Hann² over OSAMP overlapping frames = 0.375 * OSAMP
    this.outScale = 1 / (0.375 * OSAMP);

    this.latency = N - HOP;
    this.rover = this.latency;
    this.fifoL = new Float32Array(N);
    this.fifoR = new Float32Array(N);
    this.outFifoL = new Float32Array(HOP);
    this.outFifoR = new Float32Array(HOP);
    this.accL = new Float64Array(N);
    this.accR = new Float64Array(N);

    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.Lr = new Float64Array(HALF + 1);
    this.Li = new Float64Array(HALF + 1);
    this.Rr = new Float64Array(HALF + 1);
    this.Ri = new Float64Array(HALF + 1);

    this.cosT = new Float64Array(HALF);
    this.sinT = new Float64Array(HALF);
    for (let i = 0; i < HALF; i++) {
      this.cosT[i] = Math.cos((TWO_PI * i) / N);
      this.sinT[i] = Math.sin((TWO_PI * i) / N);
    }
    this.rev = new Uint32Array(N);
    const bits = Math.log2(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }

    this.pvL = makePvState();
    this.pvR = makePvState();
    this.maskGain = new Float64Array(HALF + 1).fill(1);

    this.port.onmessage = (e) => this.setParams(e.data || {});
  }

  setParams(d) {
    if (typeof d.semitones === 'number') this.ratio = Math.pow(2, d.semitones / 12);
    if (typeof d.vocal === 'boolean') {
      if (d.vocal && !this.vocal) this.maskGain.fill(1);
      this.vocal = d.vocal;
    }
    if (typeof d.strength === 'number') this.strength = Math.min(2, Math.max(0, d.strength));
  }

  fft(re, im, inverse) {
    const n = FFT_SIZE;
    const rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sign = inverse ? 1 : -1;
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, t = 0; j < half; j++, t += step) {
          const wr = this.cosT[t];
          const wi = sign * this.sinT[t];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    if (inverse) {
      const s = 1 / n;
      for (let i = 0; i < n; i++) { re[i] *= s; im[i] *= s; }
    }
  }

  applyVocalMask() {
    const { Lr, Li, Rr, Ri, maskGain } = this;
    const binHz = sampleRate / FFT_SIZE;
    const depth = Math.min(1, this.strength);
    const extra = Math.max(0, this.strength - 1);
    const lerp = (a, b) => a + (b - a) * extra;
    const kLo = Math.max(1, Math.floor(lerp(VOCAL_LOW_HZ, VOCAL_LOW_HZ_MAX) / binHz));
    const kHi = Math.min(HALF, Math.ceil(lerp(VOCAL_HIGH_HZ, VOCAL_HIGH_HZ_MAX) / binHz));
    const centerLo = lerp(CENTER_LO, CENTER_LO_MAX);
    const centerHi = lerp(CENTER_HI, CENTER_HI_MAX);

    for (let k = 0; k <= HALF; k++) {
      let g = 1;
      if (k >= kLo && k <= kHi) {
        const pl = Lr[k] * Lr[k] + Li[k] * Li[k];
        const pr = Rr[k] * Rr[k] + Ri[k] * Ri[k];
        const cross = Lr[k] * Rr[k] + Li[k] * Ri[k];
        // 1 when L and R are identical (centre), lower when panned / decorrelated
        const psi = (2 * cross) / (pl + pr + 1e-12);
        let m = (psi - centerLo) / (centerHi - centerLo);
        m = m <= 0 ? 0 : m >= 1 ? 1 : m * m * (3 - 2 * m);
        const edge = Math.min(1, (k - kLo + 1) / EDGE_BINS, (kHi - k + 1) / EDGE_BINS);
        g = 1 - depth * m * edge;
      }
      // Duck instantly (catches vocal onsets), recover smoothly (less musical noise)
      const s = (maskGain[k] = g < maskGain[k] ? g : maskGain[k] * MASK_RELEASE + g * (1 - MASK_RELEASE));
      Lr[k] *= s; Li[k] *= s; Rr[k] *= s; Ri[k] *= s;
    }
  }

  phaseVocoder(xr, xi, st, shifting) {
    for (let k = 0; k <= HALF; k++) {
      const re = xr[k];
      const im = xi[k];
      const phase = Math.atan2(im, re);
      let d = phase - st.last[k] - k * EXPCT;
      d -= TWO_PI * Math.round(d / TWO_PI);
      st.last[k] = phase;
      st.mag[k] = Math.sqrt(re * re + im * im);
      st.freq[k] = k + d / EXPCT;
    }
    if (!shifting) {
      st.regionPhase.set(st.last);
      return;
    }

    // Peak-locked pitch shift (Laroche & Dolson): each spectral peak and its surrounding
    // region is moved as a block and rotated by one phase, preserving the lobe shape.
    const { mag, last, freq, peaks, inRe, inIm } = st;
    const ratio = this.ratio;
    let maxMag = 0;
    for (let k = 0; k <= HALF; k++) if (mag[k] > maxMag) maxMag = mag[k];
    const floor = maxMag * PEAK_FLOOR;
    let np = 0;
    for (let k = 2; k <= HALF - 2; k++) {
      const m = mag[k];
      if (m > floor && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) peaks[np++] = k;
    }

    inRe.set(xr);
    inIm.set(xi);
    xr.fill(0);
    xi.fill(0);
    const next = st.nextRegionPhase;
    next.set(last);

    let start = 0;
    for (let i = 0; i < np; i++) {
      const p = peaks[i];
      // Region ends at the magnitude valley before the next peak
      let end = HALF;
      if (i + 1 < np) {
        end = p;
        for (let k = p + 1; k < peaks[i + 1]; k++) if (mag[k] < mag[end]) end = k;
      }
      const target = Math.round(p * ratio);
      if (target > HALF) break;
      const delta = target - p;

      let phi = st.regionPhase[target] + freq[p] * ratio * EXPCT;
      phi -= TWO_PI * Math.round(phi / TWO_PI);
      const rot = phi - last[p];
      const c = Math.cos(rot);
      const s = Math.sin(rot);

      for (let k = start; k <= end; k++) {
        const j = k + delta;
        if (j < 0) continue;
        if (j > HALF) break;
        xr[j] += inRe[k] * c - inIm[k] * s;
        xi[j] += inRe[k] * s + inIm[k] * c;
        next[j] = phi;
      }
      start = end + 1;
    }
    st.nextRegionPhase = st.regionPhase;
    st.regionPhase = next;
  }

  processFrame() {
    const N = FFT_SIZE;
    const { re, im, Lr, Li, Rr, Ri, window: win } = this;

    // Pack both real channels into one complex FFT: z = L + iR
    for (let i = 0; i < N; i++) {
      re[i] = this.fifoL[i] * win[i];
      im[i] = this.fifoR[i] * win[i];
    }
    this.fft(re, im, false);
    for (let k = 0; k <= HALF; k++) {
      const nk = (N - k) & (N - 1);
      const zr = re[k], zi = im[k], cr = re[nk], ci = im[nk];
      Lr[k] = (zr + cr) * 0.5;
      Li[k] = (zi - ci) * 0.5;
      Rr[k] = (zi + ci) * 0.5;
      Ri[k] = (cr - zr) * 0.5;
    }

    if (this.vocal) this.applyVocalMask();

    const shifting = this.ratio !== 1;
    this.phaseVocoder(Lr, Li, this.pvL, shifting);
    this.phaseVocoder(Rr, Ri, this.pvR, shifting);
    Li[0] = Ri[0] = Li[HALF] = Ri[HALF] = 0;

    // Rebuild z = XL + i·XR with Hermitian symmetry, then inverse FFT
    for (let k = 0; k <= HALF; k++) {
      re[k] = Lr[k] - Ri[k];
      im[k] = Li[k] + Rr[k];
    }
    for (let k = HALF + 1; k < N; k++) {
      const j = N - k;
      re[k] = Lr[j] + Ri[j];
      im[k] = Rr[j] - Li[j];
    }
    this.fft(re, im, true);

    const scale = this.outScale;
    for (let i = 0; i < N; i++) {
      const w = win[i] * scale;
      this.accL[i] += re[i] * w;
      this.accR[i] += im[i] * w;
    }
    this.outFifoL.set(this.accL.subarray(0, HOP));
    this.outFifoR.set(this.accR.subarray(0, HOP));
    this.accL.copyWithin(0, HOP);
    this.accR.copyWithin(0, HOP);
    this.accL.fill(0, N - HOP);
    this.accR.fill(0, N - HOP);
    this.fifoL.copyWithin(0, HOP);
    this.fifoR.copyWithin(0, HOP);
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const inL = input && input.length ? input[0] : null;
    const inR = input && input.length > 1 ? input[1] : inL;
    const n = outL.length;

    for (let i = 0; i < n; i++) {
      this.fifoL[this.rover] = inL ? inL[i] : 0;
      this.fifoR[this.rover] = inR ? inR[i] : 0;
      const o = this.rover - this.latency;
      outL[i] = this.outFifoL[o];
      outR[i] = this.outFifoR[o];
      this.rover++;
      if (this.rover >= FFT_SIZE) {
        this.rover = this.latency;
        this.processFrame();
      }
    }
    return true;
  }
}

registerProcessor('karaoke-processor', KaraokeProcessor);

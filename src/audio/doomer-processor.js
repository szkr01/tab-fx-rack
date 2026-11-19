// Cascaded all-pass effect implemented as an AudioWorklet.
class DoomerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const initial = options.processorOptions || {};
    this.enabled = initial.enabled ?? false;
    this.amount = initial.amount ?? 16;
    this.frequency = initial.frequency ?? 130;
    this.pinch = initial.pinch ?? 0;
    this.currentFrequency = this.frequency;
    this.currentPinch = this.pinch;
    this.previousAmount = null;
    this.stages = Array.from({ length: 32 }, () => new Float64Array(4));
    this.scratch = [new Float32Array(64), new Float32Array(64)];
    this.asleep = true;
    this.quietFrames = Infinity;
    this.port.onmessage = ({ data }) => {
      if (this.enabled !== data.enabled) {
        this.enabled = data.enabled;
        this.previousAmount = null;
        for (const stage of this.stages) stage.fill(0);
        this.asleep = true;
        this.quietFrames = Infinity;
      }
      this.amount = data.amount;
      this.frequency = data.frequency;
      this.pinch = data.pinch;
    };
  }

  coefficients(hz, q) {
    const fs = Math.fround(sampleRate);
    const w = Math.fround(Math.min(Math.fround(hz), Math.fround(fs * 0.49))) * (2 * Math.PI) / fs;
    const alpha = Math.sin(w) / (q + q);
    const inv = 1 / (1 + alpha);
    const a1 = (-2 * Math.cos(w)) * inv;
    const a2 = inv * (1 - alpha);
    const b0 = (1 - alpha) * inv;
    const b1 = a1;
    const b2 = (1 + alpha) * inv;
    const u = Math.sqrt(1 + (a1 + a2));
    const v = Math.sqrt(-((a1 - 1) - a2));
    const g = u / v;
    const j = 1 / (-(u * v));
    const r = (a2 - 1) * j;
    const wh = ((b0 - b1) + b2) / ((1 - a1) + a2);
    const wb = ((b0 - b2) * -2) * j;
    const wl = ((b1 + b0) + b2) / ((1 + a1) + a2);
    const k = (r + r) + g;
    const d = 1 / (k * g + 1);
    return [g, k, d, d * g, g + g, -2 * r, wh, wb, wl];
  }

  cascade(output, begin, end, from, to, coeff) {
    const [g, k, d, dg, g2, nr2, wh, wb, wl] = coeff;
    for (let stageIndex = begin; stageIndex < end; stageIndex++) {
      const stage = this.stages[stageIndex];
      for (let ch = 0; ch < output.length; ch++) {
        const row = output[ch];
        let s1 = stage[ch * 2], s2 = stage[ch * 2 + 1];
        for (let i = from; i < to; i++) {
          const x = row[i];
          const t = g * x + s1;
          const hp = x - (t * k + s2) * d;
          const bp = hp * g + s1;
          const lp = (t - s2 * g) * dg + s2;
          s1 = ((x - lp) + nr2 * bp) * g2 + s1;
          s2 = bp * g2 + s2;
          const y = Math.fround((hp * wh + lp * wl) + bp * wb);
          row[i] = Math.abs(y) < 2 ** -126 ? 0 : y;
        }
        stage[ch * 2] = s1;
        stage[ch * 2 + 1] = s2;
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    for (let ch = 0; ch < output.length; ch++) {
      if (input[ch]) output[ch].set(input[ch]);
      else output[ch].fill(0);
    }
    if (!this.enabled || !input.length) return true;

    const length = output[0].length;
    const pieces = Math.ceil(length / 64);
    for (let part = 0; part < pieces; part++) {
      const from = Math.floor(part * length / pieces);
      const to = Math.floor((part + 1) * length / pieces);
      const size = to - from;
      let quiet = true;
      for (const row of output) {
        for (let i = from; i < to; i++) {
          if (Math.abs(row[i]) >= 2 ** -20) { quiet = false; break; }
        }
        if (!quiet) break;
      }
      if (this.asleep && quiet) continue;
      if (quiet && this.quietFrames > 64) { this.asleep = true; continue; }
      if (this.asleep) this.previousAmount = null;

      const remaining = length - from;
      this.currentFrequency = to === length ? this.frequency : Math.fround(this.currentFrequency + Math.fround(Math.fround(Math.fround(this.frequency - this.currentFrequency) * size) / remaining));
      this.currentPinch = to === length ? this.pinch : Math.fround(this.currentPinch + Math.fround(Math.fround(Math.fround(this.pinch - this.currentPinch) * size) / remaining));
      const q = Math.fround(0.5 + Math.fround(15.5 * Math.fround(Math.fround(this.currentPinch) ** 4)));
      const coeff = this.coefficients(this.currentFrequency, q);
      const old = this.previousAmount === null ? this.amount : this.previousAmount;
      const lo = Math.min(old, this.amount);
      const hi = Math.max(old, this.amount);
      this.cascade(output, 0, lo, from, to, coeff);
      if (hi !== lo) {
        for (let ch = 0; ch < output.length; ch++) this.scratch[ch].set(output[ch].subarray(from, to));
        this.cascade(output, lo, hi, from, to, coeff);
        let w = this.amount > old ? 0 : 1;
        const dw = Math.fround((this.amount > old ? 1 : -1) / size);
        for (let i = from; i < to; i++) {
          for (let ch = 0; ch < output.length; ch++) {
            const dry = this.scratch[ch][i - from];
            output[ch][i] = Math.fround(Math.fround(w * Math.fround(output[ch][i] - dry)) + dry);
          }
          w = Math.fround(w + dw);
        }
        for (let i = this.amount; i < old; i++) this.stages[i].fill(0);
      }
      this.previousAmount = this.amount;
      this.asleep = false;
      let tailQuiet = quiet;
      if (quiet) {
        for (const row of output) {
          for (let i = from; i < to; i++) {
            if (Math.abs(row[i]) >= 2 ** -20) { tailQuiet = false; break; }
          }
          if (!tailQuiet) break;
        }
      }
      this.quietFrames = tailQuiet ? this.quietFrames + size : 0;
    }
    return true;
  }
}

registerProcessor('doomer-processor', DoomerProcessor);

const DEFAULT_STATE = {
  eq: { enabled: true, lowFreq: 120, lowGain: 0, midFreq: 1000, midGain: 0, midQ: 0.8, highFreq: 8000, highGain: 0 },
  distortion: { enabled: false, drive: 6, tone: 12000, mix: 0.35, output: 0 },
  clipper: { enabled: false, drive: 0, softness: 0.15, ceiling: -0.3 },
  reverb: { enabled: false, size: 0.55, decay: 2.0, preDelay: 0.02, damping: 10000, mix: 0.18 },
  compressor: { enabled: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, knee: 6, makeup: 0 }
};

let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let currentTabId = null;
let nodes = null;
let state = structuredClone(DEFAULT_STATE);
let reverbTimer = null;
let lastImpulseKey = '';

function mergeState(next) {
  if (!next) return structuredClone(DEFAULT_STATE);
  return {
    eq: { ...DEFAULT_STATE.eq, ...(next.eq || {}) },
    distortion: { ...DEFAULT_STATE.distortion, ...(next.distortion || {}) },
    clipper: { ...DEFAULT_STATE.clipper, ...(next.clipper || {}) },
    reverb: { ...DEFAULT_STATE.reverb, ...(next.reverb || {}) },
    compressor: { ...DEFAULT_STATE.compressor, ...(next.compressor || {}) }
  };
}

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

function setTarget(param, value, time = 0.015) {
  if (!audioContext) return;
  const now = audioContext.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, time);
}

function equalPower(mix) {
  const m = Math.max(0, Math.min(1, mix));
  return [Math.cos(m * Math.PI * 0.5), Math.sin(m * Math.PI * 0.5)];
}

function makeDistortionCurve() {
  const size = 32768;
  const curve = new Float32Array(size);
  const amount = 2.15;
  const norm = Math.tanh(amount);
  for (let i = 0; i < size; i++) {
    const x = i * 2 / (size - 1) - 1;
    curve[i] = Math.tanh(x * amount) / norm;
  }
  return curve;
}

function makeClipCurve(softness) {
  const size = 32768;
  const curve = new Float32Array(size);
  const soft = Math.max(0, Math.min(1, softness));
  const kneeStart = 1 - 0.72 * soft;
  const kneeWidth = Math.max(0.0001, 1 - kneeStart);
  for (let i = 0; i < size; i++) {
    const x = i * 2 / (size - 1) - 1;
    const sign = x < 0 ? -1 : 1;
    const a = Math.abs(x);
    let y = a;
    if (a > kneeStart) {
      if (soft < 0.0001) y = 1;
      else y = kneeStart + kneeWidth * Math.tanh((a - kneeStart) / kneeWidth);
    }
    curve[i] = sign * Math.min(1, y);
  }
  return curve;
}

function buildImpulse(size, decaySeconds) {
  const sampleRate = audioContext.sampleRate;
  const decay = Math.max(0.2, Math.min(8, decaySeconds));
  const room = Math.max(0, Math.min(1, size));
  const length = Math.max(1, Math.floor(sampleRate * decay));
  const impulse = audioContext.createBuffer(2, length, sampleRate);
  const density = 0.32 + room * 0.68;
  const diffusion = 0.6 + room * 1.7;
  for (let channel = 0; channel < 2; channel++) {
    const data = impulse.getChannelData(channel);
    let seed = (0x9e3779b9 ^ (channel * 0x85ebca6b) ^ Math.floor(room * 10000) ^ Math.floor(decay * 1000)) >>> 0;
    for (let i = 0; i < length; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      const noise = ((seed >>> 0) / 4294967295) * 2 - 1;
      const t = i / sampleRate;
      const envelope = Math.exp(-6.907755 * t / decay);
      const early = t < 0.12 + room * 0.08 ? 1 + 0.28 * Math.sin(t * sampleRate * (0.017 + channel * 0.003)) : 1;
      const sparse = ((i * 1103515245 + seed) >>> 0) / 4294967295 < density ? 1 : 0.42;
      data[i] = noise * envelope * early * sparse / diffusion;
    }
  }
  return impulse;
}

function makeAnalyser(ctx, fftSize = 2048) {
  const analyser = ctx.createAnalyser();
  analyser.fftSize = fftSize;
  analyser.smoothingTimeConstant = 0.72;
  analyser.minDecibels = -90;
  analyser.maxDecibels = -6;
  return analyser;
}

function createGraph() {
  const ctx = audioContext;

  const inputAnalyser = makeAnalyser(ctx, 4096);
  const inputSplitter = ctx.createChannelSplitter(2);
  const inputL = makeAnalyser(ctx, 512);
  const inputR = makeAnalyser(ctx, 512);
  const inputMeterSink = ctx.createGain();
  inputMeterSink.gain.value = 0;

  const eqLow = ctx.createBiquadFilter();
  const eqMid = ctx.createBiquadFilter();
  const eqHigh = ctx.createBiquadFilter();
  eqLow.type = 'lowshelf';
  eqMid.type = 'peaking';
  eqHigh.type = 'highshelf';
  const eqAnalyser = makeAnalyser(ctx, 4096);

  const distDry = ctx.createGain();
  const distPre = ctx.createGain();
  const distShape = ctx.createWaveShaper();
  const distTone = ctx.createBiquadFilter();
  const distWet = ctx.createGain();
  const distSum = ctx.createGain();
  const distOutput = ctx.createGain();
  distShape.curve = makeDistortionCurve();
  distShape.oversample = '4x';
  distTone.type = 'lowpass';
  distTone.Q.value = 0.55;

  const clipPreAnalyser = makeAnalyser(ctx, 1024);
  const clipDry = ctx.createGain();
  const clipDrive = ctx.createGain();
  const clipShape = ctx.createWaveShaper();
  const clipPost = ctx.createGain();
  const clipWet = ctx.createGain();
  const clipSum = ctx.createGain();
  const clipPostAnalyser = makeAnalyser(ctx, 1024);
  clipShape.curve = makeClipCurve(DEFAULT_STATE.clipper.softness);
  clipShape.oversample = '4x';

  const reverbDry = ctx.createGain();
  const reverbPreDelay = ctx.createDelay(0.2);
  const convolver = ctx.createConvolver();
  const reverbDamping = ctx.createBiquadFilter();
  const reverbWet = ctx.createGain();
  const reverbSum = ctx.createGain();
  reverbDamping.type = 'lowpass';
  reverbDamping.Q.value = 0.45;

  const compDry = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  const compMakeup = ctx.createGain();
  const compWet = ctx.createGain();
  const compSum = ctx.createGain();

  const output = ctx.createGain();
  const outputAnalyser = makeAnalyser(ctx, 4096);
  const outputSplitter = ctx.createChannelSplitter(2);
  const outputL = makeAnalyser(ctx, 512);
  const outputR = makeAnalyser(ctx, 512);
  const outputMeterSink = ctx.createGain();
  outputMeterSink.gain.value = 0;

  sourceNode.connect(inputAnalyser);
  sourceNode.connect(inputSplitter);
  inputSplitter.connect(inputL, 0);
  inputSplitter.connect(inputR, 1);
  inputL.connect(inputMeterSink);
  inputR.connect(inputMeterSink);
  inputMeterSink.connect(ctx.destination);

  inputAnalyser.connect(eqLow);
  eqLow.connect(eqMid);
  eqMid.connect(eqHigh);
  eqHigh.connect(eqAnalyser);

  eqAnalyser.connect(distDry);
  distDry.connect(distSum);
  eqAnalyser.connect(distPre);
  distPre.connect(distShape);
  distShape.connect(distTone);
  distTone.connect(distWet);
  distWet.connect(distSum);
  distSum.connect(distOutput);

  distOutput.connect(clipPreAnalyser);
  clipPreAnalyser.connect(clipDry);
  clipDry.connect(clipSum);
  clipPreAnalyser.connect(clipDrive);
  clipDrive.connect(clipShape);
  clipShape.connect(clipPost);
  clipPost.connect(clipWet);
  clipWet.connect(clipSum);
  clipSum.connect(clipPostAnalyser);

  clipPostAnalyser.connect(reverbDry);
  reverbDry.connect(reverbSum);
  clipPostAnalyser.connect(reverbPreDelay);
  reverbPreDelay.connect(convolver);
  convolver.connect(reverbDamping);
  reverbDamping.connect(reverbWet);
  reverbWet.connect(reverbSum);

  reverbSum.connect(compDry);
  compDry.connect(compSum);
  reverbSum.connect(compressor);
  compressor.connect(compMakeup);
  compMakeup.connect(compWet);
  compWet.connect(compSum);

  compSum.connect(output);
  output.connect(outputAnalyser);
  outputAnalyser.connect(ctx.destination);
  outputAnalyser.connect(outputSplitter);
  outputSplitter.connect(outputL, 0);
  outputSplitter.connect(outputR, 1);
  outputL.connect(outputMeterSink);
  outputR.connect(outputMeterSink);
  outputMeterSink.connect(ctx.destination);

  return { inputAnalyser, inputL, inputR, eqLow, eqMid, eqHigh, eqAnalyser, distDry, distPre, distShape, distTone, distWet, distSum, distOutput, clipPreAnalyser, clipDry, clipDrive, clipShape, clipPost, clipWet, clipSum, clipPostAnalyser, reverbDry, reverbPreDelay, convolver, reverbDamping, reverbWet, reverbSum, compDry, compressor, compMakeup, compWet, compSum, output, outputAnalyser, outputL, outputR };
}

function scheduleImpulseRebuild(force = false) {
  const key = `${state.reverb.size.toFixed(3)}:${state.reverb.decay.toFixed(3)}`;
  if (!force && key === lastImpulseKey) return;
  lastImpulseKey = key;
  clearTimeout(reverbTimer);
  reverbTimer = setTimeout(() => {
    if (!nodes || !audioContext) return;
    nodes.convolver.buffer = buildImpulse(state.reverb.size, state.reverb.decay);
  }, force ? 0 : 90);
}

function applyState(immediate = false) {
  if (!nodes || !audioContext) return;
  const t = immediate ? 0.001 : 0.018;

  const eqEnabled = state.eq.enabled;
  setTarget(nodes.eqLow.frequency, state.eq.lowFreq, t);
  setTarget(nodes.eqLow.gain, eqEnabled ? state.eq.lowGain : 0, t);
  setTarget(nodes.eqMid.frequency, state.eq.midFreq, t);
  setTarget(nodes.eqMid.Q, state.eq.midQ, t);
  setTarget(nodes.eqMid.gain, eqEnabled ? state.eq.midGain : 0, t);
  setTarget(nodes.eqHigh.frequency, state.eq.highFreq, t);
  setTarget(nodes.eqHigh.gain, eqEnabled ? state.eq.highGain : 0, t);

  const distEnabled = state.distortion.enabled;
  const [distDry, distWet] = distEnabled ? equalPower(state.distortion.mix) : [1, 0];
  setTarget(nodes.distPre.gain, dbToGain(state.distortion.drive), t);
  setTarget(nodes.distTone.frequency, state.distortion.tone, t);
  setTarget(nodes.distDry.gain, distDry, t);
  setTarget(nodes.distWet.gain, distWet, t);
  setTarget(nodes.distOutput.gain, distEnabled ? dbToGain(state.distortion.output) : 1, t);

  const clipEnabled = state.clipper.enabled;
  nodes.clipShape.curve = makeClipCurve(state.clipper.softness);
  setTarget(nodes.clipDrive.gain, dbToGain(state.clipper.drive), t);
  setTarget(nodes.clipPost.gain, dbToGain(state.clipper.ceiling), t);
  setTarget(nodes.clipDry.gain, clipEnabled ? 0 : 1, t);
  setTarget(nodes.clipWet.gain, clipEnabled ? 1 : 0, t);

  const reverbEnabled = state.reverb.enabled;
  const [reverbDry, reverbWet] = reverbEnabled ? equalPower(state.reverb.mix) : [1, 0];
  setTarget(nodes.reverbDry.gain, reverbDry, t);
  setTarget(nodes.reverbWet.gain, reverbWet, t);
  setTarget(nodes.reverbPreDelay.delayTime, state.reverb.preDelay, t);
  setTarget(nodes.reverbDamping.frequency, state.reverb.damping, t);
  scheduleImpulseRebuild(immediate);

  const compEnabled = state.compressor.enabled;
  setTarget(nodes.compressor.threshold, state.compressor.threshold, t);
  setTarget(nodes.compressor.ratio, state.compressor.ratio, t);
  setTarget(nodes.compressor.attack, state.compressor.attack, t);
  setTarget(nodes.compressor.release, state.compressor.release, t);
  setTarget(nodes.compressor.knee, state.compressor.knee, t);
  setTarget(nodes.compMakeup.gain, dbToGain(state.compressor.makeup), t);
  setTarget(nodes.compDry.gain, compEnabled ? 0 : 1, t);
  setTarget(nodes.compWet.gain, compEnabled ? 1 : 0, t);
}

function sampleSpectrum(analyser, points = 96) {
  const raw = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(raw);
  const nyquist = audioContext.sampleRate * 0.5;
  const result = new Array(points);
  const minLog = Math.log10(20);
  const maxLog = Math.log10(Math.min(20000, nyquist));
  for (let i = 0; i < points; i++) {
    const f = Math.pow(10, minLog + (maxLog - minLog) * i / (points - 1));
    const index = Math.max(0, Math.min(raw.length - 1, Math.round(f / nyquist * raw.length)));
    result[i] = Number.isFinite(raw[index]) ? raw[index] : -90;
  }
  return result;
}

function sampleWave(analyser, points = 128) {
  const raw = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(raw);
  const result = new Array(points);
  for (let i = 0; i < points; i++) {
    const index = Math.min(raw.length - 1, Math.floor(i * raw.length / points));
    result[i] = raw[index];
  }
  return result;
}

function meterDb(analyser) {
  const raw = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(raw);
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < raw.length; i++) {
    const a = Math.abs(raw[i]);
    if (a > peak) peak = a;
    sum += raw[i] * raw[i];
  }
  const rms = Math.sqrt(sum / raw.length);
  const peakDb = peak > 0.000001 ? 20 * Math.log10(peak) : -90;
  const rmsDb = rms > 0.000001 ? 20 * Math.log10(rms) : -90;
  return { peak: Math.max(-90, Math.min(6, peakDb)), rms: Math.max(-90, Math.min(6, rmsDb)) };
}

function sampleEqResponse(points = 96) {
  const freqs = new Float32Array(points);
  const lowMag = new Float32Array(points);
  const midMag = new Float32Array(points);
  const highMag = new Float32Array(points);
  const phase = new Float32Array(points);
  const minLog = Math.log10(20);
  const maxLog = Math.log10(Math.min(20000, audioContext.sampleRate * 0.5));
  for (let i = 0; i < points; i++) freqs[i] = Math.pow(10, minLog + (maxLog - minLog) * i / (points - 1));
  nodes.eqLow.getFrequencyResponse(freqs, lowMag, phase);
  nodes.eqMid.getFrequencyResponse(freqs, midMag, phase);
  nodes.eqHigh.getFrequencyResponse(freqs, highMag, phase);
  const result = new Array(points);
  for (let i = 0; i < points; i++) result[i] = 20 * Math.log10(Math.max(0.000001, lowMag[i] * midMag[i] * highMag[i]));
  return result;
}

function visualizerData() {
  if (!nodes || !audioContext) return { ok: true, running: false };
  return {
    ok: true,
    running: true,
    inputSpectrum: sampleSpectrum(nodes.inputAnalyser),
    outputSpectrum: sampleSpectrum(nodes.outputAnalyser),
    eqSpectrum: sampleSpectrum(nodes.eqAnalyser),
    eqResponse: sampleEqResponse(),
    preClipWave: sampleWave(nodes.clipPreAnalyser),
    postClipWave: sampleWave(nodes.clipPostAnalyser),
    inputMeter: { l: meterDb(nodes.inputL), r: meterDb(nodes.inputR) },
    outputMeter: { l: meterDb(nodes.outputL), r: meterDb(nodes.outputR) },
    reduction: state.compressor.enabled ? nodes.compressor.reduction : 0
  };
}

async function stopAudio() {
  clearTimeout(reverbTimer);
  reverbTimer = null;
  lastImpulseKey = '';
  if (mediaStream) for (const track of mediaStream.getTracks()) track.stop();
  if (sourceNode) {
    try { sourceNode.disconnect(); } catch (_) {}
  }
  if (audioContext) {
    try { await audioContext.close(); } catch (_) {}
  }
  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  nodes = null;
  currentTabId = null;
}

async function startAudio(streamId, tabId, nextState) {
  await stopAudio();
  state = mergeState(nextState);
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  audioContext = new AudioContext({ latencyHint: 'interactive' });
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  currentTabId = tabId;
  nodes = createGraph();
  nodes.convolver.buffer = buildImpulse(state.reverb.size, state.reverb.decay);
  lastImpulseKey = state.reverb.size.toFixed(3) + ':' + state.reverb.decay.toFixed(3);
  applyState(true);
  const track = mediaStream.getAudioTracks()[0];
  if (track) track.addEventListener('ended', () => stopAudio());
  if (audioContext.state === 'suspended') await audioContext.resume();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;
  if (message.type === 'start') {
    startAudio(message.streamId, message.tabId, message.state).then(() => sendResponse({ ok: true, tabId: currentTabId })).catch(async error => {
      await stopAudio();
      sendResponse({ ok: false, error: error.message });
    });
    return true;
  }
  if (message.type === 'stop') {
    stopAudio().then(() => sendResponse({ ok: true })).catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'update-state') {
    state = mergeState(message.state);
    applyState();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'get-visualizer') {
    try { sendResponse(visualizerData()); } catch (error) { sendResponse({ ok: false, running: false, error: error.message }); }
    return false;
  }
  return false;
});

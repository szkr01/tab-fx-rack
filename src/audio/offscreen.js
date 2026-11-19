let audioContext = null;
let mediaStream = null;
let sourceNode = null;
let currentTabId = null;
let nodes = null;
let state = normalizeRack(null);
let chainSignature = '';

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
  output.connect(outputAnalyser);
  outputAnalyser.connect(ctx.destination);
  outputAnalyser.connect(outputSplitter);
  outputSplitter.connect(outputL, 0);
  outputSplitter.connect(outputR, 1);
  outputL.connect(outputMeterSink);
  outputR.connect(outputMeterSink);
  outputMeterSink.connect(ctx.destination);
  return { inputAnalyser, inputL, inputR, output, outputAnalyser, outputL, outputR, stages: new Map() };
}

function createStage(effect) {
  const ctx = audioContext;
  const type = effect.type;
  if (type === 'eq') {
    const eqLow = ctx.createBiquadFilter();
    const eqMid = ctx.createBiquadFilter();
    const eqHigh = ctx.createBiquadFilter();
    const eqAnalyser = makeAnalyser(ctx, 4096);
    eqLow.type = 'lowshelf';
    eqMid.type = 'peaking';
    eqHigh.type = 'highshelf';
    eqLow.connect(eqMid);
    eqMid.connect(eqHigh);
    eqHigh.connect(eqAnalyser);
    return { type, input: eqLow, output: eqAnalyser, eqLow, eqMid, eqHigh, eqAnalyser };
  }
  if (type === 'distortion') {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const pre = ctx.createGain();
    const shape = ctx.createWaveShaper();
    const tone = ctx.createBiquadFilter();
    const wet = ctx.createGain();
    const sum = ctx.createGain();
    const output = ctx.createGain();
    shape.curve = makeDistortionCurve();
    shape.oversample = '4x';
    tone.type = 'lowpass';
    tone.Q.value = .55;
    input.connect(dry).connect(sum);
    input.connect(pre).connect(shape).connect(tone).connect(wet).connect(sum);
    sum.connect(output);
    return { type, input, output, dry, pre, shape, tone, wet };
  }
  if (type === 'clipper') {
    const input = makeAnalyser(ctx, 1024);
    const dry = ctx.createGain();
    const drive = ctx.createGain();
    const shape = ctx.createWaveShaper();
    const post = ctx.createGain();
    const wet = ctx.createGain();
    const sum = ctx.createGain();
    const output = makeAnalyser(ctx, 1024);
    shape.curve = makeClipCurve(EFFECT_DEFAULTS.clipper.softness);
    shape.oversample = '4x';
    input.connect(dry).connect(sum);
    input.connect(drive).connect(shape).connect(post).connect(wet).connect(sum);
    sum.connect(output);
    return { type, input, output, dry, drive, shape, post, wet };
  }
  if (type === 'reverb') {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const preDelay = ctx.createDelay(.2);
    const convolver = ctx.createConvolver();
    const damping = ctx.createBiquadFilter();
    const wet = ctx.createGain();
    const output = ctx.createGain();
    damping.type = 'lowpass';
    damping.Q.value = .45;
    input.connect(dry).connect(output);
    input.connect(preDelay).connect(convolver).connect(damping).connect(wet).connect(output);
    return { type, input, output, dry, preDelay, convolver, damping, wet, impulseKey: '', impulseTimer: null };
  }
  if (type === 'compressor') {
    const input = ctx.createGain();
    const dry = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    const makeup = ctx.createGain();
    const wet = ctx.createGain();
    const output = ctx.createGain();
    input.connect(dry).connect(output);
    input.connect(compressor).connect(makeup).connect(wet).connect(output);
    return { type, input, output, dry, compressor, makeup, wet };
  }
  const node = new AudioWorkletNode(ctx, 'doomer-processor', { channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2], processorOptions: { enabled: effect.enabled, amount: effect.amount, frequency: effect.frequency, pinch: effect.pinch } });
  return { type, input: node, output: node, node };
}

function rebuildChain() {
  nodes.inputAnalyser.disconnect();
  for (const stage of nodes.stages.values()) stage.output.disconnect();
  let previous = nodes.inputAnalyser;
  for (const effect of state.chain) {
    const stage = nodes.stages.get(effect.id);
    previous.connect(stage.input);
    previous = stage.output;
  }
  previous.connect(nodes.output);
}

function applyEffect(effect, stage, immediate = false) {
  const t = immediate ? .001 : .018;
  if (effect.type === 'eq') {
    setTarget(stage.eqLow.frequency, effect.lowFreq, t);
    setTarget(stage.eqLow.gain, effect.enabled ? effect.lowGain : 0, t);
    setTarget(stage.eqMid.frequency, effect.midFreq, t);
    setTarget(stage.eqMid.Q, effect.midQ, t);
    setTarget(stage.eqMid.gain, effect.enabled ? effect.midGain : 0, t);
    setTarget(stage.eqHigh.frequency, effect.highFreq, t);
    setTarget(stage.eqHigh.gain, effect.enabled ? effect.highGain : 0, t);
  } else if (effect.type === 'distortion') {
    const [dry, wet] = effect.enabled ? equalPower(effect.mix) : [1, 0];
    setTarget(stage.pre.gain, dbToGain(effect.drive), t);
    setTarget(stage.tone.frequency, effect.tone, t);
    setTarget(stage.dry.gain, dry, t);
    setTarget(stage.wet.gain, wet, t);
    setTarget(stage.output.gain, effect.enabled ? dbToGain(effect.output) : 1, t);
  } else if (effect.type === 'clipper') {
    if (stage.softness !== effect.softness) {
      stage.shape.curve = makeClipCurve(effect.softness);
      stage.softness = effect.softness;
    }
    setTarget(stage.drive.gain, dbToGain(effect.drive), t);
    setTarget(stage.post.gain, dbToGain(effect.ceiling), t);
    setTarget(stage.dry.gain, effect.enabled ? 0 : 1, t);
    setTarget(stage.wet.gain, effect.enabled ? 1 : 0, t);
  } else if (effect.type === 'reverb') {
    const [dry, wet] = effect.enabled ? equalPower(effect.mix) : [1, 0];
    setTarget(stage.dry.gain, dry, t);
    setTarget(stage.wet.gain, wet, t);
    setTarget(stage.preDelay.delayTime, effect.preDelay, t);
    setTarget(stage.damping.frequency, effect.damping, t);
    const key = effect.size.toFixed(3) + ':' + effect.decay.toFixed(3);
    if (key !== stage.impulseKey) {
      stage.impulseKey = key;
      clearTimeout(stage.impulseTimer);
      if (immediate) stage.convolver.buffer = buildImpulse(effect.size, effect.decay);
      else stage.impulseTimer = setTimeout(() => {
        if (nodes?.stages.get(effect.id) === stage) stage.convolver.buffer = buildImpulse(effect.size, effect.decay);
      }, 90);
    }
  } else if (effect.type === 'compressor') {
    setTarget(stage.compressor.threshold, effect.threshold, t);
    setTarget(stage.compressor.ratio, effect.ratio, t);
    setTarget(stage.compressor.attack, effect.attack, t);
    setTarget(stage.compressor.release, effect.release, t);
    setTarget(stage.compressor.knee, effect.knee, t);
    setTarget(stage.makeup.gain, dbToGain(effect.makeup), t);
    setTarget(stage.dry.gain, effect.enabled ? 0 : 1, t);
    setTarget(stage.wet.gain, effect.enabled ? 1 : 0, t);
  } else {
    stage.node.port.postMessage(effect);
  }
}

function syncGraph(immediate = false) {
  if (!nodes || !audioContext) return;
  const ids = new Set(state.chain.map(effect => effect.id));
  let changed = false;
  for (const [id, stage] of nodes.stages) {
    if (ids.has(id)) continue;
    stage.output.disconnect();
    if (stage.impulseTimer) clearTimeout(stage.impulseTimer);
    nodes.stages.delete(id);
    changed = true;
  }
  for (const effect of state.chain) {
    let stage = nodes.stages.get(effect.id);
    const isNew = !stage;
    if (isNew) {
      stage = createStage(effect);
      nodes.stages.set(effect.id, stage);
      changed = true;
    }
    const settingsKey = JSON.stringify(effect);
    if (immediate || isNew || stage.settingsKey !== settingsKey) {
      applyEffect(effect, stage, immediate || isNew);
      stage.settingsKey = settingsKey;
    }
  }
  const signature = state.chain.map(effect => effect.id).join('|');
  if (changed || signature !== chainSignature) {
    rebuildChain();
    chainSignature = signature;
  }
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

function sampleEqResponse(stage, points = 96) {
  const freqs = new Float32Array(points);
  const lowMag = new Float32Array(points);
  const midMag = new Float32Array(points);
  const highMag = new Float32Array(points);
  const phase = new Float32Array(points);
  const minLog = Math.log10(20);
  const maxLog = Math.log10(Math.min(20000, audioContext.sampleRate * 0.5));
  for (let i = 0; i < points; i++) freqs[i] = Math.pow(10, minLog + (maxLog - minLog) * i / (points - 1));
  stage.eqLow.getFrequencyResponse(freqs, lowMag, phase);
  stage.eqMid.getFrequencyResponse(freqs, midMag, phase);
  stage.eqHigh.getFrequencyResponse(freqs, highMag, phase);
  const result = new Array(points);
  for (let i = 0; i < points; i++) result[i] = 20 * Math.log10(Math.max(0.000001, lowMag[i] * midMag[i] * highMag[i]));
  return result;
}

function visualizerData() {
  if (!nodes || !audioContext) return { ok: true, running: false };
  const devices = {};
  for (const effect of state.chain) {
    const stage = nodes.stages.get(effect.id);
    if (effect.type === 'eq') devices[effect.id] = { eqSpectrum: sampleSpectrum(stage.eqAnalyser), eqResponse: sampleEqResponse(stage) };
    else if (effect.type === 'clipper') devices[effect.id] = { preClipWave: sampleWave(stage.input), postClipWave: sampleWave(stage.output) };
    else if (effect.type === 'compressor') devices[effect.id] = { reduction: effect.enabled ? stage.compressor.reduction : 0 };
  }
  return {
    ok: true, running: true, sampleRate: audioContext.sampleRate, devices,
    inputSpectrum: sampleSpectrum(nodes.inputAnalyser),
    outputSpectrum: sampleSpectrum(nodes.outputAnalyser),
    inputMeter: { l: meterDb(nodes.inputL), r: meterDb(nodes.inputR) },
    outputMeter: { l: meterDb(nodes.outputL), r: meterDb(nodes.outputR) }
  };
}

async function stopAudio() {
  if (nodes) for (const stage of nodes.stages.values()) clearTimeout(stage.impulseTimer);
  if (mediaStream) for (const track of mediaStream.getTracks()) track.stop();
  if (sourceNode) sourceNode.disconnect();
  if (audioContext) await audioContext.close();
  audioContext = null;
  mediaStream = null;
  sourceNode = null;
  nodes = null;
  chainSignature = '';
  currentTabId = null;
}

async function startAudio(streamId, tabId, nextState) {
  await stopAudio();
  state = normalizeRack(nextState);
  mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }, video: false });
  audioContext = new AudioContext({ latencyHint: 'interactive' });
  await audioContext.audioWorklet.addModule(chrome.runtime.getURL('src/audio/doomer-processor.js'));
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  currentTabId = tabId;
  nodes = createGraph();
  syncGraph(true);
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
    state = normalizeRack(message.state);
    syncGraph();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type === 'get-visualizer') {
    try { sendResponse(visualizerData()); } catch (error) { sendResponse({ ok: false, running: false, error: error.message }); }
    return false;
  }
  return false;
});

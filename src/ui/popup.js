let state = normalizeRack(null);
let presets = [];
let activeTab = null;
let runningTabId = null;
let supported = false;
let saveTimer = null;
let drag = null;
let draggedId = null;
let viz = null;
let vizTimer = null;
let holdSpectrum = false;
let heldSpectrum = null;
let spectrumSource = 'out';

const $ = id => document.getElementById(id);
const masterButton = $('masterButton');
const masterLabel = $('masterLabel');
const siteBadge = $('siteBadge');
const tabTitle = $('tabTitle');
const statusText = $('statusText');
const footer = document.querySelector('.footer');
const spectrumCanvas = $('spectrumCanvas');
const inputMeter = $('inputMeter');
const outputMeter = $('outputMeter');
const rack = document.querySelector('.rack');
const templates = new Map([...rack.querySelectorAll('.device')].map(card => [card.dataset.effectCard, card.cloneNode(true)]));

function effectFor(knob) {
  const id = knob.closest('.device').dataset.instanceId;
  return state.chain.find(effect => effect.id === id);
}

function getPath(knob) { return effectFor(knob)[knob.dataset.param.split('.')[1]]; }
function setPath(knob, value) { effectFor(knob)[knob.dataset.param.split('.')[1]] = value; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function dbToGain(db) { return Math.pow(10, db / 20); }
function roundStep(value, step) { const decimals = Math.max(0, (String(step).split('.')[1] || '').length); return Number((Math.round(value / step) * step).toFixed(decimals)); }

function valueToNorm(value, min, max, scale) {
  if (scale === 'log') return (Math.log(value) - Math.log(min)) / (Math.log(max) - Math.log(min));
  return (value - min) / (max - min);
}

function normToValue(norm, min, max, scale) {
  if (scale === 'log') return Math.exp(Math.log(min) + norm * (Math.log(max) - Math.log(min)));
  return min + norm * (max - min);
}

function formatValue(value, format) {
  if (format === 'db') return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`;
  if (format === 'dbplain') return `${value.toFixed(1)} dB`;
  if (format === 'pct') return `${Math.round(value * 100)}%`;
  if (format === 'hz') return value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 1 : 2)}k` : `${Math.round(value)} Hz`;
  if (format === 'sec') return `${value < 1 ? value.toFixed(2) : value.toFixed(1)} s`;
  if (format === 'ratio') return `${value.toFixed(1)}:1`;
  if (format === 'ms') return `${value * 1000 < 10 ? (value * 1000).toFixed(1) : Math.round(value * 1000)} ms`;
  if (format === 'q') return `Q ${value.toFixed(2)}`;
  if (format === 'stages') return `${value} STG`;
  return String(value);
}

function isSupportedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'soundcloud.com' || host.endsWith('.soundcloud.com');
  } catch (_) { return false; }
}

function siteName(url) {
  try {
    const host = new URL(url).hostname;
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) return 'YOUTUBE';
    if (host === 'soundcloud.com' || host.endsWith('.soundcloud.com')) return 'SOUNDCLOUD';
  } catch (_) {}
  return 'UNSUPPORTED';
}

function renderKnob(knob) {
  const value = getPath(knob);
  const min = Number(knob.dataset.min);
  const max = Number(knob.dataset.max);
  const norm = clamp(valueToNorm(value, min, max, knob.dataset.scale), 0, 1);
  const angle = -135 + norm * 270;
  knob.querySelector('.knob-face').style.setProperty('--angle', `${angle}deg`);
  knob.querySelector('.knob-face').style.setProperty('--fill', `${norm * 270}deg`);
  knob.querySelector('b').textContent = formatValue(value, knob.dataset.format);
  knob.setAttribute('role', 'slider');
  knob.setAttribute('tabindex', '0');
  knob.setAttribute('aria-valuemin', String(min));
  knob.setAttribute('aria-valuemax', String(max));
  knob.setAttribute('aria-valuenow', String(value));
}

function renderStatus(message = null, error = false) {
  const runningHere = activeTab && runningTabId === activeTab.id;
  const runningElsewhere = runningTabId !== null && !runningHere;
  masterButton.classList.toggle('active', runningTabId !== null);
  masterButton.disabled = !supported && runningTabId === null;
  masterLabel.textContent = runningHere ? 'STOP' : runningElsewhere ? (supported ? 'MOVE' : 'STOP') : 'START';
  footer.classList.toggle('running', runningHere && !error);
  footer.classList.toggle('error', error);
  if (message) statusText.innerHTML = `<i></i>${message}`;
  else if (runningHere) statusText.innerHTML = '<i></i>PROCESSING TAB AUDIO';
  else if (runningTabId !== null) statusText.innerHTML = '<i></i>RUNNING ON ANOTHER TAB';
  else if (supported) statusText.innerHTML = '<i></i>READY';
  else statusText.innerHTML = '<i></i>OPEN YOUTUBE OR SOUNDCLOUD';
}

function persistState() {
  clearTimeout(saveTimer);
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  saveTimer = setTimeout(() => chrome.runtime.sendMessage({ type: 'update-state', state }).catch(() => {}), 20);
}

function updateKnobFromNormalizedDelta(knob, deltaNorm, currentNorm = null) {
  const min = Number(knob.dataset.min);
  const max = Number(knob.dataset.max);
  const step = Number(knob.dataset.step);
  const current = getPath(knob);
  const norm = clamp((currentNorm ?? valueToNorm(current, min, max, knob.dataset.scale)) + deltaNorm, 0, 1);
  const next = roundStep(clamp(normToValue(norm, min, max, knob.dataset.scale), min, max), step);
  if (next !== current) {
    setPath(knob, next);
    renderKnob(knob);
    drawDevice(knob.closest('.device'));
    persistState();
  }
  return norm;
}

function bindKnobs(card) {
  card.querySelectorAll('.knob').forEach(knob => {
    knob.addEventListener('pointerdown', event => {
      event.preventDefault();
      knob.setPointerCapture(event.pointerId);
      drag = { knob, pointerId: event.pointerId, lastY: event.clientY, norm: valueToNorm(getPath(knob), Number(knob.dataset.min), Number(knob.dataset.max), knob.dataset.scale) };
    });
    knob.addEventListener('pointermove', event => {
      if (!drag || drag.knob !== knob || drag.pointerId !== event.pointerId) return;
      const deltaY = drag.lastY - event.clientY;
      drag.lastY = event.clientY;
      drag.norm = updateKnobFromNormalizedDelta(knob, deltaY * (event.shiftKey ? .0011 : .0042), drag.norm);
    });
    knob.addEventListener('pointerup', event => {
      if (drag?.knob === knob && drag.pointerId === event.pointerId) drag = null;
    });
    knob.addEventListener('wheel', event => {
      event.preventDefault();
      const stepNorm = knob.dataset.format === 'stages' ? Number(knob.dataset.step) / (Number(knob.dataset.max) - Number(knob.dataset.min)) : .008;
      updateKnobFromNormalizedDelta(knob, event.deltaY < 0 ? stepNorm : -stepNorm);
    }, { passive: false });
    knob.addEventListener('dblclick', event => {
      event.preventDefault();
      setPath(knob, Number(knob.dataset.default));
      renderKnob(knob);
      drawDevice(card);
      persistState();
    });
    knob.addEventListener('keydown', event => {
      if (!['ArrowUp', 'ArrowRight', 'ArrowDown', 'ArrowLeft'].includes(event.key)) return;
      event.preventDefault();
      const stepNorm = knob.dataset.format === 'stages' ? Number(knob.dataset.step) / (Number(knob.dataset.max) - Number(knob.dataset.min)) : .005;
      updateKnobFromNormalizedDelta(knob, ['ArrowUp', 'ArrowRight'].includes(event.key) ? stepNorm : -stepNorm);
    });
  });
}

function renderEffects() {
  for (const effect of state.chain) {
    const card = [...rack.children].find(node => node.dataset.instanceId === effect.id);
    const button = card.querySelector('.device-power');
    button.classList.toggle('on', effect.enabled);
    card.classList.toggle('off', !effect.enabled);
    card.querySelectorAll('.knob').forEach(renderKnob);
  }
  drawDeviceVisuals();
}

function renderOrder() {
  const label = document.querySelector('.chain-label');
  label.replaceChildren();
  const names = ['IN', ...state.chain.map(effect => EFFECT_NAMES[effect.type]), 'OUT'];
  const counts = {};
  for (const [index, name] of names.entries()) {
    if (index) label.appendChild(document.createElement('i'));
    const part = document.createElement('span');
    part.textContent = name;
    if (index > 0 && index <= state.chain.length) {
      const effect = state.chain[index - 1];
      counts[effect.type] = (counts[effect.type] || 0) + 1;
      part.textContent += ' ' + counts[effect.type];
      part.className = 'chain-effect';
      part.title = 'Show ' + part.textContent;
      part.addEventListener('click', () => {
        const card = [...rack.children].find(node => node.dataset.instanceId === effect.id);
        card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      });
    }
    label.appendChild(part);
  }
  state.chain.forEach((effect, index) => {
    const card = [...rack.children].find(node => node.dataset.instanceId === effect.id);
    rack.appendChild(card);
    card.querySelector('.device-header em').textContent = String(index + 1).padStart(2, '0');
    const [left, right] = card.querySelectorAll('.order-button');
    left.disabled = index === 0;
    right.disabled = index === state.chain.length - 1;
  });
}

function moveEffect(id, step) {
  const from = state.chain.findIndex(effect => effect.id === id);
  const to = from + step;
  if (to < 0 || to >= state.chain.length) return;
  const [effect] = state.chain.splice(from, 1);
  state.chain.splice(to, 0, effect);
  renderOrder();
  [...rack.children].find(card => card.dataset.instanceId === id).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  persistState();
}

function renderRack() {
  rack.replaceChildren();
  for (const effect of state.chain) {
    const card = templates.get(effect.type).cloneNode(true);
    card.dataset.instanceId = effect.id;
    card.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    card.querySelector('.device-power').addEventListener('click', () => {
      effect.enabled = !effect.enabled;
      renderEffects();
      persistState();
    });
    const header = card.querySelector('.device-header');
    const handle = header.querySelector('span');
    handle.classList.add('drag-handle');
    handle.draggable = true;
    handle.title = 'Drag to reorder';
    for (const [name, step] of [['‹', -1], ['›', 1]]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'order-button';
      button.textContent = name;
      button.title = step < 0 ? 'Move left' : 'Move right';
      button.addEventListener('click', () => moveEffect(effect.id, step));
      header.insertBefore(button, header.querySelector('em'));
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'device-remove';
    remove.title = 'Remove effect';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.chain = state.chain.filter(item => item.id !== effect.id);
      renderRack();
      persistState();
    });
    header.appendChild(remove);
    handle.addEventListener('dragstart', event => {
      draggedId = effect.id;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', effect.id);
    });
    handle.addEventListener('dragend', () => {
      draggedId = null;
      rack.querySelectorAll('.drop-target').forEach(item => item.classList.remove('drop-target'));
    });
    card.addEventListener('dragover', event => {
      if (!draggedId || draggedId === effect.id) return;
      event.preventDefault();
      card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', event => {
      event.preventDefault();
      card.classList.remove('drop-target');
      if (!draggedId || draggedId === effect.id) return;
      const from = state.chain.findIndex(item => item.id === draggedId);
      const [moving] = state.chain.splice(from, 1);
      const target = state.chain.findIndex(item => item.id === effect.id);
      const after = event.clientX > card.getBoundingClientRect().left + card.offsetWidth / 2;
      state.chain.splice(target + (after ? 1 : 0), 0, moving);
      renderOrder();
      persistState();
    });
    bindKnobs(card);
    rack.appendChild(card);
  }
  renderOrder();
  renderEffects();
}

function drawDevice(card) {
  if (!card) return;
  const effect = state.chain.find(item => item.id === card.dataset.instanceId);
  const canvas = card.querySelector('.device-canvas, .comp-visual canvas');
  const data = viz?.devices?.[effect.id];
  if (effect.type === 'eq') drawEq(canvas, effect, data);
  else if (effect.type === 'distortion') drawDistortion(canvas, effect);
  else if (effect.type === 'clipper') drawClipper(canvas, effect, data);
  else if (effect.type === 'reverb') drawReverb(canvas, effect);
  else if (effect.type === 'compressor') drawComp(canvas, effect, data, card.querySelector('.gr-meter i'), card.querySelector('.gr-meter b'));
  else drawDoomer(canvas, effect);
}
function drawDeviceVisuals() { for (const card of rack.children) drawDevice(card); }
function drawAll() { drawSpectrum(); drawMeter(inputMeter, viz?.inputMeter); drawMeter(outputMeter, viz?.outputMeter); drawDeviceVisuals(); }

function renderAddMenu() {
  const menu = $('addFxMenu');
  for (const type of EFFECT_TYPES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = '+ ' + EFFECT_NAMES[type];
    button.addEventListener('click', () => {
      const effect = makeEffect(type);
      state.chain.push(effect);
      renderRack();
      menu.hidden = true;
      [...rack.children].at(-1).scrollIntoView({ block: 'nearest', inline: 'nearest' });
      persistState();
    });
    menu.appendChild(button);
  }
}

async function storePresets() {
  if (globalThis.chrome?.storage?.local) await chrome.storage.local.set({ fxPresets: presets });
}

function renderPresets() {
  const list = $('presetList');
  list.replaceChildren();
  if (!presets.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No presets saved.';
    list.appendChild(empty);
  }
  for (const preset of presets) {
    const row = document.createElement('div');
    row.className = 'preset-row';
    const name = document.createElement('input');
    name.type = 'text';
    name.maxLength = 80;
    name.value = preset.name;
    name.title = 'Edit preset name';
    row.appendChild(name);
    for (const [caption, action] of [
      ['LOAD', () => {
        state = normalizeRack(structuredClone(preset.rack));
        renderRack();
        persistState();
        $('presetPanel').hidden = true;
      }],
      ['RENAME', async () => {
        if (!name.value.trim()) return;
        preset.name = name.value.trim();
        await storePresets();
        renderPresets();
      }],
      ['DELETE', async () => {
        presets = presets.filter(item => item.id !== preset.id);
        await storePresets();
        renderPresets();
      }]
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = caption;
      button.addEventListener('click', () => Promise.resolve(action()).catch(error => renderStatus(error.message, true)));
      row.appendChild(button);
    }
    list.appendChild(row);
  }
}

function bindRackControls() {
  renderAddMenu();
  $('addFxButton').addEventListener('click', () => {
    $('addFxMenu').hidden = !$('addFxMenu').hidden;
    $('presetPanel').hidden = true;
  });
  $('presetsButton').addEventListener('click', () => {
    $('presetPanel').hidden = false;
    $('addFxMenu').hidden = true;
    renderPresets();
  });
  $('closePresets').addEventListener('click', () => { $('presetPanel').hidden = true; });
  $('savePreset').addEventListener('click', async () => {
    const name = $('presetName').value.trim() || 'Preset ' + (presets.length + 1);
    presets.push({ id: crypto.randomUUID(), name, rack: structuredClone(state) });
    try {
      await storePresets();
      $('presetName').value = '';
      renderPresets();
    } catch (error) { renderStatus(error.message, true); }
  });
  $('presetName').addEventListener('keydown', event => {
    if (event.key === 'Enter') $('savePreset').click();
  });
  rack.addEventListener('wheel', event => {
    if (event.target.closest('.knob') || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
    event.preventDefault();
    rack.scrollLeft += event.deltaY;
  }, { passive: false });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('presetPanel').hidden = true; $('addFxMenu').hidden = true; }
  });
}
function canvasSize(canvas) { return { ctx: canvas.getContext('2d'), w: canvas.width, h: canvas.height }; }
function clearCanvas(ctx, w, h) { ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#202425'; ctx.fillRect(0, 0, w, h); }
function drawGrid(ctx, w, h, cols = 6, rows = 4) {
  ctx.strokeStyle = 'rgba(255,255,255,.055)'; ctx.lineWidth = 1;
  for (let i = 1; i < cols; i++) { const x = Math.round(i * w / cols) + .5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let i = 1; i < rows; i++) { const y = Math.round(i * h / rows) + .5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}
function drawZero(ctx, w, h) { ctx.strokeStyle = 'rgba(255,255,255,.13)'; ctx.beginPath(); ctx.moveTo(0, h / 2 + .5); ctx.lineTo(w, h / 2 + .5); ctx.stroke(); }

function drawSpectrum() {
  const { ctx, w, h } = canvasSize(spectrumCanvas);
  clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 10, 4);
  const source = spectrumSource === 'in' ? viz?.inputSpectrum : viz?.outputSpectrum;
  const data = holdSpectrum && heldSpectrum ? heldSpectrum : source;
  if (!data) {
    ctx.fillStyle = '#5d6465'; ctx.font = '8px Segoe UI'; ctx.fillText('20', 4, h - 4); ctx.fillText('100', w * .22, h - 4); ctx.fillText('1k', w * .55, h - 4); ctx.fillText('10k', w * .86, h - 4); return;
  }
  if (holdSpectrum) heldSpectrum = data.slice();
  ctx.beginPath();
  for (let i = 0; i < data.length; i++) {
    const x = i / (data.length - 1) * w;
    const y = clamp((-6 - data[i]) / 84, 0, 1) * (h - 10);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.4; ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, h); gradient.addColorStop(0, 'rgba(99,184,200,.24)'); gradient.addColorStop(1, 'rgba(99,184,200,.015)'); ctx.fillStyle = gradient; ctx.fill();
  if (viz?.inputSpectrum && spectrumSource === 'out' && !holdSpectrum) {
    ctx.beginPath();
    for (let i = 0; i < viz.inputSpectrum.length; i++) {
      const x = i / (viz.inputSpectrum.length - 1) * w;
      const y = clamp((-6 - viz.inputSpectrum[i]) / 84, 0, 1) * (h - 10);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(210,214,214,.22)'; ctx.lineWidth = 1; ctx.stroke();
  }
  ctx.fillStyle = '#666d6e'; ctx.font = '7px Segoe UI';
  [['20',4],['50',.13],['100',.23],['500',.43],['1k',.55],['5k',.76],['10k',.87],['20k',.96]].forEach(([label,x]) => ctx.fillText(label, typeof x === 'number' && x < 1 ? x*w : x, h - 3));
}

function drawMeter(canvas, meter) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h);
  const channels = meter ? [meter.l, meter.r] : [{peak:-90,rms:-90},{peak:-90,rms:-90}];
  const barW = 10; const gap = 8; const startX = Math.round((w - (barW * 2 + gap)) / 2);
  for (let c = 0; c < 2; c++) {
    const x = startX + c * (barW + gap);
    ctx.fillStyle = '#171a1b'; ctx.fillRect(x, 5, barW, h - 17);
    const norm = clamp((channels[c].rms + 60) / 60, 0, 1);
    const peakNorm = clamp((channels[c].peak + 60) / 60, 0, 1);
    const fillH = norm * (h - 19);
    ctx.fillStyle = '#6e9b62'; ctx.fillRect(x + 1, h - 13 - fillH, barW - 2, fillH);
    if (channels[c].rms > -12) { const hotNorm = clamp((channels[c].rms + 12) / 12, 0, 1); ctx.fillStyle = '#c99a48'; ctx.fillRect(x + 1, h - 13 - fillH, barW - 2, fillH * hotNorm); }
    const py = h - 13 - peakNorm * (h - 19); ctx.fillStyle = channels[c].peak > -3 ? '#d49a45' : '#9a9f72'; ctx.fillRect(x, py, barW, 1);
    ctx.fillStyle = '#73797a'; ctx.font = '7px Segoe UI'; ctx.fillText(c === 0 ? 'L' : 'R', x + 2, h - 3);
  }
}

function drawEq(canvas, params, reading) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 6, 4); drawZero(ctx, w, h);
  const spectrum = reading?.eqSpectrum;
  if (spectrum) {
    ctx.beginPath();
    for (let i = 0; i < spectrum.length; i++) {
      const x = i / (spectrum.length - 1) * w;
      const y = h - clamp((spectrum[i] + 80) / 74, 0, 1) * h;
      if (i === 0) ctx.moveTo(x, h); ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h); ctx.closePath(); ctx.fillStyle = 'rgba(99,184,200,.07)'; ctx.fill();
  }
  const response = reading?.eqResponse;
  if (response) {
    ctx.beginPath();
    for (let i = 0; i < response.length; i++) {
      const x = i / (response.length - 1) * w;
      const y = h / 2 - clamp(response[i], -18, 18) / 36 * h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.6; ctx.stroke();
  } else {
    ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
  }
  ctx.fillStyle = '#6c7273'; ctx.font = '6px Segoe UI'; ctx.fillText('20',3,h-3); ctx.fillText('1k',w*.53,h-3); ctx.fillText('20k',w-18,h-3);
}

function drawDistortion(canvas, params) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 4, 4); drawZero(ctx, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.beginPath(); ctx.moveTo(w/2,0); ctx.lineTo(w/2,h); ctx.stroke();
  const gain = dbToGain(params.drive); const amount = 2.15; const norm = Math.tanh(amount); const outGain = dbToGain(params.output);
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const x = i / (w - 1) * 2 - 1;
    const shapedInput = clamp(x * gain, -1, 1);
    const y = Math.tanh(shapedInput * amount) / norm * outGain;
    const py = h / 2 - clamp(y, -1.15, 1.15) / 2.3 * h;
    if (i === 0) ctx.moveTo(i, py); else ctx.lineTo(i, py);
  }
  ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.beginPath(); ctx.moveTo(0,h); ctx.lineTo(w,0); ctx.stroke();
}

function drawClipper(canvas, params, reading) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 4, 4); drawZero(ctx, w, h);
  const ceiling = dbToGain(params.ceiling); const yTop = h / 2 - ceiling * h * .42; const yBottom = h / 2 + ceiling * h * .42;
  ctx.setLineDash([3,3]); ctx.strokeStyle = 'rgba(212,154,69,.48)'; ctx.beginPath(); ctx.moveTo(0,yTop); ctx.lineTo(w,yTop); ctx.moveTo(0,yBottom); ctx.lineTo(w,yBottom); ctx.stroke(); ctx.setLineDash([]);
  const pre = reading?.preClipWave; const post = reading?.postClipWave;
  if (pre) { ctx.beginPath(); pre.forEach((v,i) => { const x=i/(pre.length-1)*w; const y=h/2-v*h*.42; if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y); }); ctx.strokeStyle='rgba(210,214,214,.25)'; ctx.lineWidth=1; ctx.stroke(); }
  if (post) { ctx.beginPath(); post.forEach((v,i) => { const x=i/(post.length-1)*w; const y=h/2-v*h*.42; if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y); }); ctx.strokeStyle='#63b8c8'; ctx.lineWidth=1.4; ctx.stroke(); }
}

function drawReverb(canvas, params) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 4, 4);
  const room = params.size; const decay = params.decay; const pre = params.preDelay;
  const preX = clamp(pre / .12, 0, 1) * w * .28;
  ctx.strokeStyle = 'rgba(212,154,69,.55)'; ctx.beginPath(); ctx.moveTo(preX, 5); ctx.lineTo(preX, h-5); ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const tNorm = Math.max(0, (i - preX) / Math.max(1, w - preX));
    const env = Math.exp(-6.2 * tNorm * (2 / decay));
    const texture = .78 + .22 * Math.sin(i * (.18 + room * .11)) * Math.sin(i * .47);
    const amp = i < preX ? 0 : env * texture;
    const y = h / 2 - amp * h * .42;
    if (i === 0) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  }
  ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.2; ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < w; i++) {
    const tNorm = Math.max(0, (i - preX) / Math.max(1, w - preX)); const env = Math.exp(-6.2 * tNorm * (2 / decay)); const y = h / 2 + (i < preX ? 0 : env) * h * .42; if(i===0)ctx.moveTo(i,y);else ctx.lineTo(i,y);
  }
  ctx.strokeStyle = 'rgba(99,184,200,.34)'; ctx.stroke();
}

function compressorOutputDb(inputDb, params) {
  const threshold = params.threshold; const ratio = params.ratio; const knee = params.knee;
  if (knee <= 0) return inputDb <= threshold ? inputDb : threshold + (inputDb - threshold) / ratio;
  const half = knee / 2;
  if (inputDb < threshold - half) return inputDb;
  if (inputDb > threshold + half) return threshold + (inputDb - threshold) / ratio;
  const x = inputDb - (threshold - half);
  return inputDb + (1 / ratio - 1) * x * x / (2 * knee);
}

function drawComp(canvas, params, reading, grFill, grValue) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 4, 4);
  ctx.strokeStyle='rgba(255,255,255,.16)';ctx.beginPath();ctx.moveTo(0,h);ctx.lineTo(w,0);ctx.stroke();
  ctx.beginPath();
  for(let i=0;i<w;i++){const inDb=-60+i/(w-1)*60;const outDb=compressorOutputDb(inDb, params)+params.makeup;const y=h-clamp((outDb+60)/60,0,1)*h;if(i===0)ctx.moveTo(i,y);else ctx.lineTo(i,y)}
  ctx.strokeStyle='#63b8c8';ctx.lineWidth=1.5;ctx.stroke();
  const tx=(params.threshold+60)/60*w;ctx.strokeStyle='rgba(212,154,69,.45)';ctx.beginPath();ctx.moveTo(tx,0);ctx.lineTo(tx,h);ctx.stroke();
  const reduction = Math.min(0, reading?.reduction ?? 0); const amount = clamp(-reduction / 24, 0, 1); grFill.style.height = `${amount * 63}px`; grFill.style.top = `${14}px`; grValue.textContent = `${reduction.toFixed(1)}`;
}

function drawDoomer(canvas, params) {
  const { ctx, w, h } = canvasSize(canvas); clearCanvas(ctx, w, h); drawGrid(ctx, w, h, 4, 4);
  const fs = viz?.sampleRate || 48000;
  const f0 = Math.min(params.frequency, fs * .49);
  const q = .5 + 15.5 * params.pinch ** 4;
  const omega0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(omega0) / (2 * q);
  const a1 = -2 * Math.cos(omega0) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  const delay = [];
  for (let i = 0; i < w; i++) {
    const f = 20 * Math.pow(Math.min(20000, fs * .49) / 20, i / (w - 1));
    const omega = 2 * Math.PI * f / fs;
    const re = (1 + a2) * Math.cos(omega) + a1;
    const im = (1 - a2) * Math.sin(omega);
    const dre = -(1 + a2) * Math.sin(omega);
    const dim = (1 - a2) * Math.cos(omega);
    delay.push(Math.max(0, 2 * params.amount * (re * dim - im * dre) / (re * re + im * im) / fs * 1000));
  }
  const max = Math.max(1, ...delay);
  ctx.beginPath();
  delay.forEach((value, i) => {
    const y = h - 8 - Math.log1p(value) / Math.log1p(max) * (h - 16);
    if (!i) ctx.moveTo(i, y); else ctx.lineTo(i, y);
  });
  ctx.strokeStyle = '#63b8c8'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#777e80'; ctx.font = '7px Segoe UI';
  ctx.fillText('GROUP DELAY', 4, 10);
  ctx.fillText(`${max.toFixed(1)}ms`, w - 39, 10);
}

async function pollVisualizer() {
  if (!globalThis.chrome?.runtime?.sendMessage || !activeTab || runningTabId !== activeTab.id) { viz = null; drawAll(); return; }
  try {
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'get-visualizer' });
    if (response?.ok && response.running) viz = response; else viz = null;
  } catch (_) { viz = null; }
  drawAll();
}

function startVisualizer() { clearInterval(vizTimer); pollVisualizer(); vizTimer = setInterval(pollVisualizer, 70); }

async function refreshTab() {
  if (!globalThis.chrome?.tabs?.query) {
    activeTab = { id: 1, url: 'https://www.youtube.com/watch?v=demo', title: 'Demo track' }; supported = true; runningTabId = null; siteBadge.textContent = 'YOUTUBE'; siteBadge.classList.add('supported'); tabTitle.textContent = 'Demo track'; renderStatus(); return;
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  supported = !!activeTab && isSupportedUrl(activeTab.url || '');
  siteBadge.textContent = activeTab ? siteName(activeTab.url || '') : 'NO TAB';
  siteBadge.classList.toggle('supported', supported);
  tabTitle.textContent = activeTab?.title || 'Open YouTube or SoundCloud';
  const status = await chrome.runtime.sendMessage({ type: 'get-status' }).catch(() => ({ runningTabId: null }));
  runningTabId = status?.runningTabId ?? null;
  renderStatus();
}

async function toggleCapture() {
  if (!globalThis.chrome?.runtime?.sendMessage) return;
  const runningHere = activeTab && runningTabId === activeTab.id;
  const runningElsewhere = runningTabId !== null && !runningHere;
  masterButton.disabled = true;
  try {
    if (runningHere || (runningElsewhere && !supported)) {
      const result = await chrome.runtime.sendMessage({ type: 'stop-capture' });
      if (!result?.ok) throw new Error(result?.error || 'Unable to stop processing.');
      runningTabId = null;
    } else {
      if (!activeTab || !supported) return;
      const result = await chrome.runtime.sendMessage({ type: 'start-capture', tabId: activeTab.id });
      if (!result?.ok) throw new Error(result?.error || 'Unable to start processing.');
      runningTabId = result.runningTabId;
    }
    renderStatus();
    startVisualizer();
  } catch (error) {
    renderStatus(error.message || 'AUDIO ENGINE ERROR', true);
  } finally { masterButton.disabled = !supported && runningTabId === null; }
}

async function init() {
  bindRackControls();
  masterButton.addEventListener('click', toggleCapture);
  $('spectrumMode').addEventListener('click', () => {
    spectrumSource = spectrumSource === 'out' ? 'in' : 'out';
    $('spectrumMode').textContent = spectrumSource.toUpperCase();
    heldSpectrum = null;
    drawSpectrum();
  });
  $('holdButton').addEventListener('click', () => {
    holdSpectrum = !holdSpectrum;
    $('holdButton').classList.toggle('active', holdSpectrum);
    if (!holdSpectrum) heldSpectrum = null;
    drawSpectrum();
  });
  if (globalThis.chrome?.storage?.local) {
    const stored = await chrome.storage.local.get(['fxState', 'fxPresets']);
    state = normalizeRack(stored.fxState);
    presets = Array.isArray(stored.fxPresets) ? stored.fxPresets.filter(item => item && typeof item.name === 'string' && Array.isArray(item.rack?.chain)) : [];
  }
  renderRack();
  await refreshTab();
  startVisualizer();
}

init().catch(error => renderStatus(error.message || 'INITIALIZATION ERROR', true));

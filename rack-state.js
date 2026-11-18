const EFFECT_TYPES = ['eq', 'distortion', 'clipper', 'reverb', 'compressor', 'disperser'];
const EFFECT_NAMES = { eq: 'EQ', distortion: 'DISTORTION', clipper: 'CLIPPER', reverb: 'REVERB', compressor: 'COMP', disperser: 'DISPERSER' };
const EFFECT_DEFAULTS = {
  eq: { enabled: true, lowFreq: 120, lowGain: 0, midFreq: 1000, midGain: 0, midQ: 0.8, highFreq: 8000, highGain: 0 },
  distortion: { enabled: false, drive: 6, tone: 12000, mix: 0.35, output: 0 },
  clipper: { enabled: false, drive: 0, softness: 0.15, ceiling: -0.3 },
  reverb: { enabled: false, size: 0.55, decay: 2, preDelay: 0.02, damping: 10000, mix: 0.18 },
  compressor: { enabled: false, threshold: -18, ratio: 4, attack: 0.01, release: 0.18, knee: 6, makeup: 0 },
  disperser: { enabled: false, amount: 16, frequency: 130, pinch: 0 }
};

function makeEffect(type, id = crypto.randomUUID()) {
  return { id, type, ...EFFECT_DEFAULTS[type] };
}

function normalizeRack(saved) {
  if (Array.isArray(saved?.chain)) {
    const ids = new Set();
    return {
      chain: saved.chain.filter(item => item && EFFECT_TYPES.includes(item.type)).map(item => {
        const id = typeof item.id === 'string' && item.id && !ids.has(item.id) ? item.id : crypto.randomUUID();
        ids.add(id);
        return { ...makeEffect(item.type, id), ...item, id, type: item.type };
      })
    };
  }
  const order = Array.isArray(saved?.order) && saved.order.length === EFFECT_TYPES.length && EFFECT_TYPES.every(type => saved.order.includes(type)) ? saved.order : EFFECT_TYPES;
  return { chain: order.map(type => ({ ...makeEffect(type, 'legacy-' + type), ...(saved?.[type] || {}) })) };
}

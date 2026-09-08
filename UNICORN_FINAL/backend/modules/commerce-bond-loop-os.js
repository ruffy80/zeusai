'use strict';
/**
 * CBLOS/1.0 — Commerce Bond Loop OS
 * Site↔backend profit-path alignment without inventing GMV.
 *
 * Two processes (unicorn-site + unicorn-backend) share beats via
 * data/cblos/beats.jsonl (production: the shared data symlink). Score
 * hydrates from disk so neither peer can look green while the other
 * is serving a different catalog, quote, or BTC rate.
 *
 * Score (0–100):
 *   40 catalog hash match   30 last quote/checkout USD agree
 *   20 BTC rate within 1%   10 checkout funnel continuity
 *
 * Observe-only under stable. Never mutates source files. Never invents paid orders.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 'CBLOS/1.0';
const DATA_DIR = process.env.CBLOS_DATA_DIR
  || path.join(__dirname, '..', '..', 'data', 'cblos');
const BEATS_FILE = path.join(DATA_DIR, 'beats.jsonl');
const MAX_BEATS = 200;

const _state = {
  running: false,
  startedAt: null,
  beats: [],
  lastScore: null,
  _timer: null,
};

function _persistEnabled() {
  return process.env.NODE_ENV !== 'test' || !!process.env.CBLOS_DATA_DIR;
}

function _ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
}

function _hydrate() {
  if (!_persistEnabled()) return;
  try {
    if (!fs.existsSync(BEATS_FILE)) return;
    const raw = fs.readFileSync(BEATS_FILE, 'utf8');
    const loaded = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { loaded.push(JSON.parse(line)); } catch (_) { /* skip bad line */ }
    }
    if (loaded.length) _state.beats = loaded.slice(-MAX_BEATS);
  } catch (_) { /* keep in-memory */ }
}

function hashCatalog(items) {
  const ids = (Array.isArray(items) ? items : [])
    .map((it) => String(it && (it.id || it.serviceId) || ''))
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 24);
}

function recordBeat(kind, payload = {}) {
  const beat = {
    v: '1',
    protocol: PROTOCOL,
    kind: String(kind || 'unknown').slice(0, 48),
    peer: String(payload.peer || 'unicorn').slice(0, 16),
    serviceId: payload.serviceId ? String(payload.serviceId).slice(0, 128) : undefined,
    catalogHash: payload.catalogHash || undefined,
    priceUsd: Number.isFinite(Number(payload.priceUsd)) ? Number(payload.priceUsd) : undefined,
    btcRateUsd: Number.isFinite(Number(payload.btcRateUsd)) ? Number(payload.btcRateUsd) : undefined,
    orderId: payload.orderId ? String(payload.orderId).slice(0, 80) : undefined,
    ts: new Date().toISOString(),
  };
  _state.beats.push(beat);
  if (_state.beats.length > MAX_BEATS) _state.beats.splice(0, _state.beats.length - MAX_BEATS);
  if (_persistEnabled()) {
    _ensureDir();
    try { fs.appendFileSync(BEATS_FILE, JSON.stringify(beat) + '\n'); } catch (_) { /* ignore */ }
  }
  return beat;
}

function _last(kind, peer) {
  for (let i = _state.beats.length - 1; i >= 0; i--) {
    const b = _state.beats[i];
    if (b.kind === kind && (!peer || b.peer === peer)) return b;
  }
  return null;
}

function score() {
  _hydrate();
  const siteCat = _last('catalog_snapshot', 'site');
  const uniCat = _last('catalog_snapshot', 'unicorn') || _last('catalog_snapshot', 'backend');
  const catalogPts = (siteCat && uniCat && siteCat.catalogHash && siteCat.catalogHash === uniCat.catalogHash)
    ? 40
    : (siteCat || uniCat ? 18 : 8);

  const quote = _last('quote') || _last('checkout_create');
  const checkout = _last('checkout_create');
  let quotePts = 12;
  if (quote && checkout && quote.serviceId && quote.serviceId === checkout.serviceId) {
    const a = Number(quote.priceUsd);
    const b = Number(checkout.priceUsd);
    quotePts = (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.05) ? 30 : 16;
  } else if (checkout) quotePts = 20;

  const siteBtc = _last('btc_rate', 'site');
  const uniBtc = _last('btc_rate', 'unicorn') || _last('btc_rate', 'backend');
  let btcPts = 8;
  if (siteBtc && uniBtc && siteBtc.btcRateUsd > 0 && uniBtc.btcRateUsd > 0) {
    const rel = Math.abs(siteBtc.btcRateUsd - uniBtc.btcRateUsd) / Math.max(siteBtc.btcRateUsd, uniBtc.btcRateUsd);
    btcPts = rel <= 0.01 ? 20 : (rel <= 0.05 ? 12 : 6);
  } else if (siteBtc || uniBtc) btcPts = 12;

  const funnelPts = checkout ? 10 : 4;
  const total = Math.max(0, Math.min(100, catalogPts + quotePts + btcPts + funnelPts));
  const grade = total >= 90 ? 'A' : total >= 75 ? 'B' : total >= 55 ? 'C' : 'D';
  const out = {
    protocol: PROTOCOL,
    score: total,
    grade,
    bonded: total >= 75,
    stableIdleOk: total >= 80,
    inventsGmv: false,
    parts: { catalog: catalogPts, quote: quotePts, btc: btcPts, funnel: funnelPts },
    beats: _state.beats.length,
    ts: new Date().toISOString(),
  };
  _state.lastScore = out;
  return out;
}

function getScore() { return score(); }

function getStatus() {
  const sc = score();
  return {
    ok: true,
    protocol: PROTOCOL,
    name: 'Commerce Bond Loop OS',
    running: _state.running,
    startedAt: _state.startedAt,
    health: _state.running ? 'ok' : 'observe',
    inventsGmv: false,
    ...sc,
  };
}

function discovery() {
  return {
    ok: true,
    protocol: PROTOCOL,
    role: 'site↔backend commerce truth loop',
    inventsGmv: false,
    status: getStatus(),
  };
}

function start({ intervalMs } = {}) {
  if (_state.running) return getStatus();
  _state.running = true;
  _state.startedAt = new Date().toISOString();
  _hydrate();
  const ms = Math.max(30_000, Number(intervalMs || 120_000));
  _state._timer = setInterval(() => {
    try { score(); } catch (_) { /* observe */ }
  }, ms);
  if (typeof _state._timer.unref === 'function') _state._timer.unref();
  return getStatus();
}

function stop() {
  if (_state._timer) clearInterval(_state._timer);
  _state._timer = null;
  _state.running = false;
  return getStatus();
}

function _resetForTests() {
  _state.beats = [];
  _state.lastScore = null;
  stop();
}

module.exports = {
  PROTOCOL,
  hashCatalog,
  recordBeat,
  score,
  getScore,
  getStatus,
  discovery,
  start,
  stop,
  _resetForTests,
  name: 'commerce-bond-loop-os',
};

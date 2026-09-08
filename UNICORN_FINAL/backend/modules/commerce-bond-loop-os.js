'use strict';
/**
 * CBLOS/1.0 — Commerce Bond Loop OS
 * Site↔backend profit-path alignment without inventing GMV.
 *
 * Two processes share beats via data/cblos/beats.jsonl (capped + rotated).
 * Writers take an exclusive lock, re-read, then append/rotate. If the lock
 * cannot be acquired, persist is skipped (never write unlocked).
 *
 * Score (0–100):
 *   40 catalog id+price hash match (site vs unicorn)
 *   30 last quote USD agree (site vs unicorn — never self-compare checkout)
 *   20 BTC rate within 1%
 *   10 checkout funnel continuity
 *
 * Production nginx pins catalog→site and /api/* BTC→backend, so start()
 * samples both loopback peers. Observe-only. Never invents paid orders.
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
  _senseTimer: null,
  _sensing: false,
};

function _persistEnabled() {
  return process.env.NODE_ENV !== 'test' || !!process.env.CBLOS_DATA_DIR;
}

function _ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) { /* ignore */ }
}

function _sleepMs(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* short lock wait */ }
}

const LOCK_STALE_MS = 400;
const LOCK_ATTEMPTS = 80;

function _withBeatsLock(fn) {
  if (!_persistEnabled()) return fn();
  _ensureDir();
  const lockPath = BEATS_FILE + '.lock';
  let fd = null;
  for (let i = 0; i < LOCK_ATTEMPTS; i++) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return undefined;
      try {
        const age = Date.now() - fs.statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) fs.unlinkSync(lockPath);
      } catch (_) { /* ignore */ }
      _sleepMs(5);
    }
  }
  if (fd == null) return undefined;
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    try { fs.unlinkSync(lockPath); } catch (_) { /* ignore */ }
  }
}

function _readBeatsFile() {
  if (!fs.existsSync(BEATS_FILE)) return [];
  const raw = fs.readFileSync(BEATS_FILE, 'utf8');
  const loaded = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { loaded.push(JSON.parse(line)); } catch (_) { /* skip bad line */ }
  }
  return loaded.slice(-MAX_BEATS);
}

function _rotateFile(beats) {
  const keep = (Array.isArray(beats) ? beats : []).slice(-MAX_BEATS);
  _ensureDir();
  const tmp = BEATS_FILE + '.tmp';
  const body = keep.length ? keep.map((b) => JSON.stringify(b)).join('\n') + '\n' : '';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, BEATS_FILE);
}

function _hydrate() {
  if (!_persistEnabled()) return;
  try {
    _state.beats = _readBeatsFile();
  } catch (_) { /* keep in-memory */ }
}

function hashCatalog(items) {
  const rows = (Array.isArray(items) ? items : [])
    .map((it) => {
      const id = String(it && (it.id || it.serviceId) || '');
      if (!id) return '';
      const p = Number(it.priceUsd != null ? it.priceUsd : it.price);
      const cents = Number.isFinite(p) ? Math.round(p * 100) : 0;
      return id + ':' + cents;
    })
    .filter(Boolean)
    .sort();
  return crypto.createHash('sha256').update(rows.join('|')).digest('hex').slice(0, 24);
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
  if (!_persistEnabled()) {
    _state.beats.push(beat);
    if (_state.beats.length > MAX_BEATS) _state.beats.splice(0, _state.beats.length - MAX_BEATS);
    return beat;
  }
  const persisted = _withBeatsLock(() => {
    _hydrate();
    _state.beats.push(beat);
    if (_state.beats.length > MAX_BEATS) _state.beats.splice(0, _state.beats.length - MAX_BEATS);
    if (_state.beats.length >= MAX_BEATS) {
      _rotateFile(_state.beats);
    } else {
      fs.appendFileSync(BEATS_FILE, JSON.stringify(beat) + '\n');
    }
    return true;
  });
  if (persisted !== true) {
    // Fail closed: never append/rotate without the exclusive lock.
    return beat;
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

  const siteQ = _last('quote', 'site');
  const uniQ = _last('quote', 'unicorn') || _last('quote', 'backend');
  let quotePts = 12;
  if (siteQ && uniQ && siteQ.serviceId && siteQ.serviceId === uniQ.serviceId) {
    const a = Number(siteQ.priceUsd);
    const b = Number(uniQ.priceUsd);
    quotePts = (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 0.05) ? 30 : 16;
  } else if (siteQ || uniQ) quotePts = 16;

  const siteBtc = _last('btc_rate', 'site');
  const uniBtc = _last('btc_rate', 'unicorn') || _last('btc_rate', 'backend');
  let btcPts = 8;
  if (siteBtc && uniBtc && siteBtc.btcRateUsd > 0 && uniBtc.btcRateUsd > 0) {
    const rel = Math.abs(siteBtc.btcRateUsd - uniBtc.btcRateUsd) / Math.max(siteBtc.btcRateUsd, uniBtc.btcRateUsd);
    btcPts = rel <= 0.01 ? 20 : (rel <= 0.05 ? 12 : 6);
  } else if (siteBtc || uniBtc) btcPts = 12;

  const checkout = _last('checkout_create');
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

function _senseBase(envKey, fallback) {
  return String(process.env[envKey] || fallback).replace(/\/$/, '');
}

async function tickSense() {
  if (_state._sensing) return { ok: true, skipped: 'in_flight' };
  if (process.env.NODE_ENV === 'test' && process.env.CBLOS_SENSE !== '1') {
    return { ok: true, skipped: 'test' };
  }
  _state._sensing = true;
  const site = _senseBase('UNICORN_SITE_INTERNAL_URL', 'http://127.0.0.1:3001');
  const uni = _senseBase('UNICORN_BACKEND_INTERNAL_URL', process.env.BACKEND_ORIGIN || 'http://127.0.0.1:3000');
  const sku = encodeURIComponent(String(process.env.CBLOS_SENSE_SKU || 'starter').slice(0, 80));
  const urls = [
    site + '/api/catalog',
    uni + '/api/catalog',
    site + '/api/payment/btc-rate',
    uni + '/api/payment/btc-rate',
    site + '/api/pricing/' + sku,
    uni + '/api/pricing/' + sku,
  ];
  try {
    await Promise.all(urls.map((u) => fetch(u, {
      headers: { Accept: 'application/json', 'User-Agent': 'cblos-sense/1.0' },
      signal: AbortSignal.timeout(4000),
    }).catch(() => null)));
    return { ok: true, sampled: urls.length };
  } finally {
    _state._sensing = false;
  }
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
  _state._senseTimer = setInterval(() => {
    tickSense().catch(() => {});
  }, ms);
  if (typeof _state._senseTimer.unref === 'function') _state._senseTimer.unref();
  const boot = setTimeout(() => { tickSense().catch(() => {}); }, 800);
  if (typeof boot.unref === 'function') boot.unref();
  return getStatus();
}

function stop() {
  if (_state._timer) clearInterval(_state._timer);
  if (_state._senseTimer) clearInterval(_state._senseTimer);
  _state._timer = null;
  _state._senseTimer = null;
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
  MAX_BEATS,
  hashCatalog,
  recordBeat,
  score,
  getScore,
  getStatus,
  discovery,
  start,
  stop,
  tickSense,
  _resetForTests,
  name: 'commerce-bond-loop-os',
};

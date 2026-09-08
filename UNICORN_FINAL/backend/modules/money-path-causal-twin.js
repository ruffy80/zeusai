// =====================================================================
// OWNERSHIP: Acest fișier este proprietatea exclusivă a lui Vladoi Ionut
// Email: vladoi_ionut@yahoo.com
// BTC Address: bc1q4f7e66z87mdfj56kz0dj5hvcnpmh0qh4wuv22e
// =====================================================================
'use strict';
/**
 * MPCT/1.0 — Money-Path Causal Twin
 * =================================
 * World-first (in this stack): a hash-chained causal twin of the real
 * commerce path that ONLY advances on attested evidence from portal /
 * reality-metrics / ROCS — never invents GMV, never fakes paid orders.
 *
 * Phases (monotonic):
 *   catalog → checkout_created → awaiting_payment → paid → fulfill_ack → delivered
 *
 * Under UNICORN_RUNTIME_PROFILE=stable: observe + remediate hooks only
 * (no file mutators). Safe to run forever.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PROTOCOL = 'MPCT/1.0';
const PHASES = Object.freeze([
  'catalog',
  'checkout_created',
  'awaiting_payment',
  'paid',
  'fulfill_ack',
  'delivered',
]);

const DATA_DIR = path.join(__dirname, '..', '..', 'data', 'mpct');
const CHAIN_FILE = path.join(DATA_DIR, 'chain.jsonl');

const _state = {
  running: false,
  startedAt: null,
  tickCount: 0,
  lastTickAt: null,
  tip: null,
  phase: 'catalog',
  evidence: {},
  remediations: [],
  _timer: null,
};

function _ensureDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (_) {}
}

function softRequire(rel) {
  try { return require(rel); } catch (_) { return null; }
}

function _hash(prevHash, body) {
  return crypto.createHash('sha256')
    .update(String(prevHash || 'GENESIS') + '|' + JSON.stringify(body))
    .digest('hex');
}

function _append(entry) {
  _ensureDir();
  try { fs.appendFileSync(CHAIN_FILE, JSON.stringify(entry) + '\n', 'utf8'); } catch (_) {}
  _state.tip = entry;
  return entry;
}

function _phaseIndex(p) {
  const i = PHASES.indexOf(p);
  return i < 0 ? 0 : i;
}

function _advancePhase(next, reason, evidence) {
  const cur = _phaseIndex(_state.phase);
  const nxt = _phaseIndex(next);
  if (nxt < cur) {
    return { ok: false, error: 'phase_regression_forbidden', from: _state.phase, to: next };
  }
  const body = {
    protocol: PROTOCOL,
    at: new Date().toISOString(),
    from: _state.phase,
    to: next,
    reason: reason || 'attested',
    evidence: evidence || {},
  };
  const entry = {
    ...body,
    prev: _state.tip && _state.tip.hash,
    hash: _hash(_state.tip && _state.tip.hash, body),
  };
  _state.phase = next;
  _state.evidence = { ..._state.evidence, ...evidence, phase: next };
  return { ok: true, entry: _append(entry) };
}

function sense() {
  const out = {
    at: new Date().toISOString(),
    catalogCount: 0,
    buyableSkuCount: 0,
    checkoutOpen: 0,
    awaitingPayment: 0,
    stuckAwaitingPayment: 0,
    paidOrders: 0,
    revenueUsd: 0,
    customers: 0,
    fulfillPending: 0,
    delivered: 0,
    sources: [],
  };

  try {
    const cat = softRequire('./productCatalog');
    if (cat && typeof cat.list === 'function') {
      const all = cat.list();
      const buy = typeof cat.list === 'function' ? cat.list({ buyableOnly: true }) : all;
      out.catalogCount = Array.isArray(all) ? all.length : 0;
      out.buyableSkuCount = Array.isArray(buy) ? buy.length : 0;
      out.sources.push('productCatalog');
    }
  } catch (_) {}

  try {
    const unified = softRequire('../../src/commerce/unified-catalog');
    const all = unified && typeof unified.all === 'function' ? unified.all() : [];
    if (Array.isArray(all) && all.length > out.catalogCount) {
      out.catalogCount = all.length;
      out.sources.push('unified-catalog');
    }
  } catch (_) {}

  try {
    const rm = softRequire('./reality-metrics');
    const s = rm && typeof rm.snapshot === 'function' ? rm.snapshot() : null;
    if (s) {
      out.paidOrders = Number((s.orders && s.orders.paid) || 0);
      out.revenueUsd = Number((s.revenue && s.revenue.paidUsd) || 0);
      out.customers = Number(s.customers || 0);
      out.sources.push('reality-metrics');
    }
  } catch (_) {}

  try {
    const portal = softRequire('./commerce-portal');
    const st = portal && typeof portal.getStatus === 'function' ? portal.getStatus() : null;
    if (st && st.counts) {
      out.checkoutOpen = Number(st.counts.open || st.counts.checkout || 0);
      out.awaitingPayment = Number(st.counts.awaiting_payment || st.counts.awaitingPayment || 0);
      out.sources.push('commerce-portal');
    }
  } catch (_) {}

  try {
    const rocs = softRequire('./reality-ops-continuum');
    const v = rocs && typeof rocs.lastVerdict === 'function' ? rocs.lastVerdict() : null;
    if (v && v.findings) {
      const stuck = (v.findings || []).filter((f) =>
        /awaiting_payment|stuck_checkout/i.test(String(f.code || f.kind || f.id || ''))
      );
      out.stuckAwaitingPayment = stuck.length;
      out.sources.push('rocs');
    }
  } catch (_) {}

  return out;
}

function derivePhase(snap) {
  if (snap.paidOrders > 0 && snap.delivered > 0) return 'delivered';
  if (snap.paidOrders > 0 && snap.fulfillPending > 0) return 'fulfill_ack';
  if (snap.paidOrders > 0) return 'paid';
  if (snap.stuckAwaitingPayment > 0 || snap.awaitingPayment > 0) return 'awaiting_payment';
  if (snap.checkoutOpen > 0) return 'checkout_created';
  if (snap.catalogCount > 0 || snap.buyableSkuCount > 0) return 'catalog';
  return 'catalog';
}

function remediate(snap, { dryRun = false } = {}) {
  const actions = [];
  if (snap.stuckAwaitingPayment > 0 || snap.awaitingPayment > 0) {
    const action = {
      id: 'checkout_recovery_tick',
      reason: 'stuck_or_open_awaiting_payment',
      dryRun: !!dryRun,
    };
    if (!dryRun) {
      try {
        const rocs = softRequire('./reality-ops-continuum');
        if (rocs && typeof rocs.tick === 'function') {
          // Fire-and-forget soft recovery; never invent payment.
          Promise.resolve(rocs.tick({ dryRun: false, skipAlert: true, source: 'mpct' })).catch(() => {});
          action.fired = true;
        } else {
          action.fired = false;
          action.skip = 'rocs_unavailable';
        }
      } catch (e) {
        action.fired = false;
        action.error = e.message;
      }
    }
    actions.push(action);
  }
  if (snap.buyableSkuCount === 0 && snap.catalogCount > 0) {
    actions.push({
      id: 'sku_buyability_fence',
      reason: 'catalog_present_but_zero_buyable',
      note: 'Non-fulfillable SKUs must stay blocked — MPCT will not invent delivery',
      fired: false,
    });
  }
  _state.remediations = actions.slice(0, 20);
  return actions;
}

function tick(opts = {}) {
  const snap = sense();
  const target = derivePhase(snap);
  const advanced = _advancePhase(target, 'sense_attested', {
    paidOrders: snap.paidOrders,
    revenueUsd: snap.revenueUsd,
    awaitingPayment: snap.awaitingPayment,
    stuckAwaitingPayment: snap.stuckAwaitingPayment,
    buyableSkuCount: snap.buyableSkuCount,
    catalogCount: snap.catalogCount,
    sources: snap.sources,
  });
  const actions = remediate(snap, opts);
  _state.tickCount += 1;
  _state.lastTickAt = new Date().toISOString();
  return {
    ok: true,
    protocol: PROTOCOL,
    phase: _state.phase,
    advanced: !!(advanced && advanced.ok),
    tip: _state.tip,
    sense: snap,
    remediations: actions,
    inventsGmv: false,
  };
}

function getStatus() {
  return {
    ok: true,
    protocol: PROTOCOL,
    name: 'Money-Path Causal Twin',
    running: _state.running,
    startedAt: _state.startedAt,
    tickCount: _state.tickCount,
    lastTickAt: _state.lastTickAt,
    phase: _state.phase,
    phases: PHASES.slice(),
    tipHash: _state.tip && _state.tip.hash,
    evidence: _state.evidence,
    remediations: _state.remediations,
    inventsGmv: false,
    managesBackups: false,
    health: _state.running ? 'ok' : 'idle',
    timestamp: new Date().toISOString(),
  };
}

function discovery() {
  return {
    ok: true,
    protocol: PROTOCOL,
    role: 'causal twin of real money path — attested advances only',
    phases: PHASES.slice(),
    status: getStatus(),
  };
}

function start({ intervalMs } = {}) {
  if (_state.running) return getStatus();
  _state.running = true;
  _state.startedAt = new Date().toISOString();
  tick({ dryRun: false });
  const ms = Math.max(30_000, Number(intervalMs || process.env.MPCT_INTERVAL_MS || 120_000));
  _state._timer = setInterval(() => {
    try { tick({ dryRun: false }); } catch (_) {}
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

module.exports = {
  PROTOCOL,
  PHASES,
  sense,
  derivePhase,
  tick,
  remediate,
  getStatus,
  discovery,
  start,
  stop,
  name: 'money-path-causal-twin',
};

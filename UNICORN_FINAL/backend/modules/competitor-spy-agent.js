// =====================================================================
// OWNERSHIP: Acest fișier este proprietatea exclusivă a lui Vladoi Ionut
// Email: vladoi_ionut@yahoo.com
// BTC Address: bc1q4f7e66z87mdfj56kz0dj5hvcnpmh0qh4wuv22e
// =====================================================================
'use strict';
/**
 * Competitor Spy Agent — feed-gated intelligence.
 * Without SERPAPI_KEY (or COMPETITOR_SPY_FORCE=1 with explicit operator input),
 * stays unarmed and never invents competitor ratings/leads.
 */

const _state = {
  name: 'competitor-spy-agent',
  label: 'Competitor Spy Agent',
  startedAt: null,
  processCount: 0,
  lastRun: null,
  health: 'idle',
  competitors: [],
  alerts: [],
  opportunities: [],
  dataMode: 'unarmed',
  truthSource: null,
  _timer: null,
};

function _serpArmed() {
  return !!(process.env.SERPAPI_KEY || process.env.COMPETITOR_FEED_URL);
}

function _buildFromOperator(input = {}) {
  const name = String(input.competitor || input.name || '').trim();
  if (!name) return null;
  return {
    name,
    pricing: input.pricing || null,
    customerRating: input.customerRating != null ? Number(input.customerRating) : null,
    weaknesses: Array.isArray(input.weaknesses) ? input.weaknesses : [],
    recentChange: input.recentChange || null,
    monitoredAt: new Date().toISOString(),
    source: 'operator_input',
  };
}

function refreshArming() {
  if (_serpArmed()) {
    _state.dataMode = 'live_feed_ready';
    _state.truthSource = process.env.SERPAPI_KEY ? 'SERPAPI_KEY' : 'COMPETITOR_FEED_URL';
    _state.health = _state.competitors.length ? 'good' : 'idle';
    return true;
  }
  _state.dataMode = 'unarmed';
  _state.truthSource = null;
  _state.health = 'idle';
  // Do not keep theater competitors around.
  if (!_state.competitors.some((c) => c && c.source === 'operator_input')) {
    _state.competitors = [];
    _state.opportunities = [];
  }
  return false;
}

function init() {
  if (_state.startedAt) return getStatus();
  _state.startedAt = new Date().toISOString();
  refreshArming();
  if (_state._timer) clearInterval(_state._timer);
  _state._timer = setInterval(() => {
    refreshArming();
    _state.lastRun = new Date().toISOString();
    // Live scrape hooks stay future-work; arming alone is honest progress.
  }, 20 * 60 * 1000);
  if (typeof _state._timer.unref === 'function') _state._timer.unref();
  console.log(
    _state.dataMode === 'unarmed'
      ? '🕵️  Competitor Spy Agent idle (unarmed — set SERPAPI_KEY for live intel).'
      : '🕵️  Competitor Spy Agent armed (feed key present).'
  );
  return getStatus();
}

async function processInput(input = {}) {
  _state.processCount++;
  _state.lastRun = new Date().toISOString();
  refreshArming();

  const forced = String(process.env.COMPETITOR_SPY_FORCE || '') === '1';
  const profile = _buildFromOperator(input);
  if (profile && (forced || _state.dataMode !== 'unarmed' || input.competitor)) {
    _state.competitors = [profile, ..._state.competitors.filter((c) => c.name !== profile.name)].slice(0, 20);
    if (input.opportunityType) {
      const opp = {
        id: `opp_${Date.now()}`,
        competitor: profile.name,
        opportunityType: String(input.opportunityType),
        estimatedLeads: input.estimatedLeads != null ? Number(input.estimatedLeads) : null,
        urgency: input.urgency || 'MEDIUM',
        detectedAt: new Date().toISOString(),
        action: input.action || null,
        source: 'operator_input',
      };
      _state.opportunities.unshift(opp);
      if (_state.opportunities.length > 50) _state.opportunities.pop();
    }
    _state.dataMode = _serpArmed() ? 'live_feed_ready' : 'operator';
    _state.health = 'good';
  }

  return {
    status: 'ok',
    module: _state.name,
    label: _state.label,
    dataMode: _state.dataMode,
    simulated: false,
    armed: _state.dataMode !== 'unarmed',
    competitorProfile: _state.competitors[0] || null,
    latestOpportunity: _state.opportunities[0] || null,
    totalCompetitorsMonitored: _state.competitors.length,
    totalOpportunities: _state.opportunities.length,
    timestamp: _state.lastRun,
    note: _state.dataMode === 'unarmed'
      ? 'No SERPAPI_KEY / COMPETITOR_FEED_URL — refusing to invent competitors'
      : undefined,
  };
}

function getStatus() {
  refreshArming();
  return {
    name: _state.name,
    label: _state.label,
    startedAt: _state.startedAt,
    processCount: _state.processCount,
    lastRun: _state.lastRun,
    health: _state.health,
    competitors: _state.competitors,
    alerts: _state.alerts.slice(0, 5),
    opportunities: _state.opportunities.slice(0, 5),
    competitorsMonitored: _state.competitors.length,
    activeOpportunities: _state.opportunities.filter((o) => o.urgency === 'HIGH').length,
    latestAlert: _state.alerts[0] || null,
    dataMode: _state.dataMode,
    simulated: false,
    armed: _state.dataMode !== 'unarmed',
    useful: _state.competitors.length > 0 && _state.dataMode !== 'unarmed',
    truthSource: _state.truthSource || 'unarmed',
  };
}

init();

module.exports = { process: processInput, getStatus, init, refreshArming, name: 'competitor-spy-agent' };

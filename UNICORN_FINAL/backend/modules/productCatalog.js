'use strict';

/**
 * Product Catalog — curated revenue SKUs (subscriptions, licenses, services).
 * Ownership BTC settlement: bc1q4f7e66z87mdfj56kz0dj5hvcnpmh0qh4wuv22e
 */

const BTC_ADDRESS =
  process.env.BTC_WALLET_ADDRESS ||
  process.env.OWNER_BTC_ADDRESS ||
  'bc1q4f7e66z87mdfj56kz0dj5hvcnpmh0qh4wuv22e';

/** @type {Map<string, object>} */
const SKUS = new Map();

const SEED = [
  // Deliverable / desk-or-entitlement paths (buyable).
  { id: 'esim-eu-5gb', name: 'Plan eSIM Europa 5GB', priceUsd: 20, billing: 'one-time', category: 'connectivity', buyable: true, fulfillable: true, fulfillment: 'desk' },
  { id: 'esim-global-10gb', name: 'Plan eSIM Global 10GB', priceUsd: 50, billing: 'one-time', category: 'connectivity', buyable: true, fulfillable: true, fulfillment: 'desk' },
  { id: 'api-access-pro', name: 'API Access Pro', priceUsd: 99, billing: 'monthly', category: 'api', buyable: true, fulfillable: true, fulfillment: 'entitlement' },
  { id: 'ai-consulting-hour', name: 'AI Consulting Hour', priceUsd: 150, billing: 'hourly', category: 'services', buyable: true, fulfillable: true, fulfillment: 'desk' },
  { id: 'predictive-analytics', name: 'Predictive Analytics', priceUsd: 299, billing: 'monthly', category: 'analytics', buyable: true, fulfillable: true, fulfillment: 'entitlement' },
  { id: 'custom-module-dev', name: 'Custom Module Development', priceUsd: 999, billing: 'one-time', category: 'services', buyable: true, fulfillable: true, fulfillment: 'desk' },
  { id: 'enterprise-license', name: 'Enterprise License', priceUsd: 1999, billing: 'monthly', category: 'enterprise', buyable: true, fulfillable: true, fulfillment: 'entitlement' },
  // Theater / no supplier or entitlement issuer — kept for get() identity but NOT buyable.
  { id: 'carbon-credits-trading', name: 'Carbon Credits Trading', priceUsd: 500, billing: 'monthly', category: 'carbon', buyable: false, fulfillable: false, fulfillment: null, blockReason: 'no_supplier_or_entitlement' },
  { id: 'quantum-identity-shield', name: 'Quantum Identity Shield', priceUsd: 79, billing: 'monthly', category: 'security', buyable: false, fulfillable: false, fulfillment: null, blockReason: 'no_supplier_or_entitlement' },
  { id: 'autonomous-negotiation', name: 'Autonomous Negotiation', priceUsd: 199, billing: 'monthly', category: 'negotiation', buyable: false, fulfillable: false, fulfillment: null, blockReason: 'no_supplier_or_entitlement' },
];

function seed() {
  for (const s of SEED) {
    const buyable = s.buyable !== false && s.fulfillable !== false;
    SKUS.set(s.id, {
      ...s,
      active: true,
      buyable,
      fulfillable: buyable,
      currency: 'USD',
      btcAddress: BTC_ADDRESS,
      buyPath: buyable ? '/api/orders/reserve' : null,
      updatedAt: new Date().toISOString(),
    });
  }
}
seed();

function list({ includeInactive = false, buyableOnly = false } = {}) {
  return Array.from(SKUS.values()).filter((s) => {
    if (!includeInactive && s.active === false) return false;
    if (buyableOnly && s.buyable === false) return false;
    return true;
  });
}

function get(id) {
  return SKUS.get(String(id || '')) || null;
}

function upsert(sku) {
  if (!sku || !sku.id) throw new Error('sku.id required');
  const prev = SKUS.get(sku.id) || {};
  const next = {
    ...prev,
    ...sku,
    id: String(sku.id),
    priceUsd: Number(sku.priceUsd != null ? sku.priceUsd : prev.priceUsd || 0),
    active: sku.active !== false,
    currency: 'USD',
    btcAddress: BTC_ADDRESS,
    updatedAt: new Date().toISOString(),
  };
  SKUS.set(next.id, next);
  return next;
}

function ensureRevenueSkus() {
  seed();
  return { ok: true, count: SKUS.size, ids: list().map((s) => s.id) };
}

function getStatus() {
  const items = list();
  const buyable = list({ buyableOnly: true });
  const mrr = buyable
    .filter((s) => s.billing === 'monthly')
    .reduce((a, s) => a + Number(s.priceUsd || 0), 0);
  return {
    protocol: 'PRODUCT_CATALOG/1.1',
    active: true,
    skuCount: items.length,
    buyableCount: buyable.length,
    blockedCount: items.length - buyable.length,
    monthlySkuFloorUsd: mrr,
    btcAddress: BTC_ADDRESS,
    skus: items.map((s) => ({
      id: s.id,
      priceUsd: s.priceUsd,
      billing: s.billing,
      buyable: s.buyable !== false,
      fulfillable: s.fulfillable !== false,
      blockReason: s.blockReason || null,
    })),
  };
}

function start() {
  ensureRevenueSkus();
  return getStatus();
}

module.exports = {
  BTC_ADDRESS,
  list,
  get,
  upsert,
  ensureRevenueSkus,
  getStatus,
  start,
  init: start,
};

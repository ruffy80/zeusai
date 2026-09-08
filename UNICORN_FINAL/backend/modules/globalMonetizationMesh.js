// =====================================================================
// OWNERSHIP: Acest fișier este proprietatea exclusivă a lui Vladoi Ionut
// Email: vladoi_ionut@yahoo.com
// BTC Address: bc1q4f7e66z87mdfj56kz0dj5hvcnpmh0qh4wuv22e
// Data: 2026-04-30T15:05:08.925Z
// Orice copiere, modificare sau distribuție neautorizată este interzisă.
// =====================================================================

'use strict';
/*
 * globalMonetizationMesh
 * ----------------------
 * Multi-marketplace publisher: lists Unicorn modules / services on multiple
 * marketplaces (AWS Marketplace, GCP Marketplace, Azure Marketplace, Salesforce
 * AppExchange, Shopify App Store, AppSumo, Product Hunt, G2, Capterra,
 * Atlassian Marketplace, GitHub Marketplace, ZeusAI Internal). Returns
 * aggregated reach + records sales which route to sovereignRevenueRouter.
 *
 * Plasă globală de monetizare — aditiv. Niciun rollback / fără apeluri
 * externe; deterministic.
 */

const crypto = require('crypto');
const _router = require('./sovereignRevenueRouter');

const _MARKETPLACES = [
  // Catalog of listing targets only — no invented audience sizes.
  { id: 'aws-marketplace',         category: 'cloud',     takeRatePct: 5.0 },
  { id: 'gcp-marketplace',         category: 'cloud',     takeRatePct: 5.0 },
  { id: 'azure-marketplace',       category: 'cloud',     takeRatePct: 5.0 },
  { id: 'salesforce-appexchange',  category: 'crm',       takeRatePct: 15.0 },
  { id: 'shopify-app-store',       category: 'commerce',  takeRatePct: 20.0 },
  { id: 'appsumo',                 category: 'saas',      takeRatePct: 30.0 },
  { id: 'product-hunt',            category: 'saas',      takeRatePct: 0.0 },
  { id: 'g2',                      category: 'review',    takeRatePct: 0.0 },
  { id: 'capterra',                category: 'review',    takeRatePct: 0.0 },
  { id: 'atlassian-marketplace',   category: 'devops',    takeRatePct: 25.0 },
  { id: 'github-marketplace',      category: 'devops',    takeRatePct: 0.0 },
  { id: 'zeusai-internal',         category: 'native',    takeRatePct: 0.0 },
];

const _listings = new Map(); // listingId → { product, marketplaces, listedAt }
const _sales = [];
const _maxInMemory = 5000;

function listMarketplaces() {
  return _MARKETPLACES.map((m) => ({
    id: m.id,
    category: m.category,
    takeRatePct: m.takeRatePct,
    live: false,
    listed: _listings.size > 0 && [..._listings.values()].some((l) => (l.marketplaces || []).includes(m.id)),
    reachUsers: null,
    reachNote: 'no_invented_reach — wire marketplace APIs for live audience',
  }));
}

function reach() {
  return {
    ok: true,
    simulated: false,
    live: false,
    generatedAt: new Date().toISOString(),
    totalReachUsers: null,
    marketplaceCount: _MARKETPLACES.length,
    listedCount: _listings.size,
    avgTakeRatePct: Number((_MARKETPLACES.reduce((s, m) => s + m.takeRatePct, 0) / _MARKETPLACES.length).toFixed(2)),
    note: 'Listing readiness only — audience reach is null until external marketplace APIs are armed',
  };
}

function summary() {
  const totalSalesUsd = _sales.reduce((s, x) => s + x.amountUsd, 0);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    listings: _listings.size,
    marketplaces: _MARKETPLACES.length,
    sales: _sales.length,
    totalSalesUsd: Math.round(totalSalesUsd * 100) / 100,
    reach: reach(),
  };
}

function listings() {
  return Array.from(_listings.values());
}

function publishProduct(input = {}) {
  const productId = String(input.productId || input.id || '').slice(0, 96);
  const title = String(input.title || productId || 'unicorn-module').slice(0, 160);
  if (!productId) return { ok: false, error: 'productId required' };
  const targetIds = Array.isArray(input.marketplaces)
    ? input.marketplaces.map((m) => String(m).toLowerCase())
    : _MARKETPLACES.map((m) => m.id);
  const targets = _MARKETPLACES.filter((m) => targetIds.includes(m.id));
  const listingId = 'lst_' + crypto.randomBytes(6).toString('hex');
  const evt = {
    id: listingId,
    productId,
    title,
    marketplaces: targets.map((m) => m.id),
    listedAt: new Date().toISOString(),
    listedLive: false,
    simulated: true,
    note: 'In-memory listing only — no external marketplace API publish',
  };
  _listings.set(listingId, evt);
  return { ok: true, listing: evt, live: false };
}

function quote(input = {}) {
  const amountUsd = Number(input.amountUsd || input.amount || 0);
  const marketplaceId = String(input.marketplace || input.marketplaceId || 'zeusai-internal').toLowerCase();
  const m = _MARKETPLACES.find((x) => x.id === marketplaceId);
  if (!m) return { ok: false, error: 'unknown marketplace' };
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) return { ok: false, error: 'amountUsd must be positive' };
  const takeUsd = Math.round(amountUsd * (m.takeRatePct / 100) * 100) / 100;
  const netUsd = Math.round((amountUsd - takeUsd) * 100) / 100;
  return { ok: true, marketplace: m.id, amountUsd, takeUsd, netUsd, takeRatePct: m.takeRatePct };
}

function recordSale(input = {}) {
  const q = quote(input);
  if (!q.ok) return q;
  const productId = String(input.productId || input.product || 'unspecified').slice(0, 96);
  const evt = {
    id: 'sale_' + crypto.randomBytes(6).toString('hex'),
    ts: new Date().toISOString(),
    marketplace: q.marketplace,
    productId,
    amountUsd: q.amountUsd,
    takeUsd: q.takeUsd,
    netUsd: q.netUsd,
    simulated: true,
  };
  _sales.push(evt);
  if (_sales.length > _maxInMemory) _sales.shift();
  // Route net amount through revenue router so it lands on owner BTC
  const routed = _router.route({
    amountUsd: q.netUsd,
    channel: 'monetize-mesh:' + q.marketplace,
    productId,
    tenantId: String(input.tenantId || 'self'),
  });
  return { ok: true, sale: evt, routed: routed.event, live: false, simulated: true };
}

function getStatus() {
  return {
    ok: true,
    name: 'globalMonetizationMesh',
    live: false,
    simulated: false,
    inventsReach: false,
    marketplaces: _MARKETPLACES.length,
    listings: _listings.size,
    sales: _sales.length,
    note: 'listing_readiness_only — sales events marked simulated until live marketplace webhooks',
  };
}

module.exports = { listMarketplaces, reach, summary, listings, publishProduct, quote, recordSale, getStatus };

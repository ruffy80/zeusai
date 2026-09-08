'use strict';
/**
 * commerce-bond-loop.test.js — CBLOS/1.0
 * Site↔backend catalog/quote/BTC/funnel alignment. Never invents GMV.
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_SELF_MUTATION = '1';
process.env.UNICORN_RUNTIME_PROFILE = 'stable';
delete process.env.CBLOS_DATA_DIR;

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MOD = path.join(ROOT, 'backend', 'modules', 'commerce-bond-loop-os.js');
const SITE_INDEX = path.join(ROOT, 'src', 'index.js');
const BACKEND_INDEX = path.join(ROOT, 'backend', 'index.js');
const ECO = path.join(ROOT, 'ecosystem.config.js');
const NGINX = path.join(ROOT, 'scripts', 'nginx-unicorn.conf');
const COMMERCE = path.join(ROOT, 'src', 'site', 'sovereign-commerce.js');
const SHELL = path.join(ROOT, 'src', 'site', 'v2', 'shell.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('✓', name);
}

console.log('Commerce Bond Loop OS (CBLOS/1.0)');

check('module file exists', () => {
  assert.ok(fs.existsSync(MOD), 'commerce-bond-loop-os.js missing');
});

const cblos = require(MOD);
cblos._resetForTests();

check('exports protocol + score/recordBeat and never invents GMV', () => {
  assert.strictEqual(cblos.PROTOCOL, 'CBLOS/1.0');
  assert.strictEqual(typeof cblos.recordBeat, 'function');
  assert.strictEqual(typeof cblos.hashCatalog, 'function');
  assert.strictEqual(typeof cblos.getScore, 'function');
  assert.strictEqual(typeof cblos.getStatus, 'function');
  assert.strictEqual(typeof cblos.discovery, 'function');
  const st = cblos.getStatus();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(st.inventsGmv, false);
  assert.ok(st.health === 'observe' || st.health === 'ok');
});

check('hashCatalog is order-invariant', () => {
  const a = cblos.hashCatalog([{ id: 'b' }, { id: 'a' }]);
  const b = cblos.hashCatalog([{ serviceId: 'a' }, { id: 'b' }]);
  assert.strictEqual(a, b);
  assert.strictEqual(a.length, 24);
});

check('matching catalog hashes score 40 catalog points', () => {
  cblos._resetForTests();
  const h = cblos.hashCatalog([{ id: 'starter' }, { id: 'pro' }]);
  cblos.recordBeat('catalog_snapshot', { peer: 'site', catalogHash: h });
  cblos.recordBeat('catalog_snapshot', { peer: 'unicorn', catalogHash: h });
  const sc = cblos.getScore();
  assert.strictEqual(sc.parts.catalog, 40);
  assert.strictEqual(sc.inventsGmv, false);
});

check('split catalog hashes do not claim full catalog bond', () => {
  cblos._resetForTests();
  cblos.recordBeat('catalog_snapshot', { peer: 'site', catalogHash: 'aaa' });
  cblos.recordBeat('catalog_snapshot', { peer: 'unicorn', catalogHash: 'bbb' });
  const sc = cblos.getScore();
  assert.ok(sc.parts.catalog < 40);
  assert.strictEqual(sc.inventsGmv, false);
});

check('checkout + matching quote + BTC ±1% + catalog → 100 bonded', () => {
  cblos._resetForTests();
  const h = cblos.hashCatalog([{ id: 'starter' }]);
  cblos.recordBeat('catalog_snapshot', { peer: 'site', catalogHash: h });
  cblos.recordBeat('catalog_snapshot', { peer: 'unicorn', catalogHash: h });
  cblos.recordBeat('checkout_create', { peer: 'site', serviceId: 'starter', priceUsd: 49, orderId: 'ord_test' });
  cblos.recordBeat('btc_rate', { peer: 'site', btcRateUsd: 100000 });
  cblos.recordBeat('btc_rate', { peer: 'unicorn', btcRateUsd: 100500 });
  const sc = cblos.getScore();
  assert.strictEqual(sc.parts.catalog, 40);
  assert.strictEqual(sc.parts.quote, 30);
  assert.strictEqual(sc.parts.btc, 20);
  assert.strictEqual(sc.parts.funnel, 10);
  assert.strictEqual(sc.score, 100);
  assert.strictEqual(sc.bonded, true);
  assert.strictEqual(sc.inventsGmv, false);
});

check('idle score never invents paid GMV', () => {
  cblos._resetForTests();
  const sc = cblos.getScore();
  assert.ok(sc.score < 75);
  assert.strictEqual(sc.bonded, false);
  assert.strictEqual(sc.inventsGmv, false);
});

check('IAK treats idle CBLOS as observe-healthy', () => {
  cblos._resetForTests();
  const IAK = require('../backend/modules/integrated-autonomy-kernel');
  let iak = IAK;
  if (typeof IAK === 'function') {
    try { iak = new IAK({ mode: 'monitor' }); } catch (_) { iak = IAK; }
  }
  if (iak && iak.default) iak = iak.default;
  const st = cblos.getStatus();
  assert.equal(iak._isHealthy(st), true);
});

check('IAK stable allowlist includes commerce-bond-loop-os', () => {
  const disc = require('../backend/modules/iak/module-discovery');
  assert.ok(disc.STABLE_START_ALLOW.has('commerce-bond-loop-os'));
});

check('backend exposes liveness + SWR public health + CBLOS routes', () => {
  const src = fs.readFileSync(BACKEND_INDEX, 'utf8');
  assert.ok(src.includes("/api/health/live"));
  assert.ok(src.includes("UNICORN_LIVENESS/1.0") || src.includes('livenessHealth'));
  assert.ok(src.includes('_refreshPublicHealthCache') || src.includes('Stale-while-revalidate'));
  assert.ok(src.includes('/api/cblos'));
  assert.ok(src.includes('commerce-bond.json'));
  assert.ok(src.includes('UNICORN_CATALOG_SITE_PROXY') || src.includes("NODE_ENV === 'test'"));
});

check('site monitor probes /api/health/live and times out proxies', () => {
  const src = fs.readFileSync(SITE_INDEX, 'utf8');
  assert.ok(src.includes('http://127.0.0.1:3000/api/health/live'));
  assert.ok(src.includes('SITE_PROXY_TIMEOUT_MS'));
  assert.ok(/ok:\s*backendOk/.test(src) || src.includes('ok: backendOk') || src.includes('ok: !!__mon.ok'));
  assert.ok(src.includes('commerce-bond-loop-os'));
  assert.ok(src.includes('/.well-known/commerce-bond.json'));
});

check('createOrder accepts plan alias', () => {
  const src = fs.readFileSync(COMMERCE, 'utf8');
  assert.ok(/serviceId \|\| input\.plan \|\| input\.service_id/.test(src)
    || /input\.serviceId \|\| input\.plan/.test(src));
  assert.ok(src.includes("recordBeat('checkout_create'"));
});

check('nginx pins catalog to site and liveness + commerce-bond to backend', () => {
  const conf = fs.readFileSync(NGINX, 'utf8');
  assert.ok(/location\s+=\s+\/api\/catalog\s*\{/.test(conf));
  const catIdx = conf.indexOf('location = /api/catalog');
  const catWin = conf.slice(catIdx, catIdx + 500);
  assert.ok(/proxy_pass\s+http:\/\/unicorn_site\b/.test(catWin), 'catalog must hit unicorn_site');
  const liveIdx = conf.indexOf('location = /api/health/live');
  assert.ok(liveIdx > 0);
  const liveWin = conf.slice(liveIdx, liveIdx + 400);
  assert.ok(/proxy_pass\s+http:\/\/unicorn_backend\b/.test(liveWin));
  assert.ok(/location\s+=\s+\/\.well-known\/commerce-bond\.json/.test(conf));
});

check('ecosystem default monitor URL is /api/health/live', () => {
  const src = fs.readFileSync(ECO, 'utf8');
  assert.ok(src.includes('/api/health/live'));
});

check('status page renders Commerce Bond Loop panel', () => {
  const src = fs.readFileSync(SHELL, 'utf8');
  assert.ok(src.includes('cblosPanel'));
  assert.ok(src.includes('loadCommerceBond'));
  assert.ok(src.includes('/api/cblos'));
});

console.log(`\n✅ commerce-bond-loop: ${passed} tests passed\n`);
process.exit(0);

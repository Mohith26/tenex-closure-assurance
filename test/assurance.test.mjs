import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../core/assurance.js';
import { generateTenant, SEED } from '../core/generate.js';

const tenant = JSON.parse(readFileSync(new URL('../data/tenant.json', import.meta.url)));
const truth = JSON.parse(readFileSync(new URL('../data/truth.json', import.meta.url)));

test('committed data matches the seeded generator', () => {
  const g = generateTenant(SEED);
  assert.equal(g.tenant.alerts.rule.length, tenant.alerts.rule.length);
  assert.deepEqual(g.tenant.alerts.conf.slice(0, 50), tenant.alerts.conf.slice(0, 50));
  assert.deepEqual(g.truth.y.slice(-50), truth.y.slice(-50));
});

test('estimator never reads hidden labels: closed, unreviewed alerts are unlabeled', () => {
  const A = tenant.alerts;
  for (let i = 0; i < A.rule.length; i++) {
    if (!A.esc[i] && !A.rev[i]) assert.equal(A.y[i], -1);
    if (A.esc[i] || A.rev[i]) assert.ok(A.y[i] === 0 || A.y[i] === 1);
  }
});

test('normInv and Clopper-Pearson against known values', () => {
  assert.ok(Math.abs(C.normInv(0.95) - 1.6448536) < 1e-6);
  assert.ok(Math.abs(C.normInv(0.025) + 1.959964) < 1e-6);
  // zero successes in n: one-sided upper bound = 1 - (1-conf)^(1/n)
  const n = 1259, conf = 0.95;
  assert.ok(Math.abs(C.cpUpper(0, n, conf) - (1 - Math.pow(1 - conf, 1 / n))) < 1e-8);
});

test('Poisson-binomial upper tail matches brute force', () => {
  const ps = [0.1, 0.3, 0.05, 0.6, 0.2];
  let brute = 0;
  for (let m = 0; m < 32; m++) { let p = 1, k = 0; ps.forEach((q, j) => { if (m >> j & 1) { p *= q; k++; } else p *= 1 - q; }); if (k >= 2) brute += p; }
  assert.ok(Math.abs(C.poissonBinomialUpper(ps, 2) - brute) < 1e-12);
  assert.equal(C.poissonBinomialUpper(ps, 0), 1);
});

test('calibration shift recovers a planted shift on synthetic labels', () => {
  const rnd = C.mulberry32(5), A = { conf: [], esc: [], y: [] }, idx = [];
  for (let i = 0; i < 6000; i++) {
    const c = 0.5 + 0.49 * rnd();
    A.conf.push(c); A.esc.push(1); A.y.push(rnd() < C.sigmoid(C.logit(1 - c) + 1.0) ? 1 : 0); idx.push(i);
  }
  const f = C.fitShift(A, idx);
  assert.ok(Math.abs(f.b - 1.0) < 3 * f.se + 0.02, `b=${f.b} se=${f.se}`);
});

test('difference estimator is unbiased for any working model (design-based)', () => {
  const rnd = C.mulberry32(9), N = 4000;
  const y = Array.from({ length: N }, () => (rnd() < 0.01 ? 1 : 0));
  const qBad = Array.from({ length: N }, () => 0.002); // deliberately wrong model
  const pi = Array.from({ length: N }, (_, i) => (i % 3 === 0 ? 0.2 : 0.05));
  const truthM = y.reduce((s, v) => s + v, 0);
  let sum = 0; const R = 3000;
  for (let r = 0; r < R; r++) {
    let est = 0; for (let i = 0; i < N; i++) { est += qBad[i]; if (rnd() < pi[i]) est += (y[i] - qBad[i]) / pi[i]; }
    sum += est;
  }
  assert.ok(Math.abs(sum / R - truthM) < 0.6, `mean ${sum / R} vs ${truthM}`);
});

test('Neyman design spends the budget, respects caps and floor, and beats uniform variance', () => {
  const rnd = C.mulberry32(3);
  const q = Array.from({ length: 5000 }, () => Math.pow(rnd(), 6) * 0.2);
  const B = 300;
  const pi = C.neymanDesign(q, B, 0.002);
  const tot = pi.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(tot - B) < 1e-6 * B + 1e-6, `sum ${tot}`);
  assert.ok(pi.every((p) => p >= 0.002 - 1e-12 && p <= 1));
  const u = C.uniformPlan(q, B);
  assert.ok(C.designVariance(q, pi) < C.designVariance(q, u.pi));
});

test('risk plan surfaces more threats than random review at the same budget', () => {
  const an = C.analyze(tenant, { draws: 300, skipThresholds: true });
  const closed = an.rules.flatMap((r) => r._closed), q = closed.map(an.qOf);
  const u = C.uniformPlan(q, 1260), h = C.hybridPlan(q, 1260, 240);
  assert.ok(Math.abs(h.expectedReviews - 1260) < 1);
  assert.ok(h.expectedFound > 5 * u.expectedFound);
  // realised on the hidden truth, not just expected
  const y = closed.map((i) => truth.y[i]);
  let fu = 0, fh = 0; const rnd = C.mulberry32(1);
  for (let r = 0; r < 200; r++) for (let j = 0; j < q.length; j++) { const x = rnd(); if (x < u.pi[j]) fu += y[j]; if (x < h.pi[j]) fh += y[j]; }
  assert.ok(fh > 4 * fu, `hybrid ${fh / 200} vs uniform ${fu / 200}`);
});

test('analysis is internally consistent: totals equal the sum of rules, intervals ordered', () => {
  const an = C.analyze(tenant, { draws: 600 });
  const sumPoint = an.rules.reduce((s, r) => s + r.missed.point, 0);
  assert.ok(Math.abs(sumPoint - an.totals.missed.point) < 1e-9);
  assert.equal(an.totals.closed + an.totals.escalated, an.totals.alerts);
  for (const r of an.rules) {
    assert.ok(r.missed.lo <= r.missed.point + 1e-9 && r.missed.point <= r.missed.hi + 1e-9 || r.closed === 0);
    if (r.tau > 1) assert.equal(r.threshold.action, 'policy');
  }
  // the hidden truth for this tenant falls inside the 90% interval
  let m = 0; for (const r of an.rules) for (const i of r._closed) m += truth.y[i];
  assert.ok(m >= an.totals.missed.lo && m <= an.totals.missed.hi, `${m} not in [${an.totals.missed.lo}, ${an.totals.missed.hi}]`);
});

test('threshold scan: recommendation meets the target and is monotone in strictness', () => {
  const an = C.analyze(tenant, { draws: 600, alpha: 0.1 });
  for (const r of an.rules) {
    const th = r.threshold;
    if (!th.recommended) continue;
    assert.ok(th.recommended.fnr95 <= 0.1 + 1e-12);
    const rows = th.rows;
    for (let j = 1; j < rows.length; j++) assert.ok(rows[j].escalations >= rows[j - 1].escalations);
  }
  const okta = an.rules.find((r) => r.id === 'okta_mfa_push_fatigue');
  assert.equal(okta.threshold.action, 'tighten');
  assert.ok(okta.fit.b - 1.645 * okta.fit.se > 0, 'planted under-calling on the Okta rule is detected');
});

test('simulation report is present and shows calibrated coverage in the well-specified case', () => {
  const sim = JSON.parse(readFileSync(new URL('../data/simcheck.json', import.meta.url)));
  const w = sim.scenarios[0];
  assert.ok(w.reps >= 200);
  assert.ok(w.modelCoverageTotal >= 0.84 && w.modelCoverageTotal <= 0.97);
  assert.ok(w.modelCoveragePerRule >= 0.85);
  assert.ok(w.foundPerMonthTargeted > 5 * w.foundPerMonthUniform);
});

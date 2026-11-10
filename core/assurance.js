// Closure Assurance core.
//
// Question it answers for every tenant and detection rule: "How many real
// threats are sitting in the alerts our agents auto-closed, how sure are we,
// and which closed alerts should an analyst re-open tomorrow?"
//
// Per alert i: c_i = agent's false-positive confidence, closed iff c_i >= tau_r.
// Escalated alerts (c_i < tau_r) all receive an analyst verdict y_i.
// Closed alerts receive a verdict only if drawn into the closure-review sample
// (Poisson sampling with known inclusion probability pi_i).
//
// 1. Recalibration. Per rule, the agent's implied threat probability
//    m_i = 1 - c_i is recalibrated with an intercept shift b_r:
//      q_i(b) = sigmoid(logit(m_i) + b_r)
//    b_r is fit on the fully-labelled escalated alerts only (logistic MLE with
//    a N(0,1) prior), so the closure-review sample stays independent for (2).
// 2. Missed-threat estimate. M_r = sum over closed alerts of q_i(b_r).
//    90% interval by Monte Carlo over b_r ~ N(b_hat, se^2) plus Bernoulli
//    outcome noise (normal approximation).
// 3. Model check. Reviewed closed alerts are an independent probability
//    sample: observed true positives vs the Poisson-binomial distribution
//    implied by q gives an exact upper-tail p-value (agent under-calls threats).
// 4. Design-unbiased cross-check (prediction-powered / difference estimator):
//    M_hat = sum q_i + sum xi_i (y_i - q_i) / pi_i  (valid for any q).
// 5. Review planning. Take-all on the riskiest closed alerts plus a
//    sqrt-variance (Neyman) Poisson sample of the rest, trading missed threats
//    surfaced against the width of the design-unbiased estimate.
// 6. Threshold what-if. Missed-threat rate of the rule under any auto-close
//    threshold; recommended threshold = most automation whose 95th-percentile
//    missed-threat rate stays under the target.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function gaussian(rnd) {
  let u = 0, v = 0;
  while (u === 0) u = rnd();
  while (v === 0) v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Acklam's inverse normal CDF
export function normInv(p) {
  if (p <= 0 || p >= 1) throw new Error('p must be in (0,1)');
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const pl = 0.02425;
  let q, r;
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export const sigmoid = (z) => 1 / (1 + Math.exp(-z));
export const logit = (p) => Math.log(p / (1 - p));
const clampP = (p) => Math.min(1 - 1e-9, Math.max(1e-9, p));
export const agentLogit = (c) => logit(clampP(1 - c));

export function quantile(sorted, p) {
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p, lo = Math.floor(h), hi = Math.ceil(h);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (h - lo);
}

export function ruleIndex(tenant) {
  const idx = tenant.rules.map(() => []);
  const A = tenant.alerts;
  for (let i = 0; i < A.rule.length; i++) idx[A.rule[i]].push(i);
  return idx;
}

// ---------- 1. recalibration on escalated alerts ----------
export function fitShift(A, idx, priorSd = 2) {
  const L = [];
  for (const i of idx) if (A.esc[i]) L.push([agentLogit(A.conf[i]), A.y[i]]);
  const lam = 1 / (priorSd * priorSd);
  let b = 0, h = -lam;
  for (let it = 0; it < 100; it++) {
    let g = -lam * b; h = -lam;
    for (const [o, y] of L) { const s = sigmoid(o + b); g += y - s; h -= s * (1 - s); }
    const step = g / h;
    b -= step;
    if (Math.abs(step) < 1e-10) break;
  }
  let tp = 0, pred = 0;
  for (const [o, y] of L) { tp += y; pred += sigmoid(o); }
  return { b, se: Math.sqrt(-1 / h), n: L.length, tp, agentPredicted: pred };
}

// Bin closed alerts of a rule on the agent logit scale (exact enough for sums
// of sigmoids; bin width 0.02 in logit units).
export function binLogits(logits, width = 0.02) {
  const m = new Map();
  for (const o of logits) { const k = Math.round(o / width); m.set(k, (m.get(k) || 0) + 1); }
  const keys = [...m.keys()].sort((a, b) => a - b);
  return { x: keys.map((k) => k * width), w: keys.map((k) => m.get(k)) };
}
function sumQ(bins, b) {
  let s1 = 0, s2 = 0;
  for (let j = 0; j < bins.x.length; j++) { const q = sigmoid(bins.x[j] + b); s1 += bins.w[j] * q; s2 += bins.w[j] * q * (1 - q); }
  return [s1, s2];
}

// ---------- full analysis ----------
export function analyze(tenant, opts = {}) {
  const draws = opts.draws ?? 2000, seed = opts.seed ?? 7, conf = opts.conf ?? 0.9;
  const alpha = opts.alpha ?? 0.10; // target missed-threat rate (1 - recall)
  const A = tenant.alerts, idx = ruleIndex(tenant);
  const rnd = mulberry32(seed);
  const loQ = (1 - conf) / 2, hiQ = 1 - loQ;
  const Z = []; // shared standard normals for b per rule per draw, and outcome noise
  const rules = tenant.rules.map((r, k) => {
    const all = idx[k];
    const closed = all.filter((i) => !A.esc[i]);
    const fit = fitShift(A, all);
    const bins = binLogits(closed.map((i) => agentLogit(A.conf[i])));
    let agentPredMissed = 0; for (let j = 0; j < bins.x.length; j++) agentPredMissed += bins.w[j] * sigmoid(bins.x[j]);
    const [pointMissed] = sumQ(bins, fit.b);
    const zb = new Float64Array(draws), ze = new Float64Array(draws), Md = new Float64Array(draws), Bd = new Float64Array(draws);
    for (let d = 0; d < draws; d++) {
      zb[d] = gaussian(rnd); ze[d] = gaussian(rnd);
      const bd = fit.b + fit.se * zb[d]; Bd[d] = bd;
      const [s1, s2] = sumQ(bins, bd);
      Md[d] = Math.max(0, s1 + Math.sqrt(s2) * ze[d]);
    }
    const sorted = Array.from(Md).sort((a, b) => a - b);
    let escTP = 0; for (const i of all) if (A.esc[i]) escTP += A.y[i];
    // recall draws
    const rec = Array.from(Md, (m) => (escTP + m > 0 ? escTP / (escTP + m) : 1)).sort((a, b) => a - b);
    return {
      k, id: r.id, name: r.name, tactic: r.tactic, tau: r.tau, minutes: r.minutes,
      total: all.length, closed: closed.length, escalated: all.length - closed.length, escTP,
      fit, oddsRatio: Math.exp(fit.b), agentPredMissed, missed: { point: pointMissed, lo: quantile(sorted, loQ), hi: quantile(sorted, hiQ), median: quantile(sorted, 0.5) },
      recall: { point: escTP + pointMissed > 0 ? escTP / (escTP + pointMissed) : 1, lo: quantile(rec, loQ), hi: quantile(rec, hiQ) },
      _bins: bins, _Md: Md, _Bd: Bd, _closed: closed, _all: all,
    };
  });
  // total
  const tot = new Float64Array(draws);
  for (const r of rules) for (let d = 0; d < draws; d++) tot[d] += r._Md[d];
  const totSorted = Array.from(tot).sort((a, b) => a - b);
  const escTP = rules.reduce((s, r) => s + r.escTP, 0);
  const pointTotal = rules.reduce((s, r) => s + r.missed.point, 0);
  const recTot = Array.from(tot, (m) => escTP / (escTP + m)).sort((a, b) => a - b);
  const closedAll = rules.reduce((s, r) => s + r.closed, 0);
  const totals = {
    alerts: A.rule.length, closed: closedAll, escalated: A.rule.length - closedAll, escTP,
    reviewed: A.rev.reduce((s, v) => s + v, 0),
    missed: { point: pointTotal, lo: quantile(totSorted, loQ), hi: quantile(totSorted, hiQ) },
    agentPredMissed: rules.reduce((s, r) => s + r.agentPredMissed, 0),
    recall: { point: escTP / (escTP + pointTotal), lo: quantile(recTot, loQ), hi: quantile(recTot, hiQ) },
  };
  // review check and design-unbiased cross-check
  const qOf = (i) => sigmoid(agentLogit(A.conf[i]) + rules[A.rule[i]].fit.b);
  for (const r of rules) {
    r.check = reviewCheck(A, r._closed, qOf);
    r.ppi = ppiEstimate(A, r._closed, qOf, conf);
  }
  const allClosed = rules.flatMap((r) => r._closed);
  totals.check = reviewCheck(A, allClosed, qOf);
  totals.ppi = ppiEstimate(A, allClosed, qOf, conf);
  totals.classic = classicBound(A, allClosed, conf);
  // threshold what-if and recommendation
  if (!opts.skipThresholds) for (const r of rules) r.threshold = thresholdCurve(A, r, alpha, opts.grid, opts.minSaving);
  return { rules, totals, qOf, conf, alpha, draws };
}

// ---------- 3. review check (exact Poisson-binomial upper tail) ----------
export function poissonBinomialUpper(ps, k) {
  // P(X >= k) for X = sum Bernoulli(ps)
  if (k <= 0) return 1;
  let dp = new Float64Array(k + 1); dp[0] = 1; // dp[j] = P(X = j) for j < k, dp[k] = P(X >= k)
  for (const p of ps) {
    const nd = new Float64Array(k + 1);
    for (let j = 0; j <= k; j++) {
      if (dp[j] === 0) continue;
      if (j === k) { nd[k] += dp[k]; continue; }
      nd[j] += dp[j] * (1 - p);
      nd[j + 1] += dp[j] * p;
    }
    dp = nd;
  }
  return dp[k];
}
export function reviewCheck(A, closed, qOf) {
  const ps = []; let observed = 0;
  for (const i of closed) if (A.rev[i]) { ps.push(qOf(i)); observed += A.y[i]; }
  const expected = ps.reduce((s, p) => s + p, 0);
  return { reviewed: ps.length, observed, expected, pUpper: poissonBinomialUpper(ps, observed) };
}

// ---------- 4. design-unbiased (prediction-powered) cross-check ----------
export function ppiEstimate(A, closed, qOf, conf = 0.9) {
  let pred = 0, corr = 0, v = 0, reviewed = 0, found = 0;
  for (const i of closed) {
    const q = qOf(i); pred += q;
    if (A.rev[i]) {
      const p = A.pi[i], d = A.y[i] - q;
      corr += d / p; v += d * d * (1 - p) / (p * p);
      reviewed++; found += A.y[i];
    }
  }
  // Variance floor: the design variance implied by the working model. With rare
  // threats most review samples contain zero true positives, and the plug-in
  // variance alone would then be near zero (overconfident); the floor keeps the
  // interval honest about threats the sample could not have seen.
  let vFloor = 0;
  for (const i of closed) { const q = qOf(i), p = A.pi[i]; if (p < 1) vFloor += q * (1 - q) * (1 - p) / p; }
  const z = normInv(1 - (1 - conf) / 2), est = pred + corr, se = Math.sqrt(Math.max(v, vFloor));
  return { predicted: pred, est, se, lo: Math.max(0, est - z * se), hi: est + z * se, reviewed, found, plugInSe: Math.sqrt(v) };
}
// classical review-only bound: N * ClopperPearson(found, reviewed), uniform design
export function classicBound(A, closed, conf = 0.9) {
  let n = 0, rv = 0, f = 0;
  for (const i of closed) { n++; if (A.rev[i]) { rv++; f += A.y[i]; } }
  return { n, reviewed: rv, found: f, est: rv ? n * f / rv : NaN, hi: rv ? n * cpUpper(f, rv, 1 - (1 - conf) / 2) : n };
}

// ---------- 5. review planning ----------
// Expected squared residual of the difference estimator for alert with working
// probability q (estimator uses q itself): E[(y-q)^2] = q(1-q).
export function designVariance(qArr, piArr) {
  let v = 0;
  for (let i = 0; i < qArr.length; i++) { const q = qArr[i], p = piArr[i]; if (p < 1) v += q * (1 - q) * (1 - p) / p; }
  return v;
}
// Neyman allocation for a Poisson design: pi proportional to sqrt(q(1-q)),
// capped at 1, with a floor; sum(pi) = budget.
export function neymanDesign(qArr, budget, floor = 0.002) {
  const n = qArr.length;
  if (budget >= n) return new Array(n).fill(1);
  const s = qArr.map((q) => Math.sqrt(Math.max(q * (1 - q), 1e-12)));
  const pi = new Array(n).fill(floor);
  let rem = budget - floor * n;
  if (rem <= 0) return new Array(n).fill(budget / n);
  const free = new Set(s.keys());
  for (let it = 0; it < 40; it++) {
    let S = 0; for (const i of free) S += s[i];
    let capped = false;
    for (const i of [...free]) {
      const p = floor + rem * s[i] / S;
      if (p >= 1) { pi[i] = 1; free.delete(i); rem -= 1 - floor; capped = true; }
    }
    if (!capped) { for (const i of free) pi[i] = floor + rem * s[i] / S; break; }
  }
  return pi;
}
// Hybrid plan: analysts re-open the K riskiest closed alerts (take-all) and the
// remaining budget is a Neyman sample of the rest.
export function hybridPlan(qArr, budget, K, floor = 0.002) {
  const order = [...qArr.keys()].sort((a, b) => qArr[b] - qArr[a]);
  const pi = new Array(qArr.length);
  const rest = order.slice(K);
  order.slice(0, K).forEach((i) => (pi[i] = 1));
  const piR = neymanDesign(rest.map((i) => qArr[i]), Math.max(budget - K, floor * rest.length), floor);
  rest.forEach((i, j) => (pi[i] = piR[j]));
  let found = 0, reviews = 0; for (let i = 0; i < qArr.length; i++) { found += pi[i] * qArr[i]; reviews += pi[i]; }
  return { pi, order, K, expectedFound: found, expectedReviews: reviews, sd: Math.sqrt(designVariance(qArr, pi)) };
}
export function uniformPlan(qArr, budget) {
  const p = Math.min(1, budget / qArr.length);
  const pi = new Array(qArr.length).fill(p);
  let found = 0; for (const q of qArr) found += p * q;
  return { pi, expectedFound: found, expectedReviews: p * qArr.length, sd: Math.sqrt(designVariance(qArr, pi)) };
}
export function planFrontier(qArr, budget, steps = 12, floor = 0.002) {
  const out = [];
  const maxK = Math.floor(budget * 0.95);
  for (let s = 0; s <= steps; s++) {
    const K = Math.round(maxK * s / steps);
    const h = hybridPlan(qArr, budget, K, floor);
    out.push({ K, expectedFound: h.expectedFound, sd: h.sd });
  }
  return out;
}

// ---------- 6. threshold what-if ----------
export function thresholdGrid(tau) {
  const g = new Set([0.90, 0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.975, 0.98, 0.985, 0.99, 0.9925, 0.995, 0.9975, 0.999, 0.9995]);
  if (tau <= 1) g.add(tau);
  return [...g].sort((a, b) => a - b);
}
export function thresholdCurve(A, r, alpha, grid, minSaving) {
  grid = grid || thresholdGrid(r.tau);
  const all = r._all;
  const draws = r._Bd.length;
  const sub = Math.min(draws, 500);
  // pre-bin all alerts by confidence for fast partial sums
  const rows = [];
  for (const t of grid) {
    // alerts that would be auto-closed at threshold t
    let auto = 0, knownMissed = 0, escNew = 0;
    const closedNow = [];
    for (const i of all) {
      if (A.conf[i] >= t) {
        auto++;
        if (A.esc[i]) knownMissed += A.y[i]; // currently escalated, verdict known
        else closedNow.push(agentLogit(A.conf[i]));
      } else if (!A.esc[i]) escNew++; // currently closed, would be escalated
    }
    const bins = binLogits(closedNow);
    const fnr = new Float64Array(sub), mis = new Float64Array(sub);
    for (let d = 0; d < sub; d++) {
      const [s1] = sumQ(bins, r._Bd[d]);
      const [full] = sumQ(r._bins, r._Bd[d]); // expected threats in today's closed pool
      const m = knownMissed + s1;
      const total = r.escTP + full;
      mis[d] = m; fnr[d] = total > 0 ? m / total : 0;
    }
    const fs = Array.from(fnr).sort((a, b) => a - b), ms = Array.from(mis).sort((a, b) => a - b);
    const escalations = all.length - auto;
    rows.push({ t, auto, escalations, deltaEscalations: escalations - r.escalated, missedMed: quantile(ms, 0.5), missedHi: quantile(ms, 0.95), fnrMed: quantile(fs, 0.5), fnr95: quantile(fs, 0.95) });
  }
  // recommendation: lowest threshold (most automation) with fnr95 <= alpha and
  // every stricter threshold also passing (fixed-sequence scan from strict end)
  // Auto-close disabled by policy (tau > 1): never recommend enabling it.
  // Loosening is limited to two grid steps below the current threshold.
  const cur = rows.find((x) => Math.abs(x.t - r.tau) < 1e-9) || null;
  if (!cur) return { rows, recommended: null, current: null, action: 'policy' };
  const ci = rows.indexOf(cur);
  let rec = null;
  for (let j = rows.length - 1; j >= Math.max(0, ci - 2); j--) { if (rows[j].fnr95 <= alpha) rec = rows[j]; else break; }
  let action = 'keep';
  if (!rec) action = 'insufficient';
  else if (rec.t > cur.t + 1e-9) action = 'tighten';
  else if (rec.t < cur.t - 1e-9) {
    // only worth a change request if it removes at least 10 escalations / month
    if (cur.escalations - rec.escalations >= (minSaving ?? 10)) action = 'loosen'; else { action = 'keep'; rec = cur; }
  }
  return { rows, recommended: rec, current: cur, action };
}

// ---------- incomplete beta / Clopper-Pearson ----------
function lgamma(x) {
  const g = 7, cf = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * x))) - lgamma(1 - x);
  x -= 1; let s = cf[0];
  for (let i = 1; i < g + 2; i++) s += cf[i] / (x + i);
  const t = x + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}
function betacf(a, b, x) {
  const FPMIN = 1e-300; let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN; d = 1 / d; let h = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN; c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN; d = 1 / d;
    const del = d * c; h *= del; if (Math.abs(del - 1) < 3e-14) break;
  }
  return h;
}
export function betaInc(a, b, x) {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}
export function cpUpper(x, n, conf) {
  if (n <= 0 || x >= n) return 1;
  let lo = x / n, hi = 1;
  for (let it = 0; it < 80; it++) { const mid = (lo + hi) / 2; if (1 - betaInc(x + 1, n - x, mid) > 1 - conf) lo = mid; else hi = mid; }
  return hi;
}

// ---------- power of the review check ----------
// Poisson approximation to the number of true positives found by a review
// design; H0 uses q, H1 multiplies the threat odds by `factor` on alerts where
// region(i) is true. Returns the probability that the review check (upper-tail
// test at level a) flags the drift.
function poissonUpper(lam, k) {
  if (k <= 0) return 1;
  let term = Math.exp(-lam), cdf = term;
  for (let j = 1; j < k; j++) { term *= lam / j; cdf += term; }
  return Math.max(0, 1 - cdf);
}
export function reviewPower(qArr, piArr, factor, region = () => true, a = 0.05) {
  let l0 = 0, l1 = 0;
  for (let i = 0; i < qArr.length; i++) {
    const q = qArr[i], p = piArr[i];
    l0 += p * q;
    const q1 = region(i) ? sigmoid(logit(Math.min(1 - 1e-12, Math.max(1e-12, q))) + Math.log(factor)) : q;
    l1 += p * q1;
  }
  let k = 0; while (poissonUpper(l0, k) > a) k++;
  return { expectedH0: l0, expectedH1: l1, critical: k, power: poissonUpper(l1, k) };
}

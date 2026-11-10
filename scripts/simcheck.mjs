// Monte Carlo check of Closure Assurance on regenerated tenants.
// node scripts/simcheck.mjs [reps]  -> data/simcheck.json
import { writeFileSync } from 'node:fs';
import { generateTenant } from '../core/generate.js';
import { analyze, uniformPlan, hybridPlan, mulberry32, poissonBinomialUpper } from '../core/assurance.js';

const REPS = +(process.argv[2] || 200);
const BUDGET = 1260, K = 240;

function runScenario(name, opts) {
  let covTotal = 0, covRule = 0, nRule = 0, covPPI = 0, covClassic = 0;
  let widthModel = 0, widthClassic = 0, widthPPI = 0;
  let foundUni = 0, foundHyb = 0, powUni = 0, powHyb = 0, covHybPPI = 0;
  for (let r = 0; r < REPS; r++) {
    const { tenant, truth } = generateTenant(1000 + r, opts);
    const an = analyze(tenant, { draws: 400, skipThresholds: true, seed: 11 + r });
    const A = tenant.alerts;
    let tot = 0;
    for (const ru of an.rules) {
      let m = 0; for (const i of ru._closed) m += truth.y[i];
      tot += m;
      if (ru.closed > 0) { nRule++; if (m >= ru.missed.lo - 1e-9 && m <= ru.missed.hi + 1e-9) covRule++; }
    }
    const t = an.totals;
    if (tot >= t.missed.lo && tot <= t.missed.hi) covTotal++;
    if (tot >= t.ppi.lo && tot <= t.ppi.hi) covPPI++;
    if (tot <= t.classic.hi) covClassic++;
    widthModel += t.missed.hi - t.missed.lo; widthClassic += t.classic.hi; widthPPI += t.ppi.hi - t.ppi.lo;
    // re-run next month's closure review under both designs on the same closed pool
    const closed = an.rules.flatMap((ru) => ru._closed);
    const q = closed.map(an.qOf), y = closed.map((i) => truth.y[i]);
    const rnd = mulberry32(77 + r);
    for (const [plan, tag] of [[uniformPlan(q, BUDGET), 'u'], [hybridPlan(q, BUDGET, K), 'h']]) {
      let obs = 0, corr = 0, v = 0; const ps = [];
      let vFloor = 0, pred = 0;
      for (let j = 0; j < q.length; j++) {
        const p = plan.pi[j]; pred += q[j];
        if (p < 1) vFloor += q[j] * (1 - q[j]) * (1 - p) / p;
        if (rnd() < p) { obs += y[j]; ps.push(q[j]); const d = y[j] - q[j]; corr += d / p; v += d * d * (1 - p) / (p * p); }
      }
      const pval = poissonBinomialUpper(ps, obs);
      if (tag === 'u') { foundUni += obs; if (pval < 0.05) powUni++; }
      else {
        foundHyb += obs; if (pval < 0.05) powHyb++;
        const est = pred + corr, se = Math.sqrt(Math.max(v, vFloor));
        if (tot >= est - 1.645 * se && tot <= est + 1.645 * se) covHybPPI++;
      }
    }
  }
  return {
    scenario: name, reps: REPS,
    modelCoverageTotal: covTotal / REPS, modelCoveragePerRule: covRule / nRule,
    ppiCoverageUniform: covPPI / REPS, ppiCoverageTargeted: covHybPPI / REPS, classicCoverage: covClassic / REPS,
    meanWidthModel: widthModel / REPS, meanWidthPPI: widthPPI / REPS, meanClassicUpper: widthClassic / REPS,
    foundPerMonthUniform: foundUni / REPS, foundPerMonthTargeted: foundHyb / REPS,
    checkPowerUniform: powUni / REPS, checkPowerTargeted: powHyb / REPS,
  };
}

const t0 = Date.now();
const wellSpecified = runScenario('well-specified', {});
// Misspecified: the agent is far more over-confident on its most confident
// closures than on the escalated range the recalibration is fit on.
const drift = runScenario('confidence-dependent drift', { betaFn: (beta, c) => (c > 0.9995 ? beta + 1.6 : beta) });
const out = { generated: new Date().toISOString().slice(0, 10), budget: BUDGET, takeAll: K, conf: 0.9, scenarios: [wellSpecified, drift], seconds: (Date.now() - t0) / 1000 };
writeFileSync(new URL('../data/simcheck.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));

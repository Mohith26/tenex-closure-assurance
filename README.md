# Closure Assurance for TENEX.AI (concept demo)

**Live demo:** https://mohith26.github.io/tenex-closure-assurance/

An unofficial concept feature for the TENEX.AI agentic SecOps platform. It answers a question every CISO asks an AI SOC and that a random QA sample can't answer:

> Of the alerts our agents auto-closed this month, how many were real threats, how sure are we, and which closures should an analyst re-open next?

Unofficial concept demo by Mohith Gajjela. Not affiliated with TENEX.AI. All data is synthetic (one fictional tenant, "Halvorsen Freight", 42,095 alerts over 30 days, 18 detection rules).

## Why this is hard

At AI-SOC accuracy levels the threats inside auto-closed alerts are rare and spread thin. In the demo tenant, 41,211 alerts were auto-closed and 1,259 of them (3%) were randomly re-reviewed. The reviews found **zero** threats. On their own, the reviews can only say that no more than **98** threats were missed (exact one-sided 95% bound). That is too loose to manage against, and a design-unbiased estimator that adds the agent's own scores still only narrows it to **0–35**.

The page's estimate is **17 missed threats (90% interval 12–26)**. The hidden truth in the synthetic data is 18. The agent's own confidence scores put it at 12, because the agent under-calls threats on four rules.

## How it works

1. **Recalibrate the agent per rule on escalated alerts.** Every escalated alert gets an analyst verdict, so those 884 verdicts are a fully labelled set. For each rule, fit one logistic intercept shift `q = σ(logit(1 − FP confidence) + b)` with a N(0, 2²) prior. `b > 0` means the agent under-calls threats on that rule (in the demo, the Okta MFA push-fatigue rule comes out at ×3.1 odds).
2. **Estimate the threats inside each rule's auto-closes.** Sum `q` over the rule's closed alerts. The 90% interval comes from 2,000 Monte Carlo draws of `b` from its Laplace posterior plus the Bernoulli noise of which alerts are real.
3. **Check the model on closure reviews.** Reviews are an independent random sample, so the number of threats they find is Poisson-binomial under the model. An exact upper-tail p-value flags rules where the agent does worse on closed alerts than on escalated ones.
4. **Cross-check without the calibration assumption.** The difference (prediction-powered) estimator `Σq + Σ (y − q)/π` is unbiased for any `q` under the known review design. Its variance gets a model-implied floor so that a sample with no hits doesn't report a falsely narrow interval.
5. **Plan reviews by risk.** Re-open the K riskiest closures each day and Neyman-sample the rest (inclusion ∝ √(q(1 − q)), known π, floor 0.2%). Every estimate stays unbiased, and the same 42 reviews a day surface about **6.5 missed threats a month instead of 0.5**, while the cross-check interval tightens from ±37 to ±27.
6. **Threshold what-if.** For each candidate auto-close threshold, compute the rule's missed-threat rate across the posterior draws. Scanning from strict to lenient, the page recommends the most automation whose 95th-percentile miss rate meets the target (recall ≥ 90% by default). Auto-close stays off where policy disables it (for example, Okta super-admin assignments). In the demo, four rules should tighten, which costs +24 escalations a month (about 4.5 analyst hours).

## Simulation check (scripts/simcheck.mjs, 200 regenerated tenants per scenario)

| | Agent calibration transfers | Agent 5× worse on closures with FP confidence > 0.9995 |
|---|---|---|
| 90% interval covers true missed count (tenant) | 85% | 2% |
| 90% interval covers true count (per rule) | 92% | 64% |
| Mean interval width vs review-only bound | 14 vs 130 | 14 vs 167 |
| Threats surfaced per month, random vs risk plan | 0.4 vs 6.0 | 1.2 vs 6.7 |
| Review check flags the drift, random vs risk plan | n/a | 13% vs 7% |

What these numbers mean:
- When calibration transfers from the escalated range to the closed range, the interval roughly holds its coverage (85% tenant-level, slightly under the 90% target; 92% per rule) and is about 9× tighter than anything the reviews can certify alone.
- When the agent is much worse on its most confident closures (FP confidence > 0.9995, most of the closed pool) than on the escalated range it was recalibrated on, the model under-counts. At these base rates a 1,260-review month rarely catches it, with either design. The page says this out loud: it reports the power of the review check and does not claim to see drift in the confident bulk.

## Run it

```
node scripts/generate.mjs        # data/tenant.json + data/truth.json (seed 20261107)
node scripts/simcheck.mjs 200    # data/simcheck.json
node --test test/assurance.test.mjs
python3 -m http.server           # open http://localhost:8000
```

There's no build step. The page is static HTML, CSS and ES modules, and loads Lucide icons and Google Fonts from CDNs. `core/assurance.js` runs both in the browser and under `node --test` (11 tests: known-value checks for the special functions, Poisson-binomial vs brute force, planted-shift recovery, design-unbiasedness under a deliberately wrong model, Neyman budget/caps, realised gain of the risk plan on hidden truth, internal consistency, threshold monotonicity, and the committed simulation report). The estimator only reads labels for escalated or reviewed alerts. `data/truth.json` is used only by the tests and the simulation.

## Honest limitations

- Synthetic data. The generator plants a calibration shift that is constant within a rule (the same family the model fits). That is the favourable case. The drift scenario shows what happens when it isn't.
- One intercept per rule is a deliberately small model. Real agents probably need recalibration by rule and by entity or context, and the escalated range may not represent the very-high-confidence range (the core assumption, which step 3 can only partly check).
- Escalation verdicts are treated as ground truth. Verdict errors and late-confirmed incidents (retro-hunts, customer reports) are not modelled. These would be the natural next evidence source for bulk drift.
- Thresholds, minutes per escalation, and the 10%-miss target are illustrative.
- The UI follows the TENEX.AI app's public design tokens (colours, fonts, radii) and its public sign-in page. I found no public screenshots of the logged-in product, so the layout is my reconstruction, not a copy.

## Novelty note

TENEX publicly describes benign alerts closing themselves within customer guardrails, "glass box" evidence for every closed alert, and named analysts owning consequential decisions. I found no public TENEX material that estimates how many threats sit inside AI-closed alerts with a calibrated interval, recalibrates the agent's confidence per rule, or plans closure reviews by risk. Other AI-SOC vendors publish QA by random sampling (Intezer reviews a 5% random sample; Dropzone describes an ISO 2859 acceptance-sampling framework), and a 2026 academic paper calibrates conformal auto-close thresholds on labelled benchmarks. None of these combine model-based missed-threat estimation, a design-unbiased cross-check, risk-targeted review planning, and per-rule threshold certification in the product.

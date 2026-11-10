import { analyze, hybridPlan, uniformPlan, reviewPower, mulberry32 } from './core/assurance.js';

const $ = (s) => document.querySelector(s);
const fmt = (n, d = 0) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const NS = 'http://www.w3.org/2000/svg';
const C = { primary: '#61d6e5', muted: '#a9acb0', muted2: '#8c9195', grid: '#1f272e', axis: '#353c43', fg: '#f0f1f1', green: '#16a34a', orange: '#ea6b14', red: '#eb675c', purple: '#9c7cf7' };

let T, SIM, AN, Q, ORDER, CLOSED, sortKey = 'missed', sortDir = -1, actionFilter = 'all', searchQ = '';
const tip = $('#tip');
function showTip(e, html) { tip.innerHTML = html; tip.classList.add('on'); const x = Math.min(e.clientX + 14, innerWidth - 320); tip.style.left = x + 'px'; tip.style.top = (e.clientY + 14) + 'px'; }
function hideTip() { tip.classList.remove('on'); }
function el(tag, attrs = {}, parent) { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); if (parent) parent.appendChild(n); return n; }
function txt(parent, x, y, s, attrs = {}) { const t = el('text', { x, y, fill: C.muted, 'font-size': 12, ...attrs }, parent); t.textContent = s; return t; }
function niceMax(v) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }

async function main() {
  const [t, s] = await Promise.all([fetch('data/tenant.json').then((r) => r.json()), fetch('data/simcheck.json').then((r) => r.json())]);
  T = t; SIM = s;
  const p = T.tenant.period;
  $('#periodLabel').textContent = 'Oct 9 – Nov 7, 2026';
  run(+$('#alphaSel').value);
  $('#alphaSel').addEventListener('change', (e) => { run(+e.target.value); });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    const target = document.getElementById(b.dataset.target);
    window.scrollTo({ top: target.getBoundingClientRect().top + scrollY - 66, behavior: 'smooth' });
  }));
  $('#ruleSearch').addEventListener('input', (e) => { searchQ = e.target.value.toLowerCase(); renderRules(); });
  document.querySelectorAll('#actionSeg button').forEach((b) => b.addEventListener('click', () => {
    actionFilter = b.dataset.f; document.querySelectorAll('#actionSeg button').forEach((x) => x.classList.toggle('on', x === b)); renderRules();
  }));
  $('#sheetClose').addEventListener('click', closeSheet); $('#scrim').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });
  $('#exportBtn').addEventListener('click', exportCsv);
  const budgetEl = $('#budget'), takeEl = $('#take');
  budgetEl.value = Math.round(AN.totals.reviewed / T.tenant.period.days); takeEl.value = 8;
  budgetEl.addEventListener('input', () => { if (+takeEl.value > +budgetEl.value) takeEl.value = budgetEl.value; renderPlan(); });
  takeEl.addEventListener('input', () => { if (+takeEl.value > +budgetEl.value) takeEl.value = budgetEl.value; renderPlan(); });
  renderPlan(); renderMethod(); renderSim();
  document.body.classList.add('ready');
  lucide.createIcons();
  const h = new URLSearchParams(location.hash.slice(1));
  if (h.get('rule')) { const r = AN.rules.find((x) => x.id === h.get('rule')); if (r) openSheet(r); }
}

function run(alpha) {
  AN = analyze(T, { alpha, draws: 2000, seed: 7 });
  CLOSED = AN.rules.flatMap((r) => r._closed);
  Q = CLOSED.map(AN.qOf);
  ORDER = [...Q.keys()].sort((a, b) => Q[b] - Q[a]);
  renderKpis(); renderForest(); renderMethods(); renderRules();
  if (document.body.classList.contains('ready')) { renderPlan(); renderMethod(); lucide.createIcons(); }
}

function actionOf(r) { return r.threshold.action; }
function renderKpis() {
  const t = AN.totals;
  const tighten = AN.rules.filter((r) => actionOf(r) === 'tighten'), loosen = AN.rules.filter((r) => actionOf(r) === 'loosen');
  const dUp = tighten.reduce((s, r) => s + r.threshold.recommended.deltaEscalations, 0);
  const dDown = loosen.reduce((s, r) => s + r.threshold.recommended.deltaEscalations, 0);
  const hrs = (rs) => rs.reduce((s, r) => s + r.threshold.recommended.deltaEscalations * r.minutes, 0) / 60;
  const k = [
    { i: 'circle-check-big', l: 'Auto-closed by agents', v: fmt(t.closed), s: `${pct(t.closed / t.alerts)} of ${fmt(t.alerts)} alerts · ${fmt(t.escalated)} escalated to analysts` },
    { i: 'shield-alert', l: 'Threats inside auto-closed', v: fmt(t.missed.point) + '<small>estimated</small>', s: `90% interval ${fmt(t.missed.lo)}–${fmt(t.missed.hi)} · agent's own estimate ${fmt(t.agentPredMissed)}`, hl: true },
    { i: 'target', l: 'Detection recall', v: pct(t.recall.point), s: `90% interval ${pct(t.recall.lo)}–${pct(t.recall.hi)} · ${fmt(t.escTP)} confirmed threats escalated` },
    { i: 'clipboard-check', l: 'Closure reviews', v: fmt(t.reviewed), s: `${t.check.observed} ${t.check.observed === 1 ? 'threat' : 'threats'} found · ${t.check.expected.toFixed(1)} expected · check p = ${t.check.pUpper.toFixed(2)}` },
    { i: 'sliders-horizontal', l: 'Thresholds to change', v: String(tighten.length + loosen.length), s: [tighten.length ? `${tighten.length} to tighten: +${dUp} escalations, +${hrs(tighten).toFixed(1)} analyst h / mo` : '', loosen.length ? `${loosen.length} can automate more: ${dDown} escalations, ${hrs(loosen).toFixed(1)} h / mo` : ''].filter(Boolean).join(' · ') || 'All rules meet the target' },
  ];
  $('#kpis').innerHTML = k.map((x) => `<div class="kpi${x.hl ? ' hl' : ''}"><div class="k-l"><i data-lucide="${x.i}"></i>${x.l}</div><div class="k-v">${x.v}</div><div class="k-s">${x.s}</div></div>`).join('');
  lucide.createIcons();
}

function renderForest() {
  const rows = AN.rules.filter((r) => r.closed > 0).sort((a, b) => b.missed.point - a.missed.point);
  $('#forestSub').textContent = `${rows.length} rules with agent auto-close enabled · recalibrated on ${fmt(AN.totals.escalated)} escalated verdicts`;
  const W = 760, rowH = 25, top = 8, left = 312, right = 44, H = top + rows.length * rowH + 40;
  const max = niceMax(Math.max(...rows.map((r) => r.missed.hi)) * 1.05);
  const x = (v) => left + (W - left - right) * v / max;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = max * i / ticks, xx = x(v);
    el('line', { x1: xx, x2: xx, y1: top, y2: top + rows.length * rowH, stroke: i === 0 ? C.axis : C.grid }, svg);
    txt(svg, xx, top + rows.length * rowH + 16, fmt(v, v % 1 ? 1 : 0), { 'text-anchor': 'middle', 'font-size': 11, fill: C.muted2 });
  }
  txt(svg, (left + W - right) / 2, H - 2, 'threats inside auto-closed alerts, 30 days', { 'text-anchor': 'middle', 'font-size': 11, fill: C.muted2 });
  rows.forEach((r, j) => {
    const y = top + j * rowH + rowH / 2;
    const g = el('g', { class: 'frow', cursor: 'pointer' }, svg);
    el('rect', { x: 0, y: y - rowH / 2, width: W, height: rowH, fill: 'transparent' }, g);
    const name = r.name.length > 44 ? r.name.slice(0, 43) + '…' : r.name;
    txt(g, left - 14, y + 4, name, { 'text-anchor': 'end', fill: '#c5c7c9', 'font-size': 12 });
    el('line', { x1: x(r.missed.lo), x2: x(r.missed.hi), y1: y, y2: y, stroke: C.primary, 'stroke-width': 6, 'stroke-linecap': 'round', opacity: 0.38 }, g);
    el('circle', { cx: x(r.agentPredMissed), cy: y, r: 4, fill: '#0c1217', stroke: C.muted, 'stroke-width': 1.5 }, g);
    el('circle', { cx: x(r.missed.point), cy: y, r: 4.5, fill: C.primary }, g);
    const flag = r.check.pUpper < 0.05;
    if (actionOf(r) === 'tighten') txt(g, x(r.missed.hi) + 10, y + 4, 'tighten', { 'font-size': 11, fill: 'hsl(38 90% 70%)' });
    g.addEventListener('mousemove', (e) => showTip(e, `<b>${esc(r.name)}</b><br><span class="t-m">Recalibrated estimate</span> ${r.missed.point.toFixed(1)} (90%: ${r.missed.lo.toFixed(1)}–${r.missed.hi.toFixed(1)})<br><span class="t-m">Agent's own estimate</span> ${r.agentPredMissed.toFixed(1)}<br><span class="t-m">Threat odds vs agent</span> ×${r.oddsRatio.toFixed(2)}${flag ? '<br>Review check flags this rule' : ''}<br><span class="t-m">Click for threshold what-if</span>`));
    g.addEventListener('mouseleave', hideTip);
    g.addEventListener('click', () => openSheet(r));
  });
  $('#forest').replaceChildren(svg);
}

function renderMethods() {
  const t = AN.totals;
  const items = [
    { l: 'Closure reviews only', s: `${fmt(t.classic.reviewed)} random reviews, exact bound`, lo: 0, hi: t.classic.hi, c: C.muted2 },
    { l: 'Reviews + agent scores', s: 'design-unbiased cross-check', lo: t.ppi.lo, hi: t.ppi.hi, c: C.purple },
    { l: 'Recalibrated agent', s: 'this page', lo: t.missed.lo, hi: t.missed.hi, pt: t.missed.point, c: C.primary },
  ];
  const W = 380, left = 8, right = 16, rowH = 56, top = 6, H = top + items.length * rowH + 24;
  const max = niceMax(Math.max(...items.map((i) => i.hi)));
  const x = (v) => left + (W - left - right) * v / max;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  for (let i = 0; i <= 4; i++) { const v = max * i / 4; el('line', { x1: x(v), x2: x(v), y1: top, y2: top + items.length * rowH, stroke: i ? C.grid : C.axis }, svg); txt(svg, x(v), H - 6, fmt(v), { 'text-anchor': i === 0 ? 'start' : i === 4 ? 'end' : 'middle', 'font-size': 11, fill: C.muted2 }); }
  items.forEach((it, j) => {
    const y = top + j * rowH;
    txt(svg, left, y + 16, it.l, { fill: C.fg, 'font-size': 12.5, 'font-weight': 500 });
    txt(svg, W - right, y + 16, `${fmt(it.lo)}–${fmt(it.hi)}`, { 'text-anchor': 'end', fill: C.fg, 'font-size': 12.5, 'font-family': 'Geist Mono, monospace' });
    txt(svg, left, y + 31, it.s, { fill: C.muted2, 'font-size': 11 });
    el('line', { x1: x(it.lo), x2: Math.max(x(it.hi), x(it.lo) + 2), y1: y + 44, y2: y + 44, stroke: it.c, 'stroke-width': 7, 'stroke-linecap': 'round', opacity: it.pt != null ? 0.55 : 0.45 }, svg);
    if (it.pt != null) el('circle', { cx: x(it.pt), cy: y + 44, r: 4.5, fill: C.primary }, svg);
  });
  $('#methods').replaceChildren(svg);
  const shrink = t.classic.hi / Math.max(1e-9, t.missed.hi - t.missed.lo);
  renderBands();
  $('#methodsNote').innerHTML = `${fmt(t.classic.reviewed)} random closure reviews found <b>${t.classic.found}</b> threats. On their own they only rule out more than <b>${fmt(t.classic.hi)}</b> missed threats. Recalibrating the agent's confidence on the ${fmt(t.escalated)} escalated alerts, where every verdict is known, gives <b>${fmt(t.missed.lo)}–${fmt(t.missed.hi)}</b>, an interval ${shrink.toFixed(0)}× tighter.`;
}

function renderBands() {
  const A = T.alerts;
  const edges = [[0, 0.99, 'threshold – 0.99'], [0.99, 0.999, '0.99 – 0.999'], [0.999, 0.9999, '0.999 – 0.9999'], [0.9999, 2, '≥ 0.9999']];
  const agg = edges.map(() => ({ n: 0, q: 0 }));
  CLOSED.forEach((i, j) => { const c = A.conf[i]; const b = edges.findIndex(([lo, hi]) => c >= lo && c < hi); agg[b].n++; agg[b].q += Q[j]; });
  const N = CLOSED.length, M = agg.reduce((s, a) => s + a.q, 0);
  $('#bands').innerHTML = `<div class="band-row band-head"><span></span><span>Share of auto-closes</span><span>Share of missed threats</span></div>` + edges.map(([, , l], k) => `<div class="band-row"><span class="mono">${l}</span><span class="bar"><i style="width:${(agg[k].n / N * 100).toFixed(1)}%;background:#41484e"></i><em>${pct(agg[k].n / N, 0)}</em></span><span class="bar"><i style="width:${(agg[k].q / M * 100).toFixed(1)}%"></i><em>${pct(agg[k].q / M, 0)} · ${agg[k].q.toFixed(1)}</em></span></div>`).join('');
}

function calBadge(r) {
  const b = r.fit.b, se = r.fit.se;
  if (r.fit.n < 15) return '<span class="badge b-neutral">Too few verdicts</span>';
  if (b - 1.645 * se > 0) return `<span class="badge b-high" title="Threat odds ×${Math.exp(b).toFixed(2)} vs the agent\'s confidence"><i data-lucide="trending-down"></i>Under-calls ×${Math.exp(b).toFixed(1)}</span>`;
  if (b + 1.645 * se < 0) return `<span class="badge b-info"><i data-lucide="trending-up"></i>Over-calls ×${Math.exp(-b).toFixed(1)}</span>`;
  return '<span class="badge b-med"><i data-lucide="check"></i>Calibrated</span>';
}
function actionBadge(r) {
  const a = actionOf(r);
  if (a === 'tighten') return '<span class="badge b-high"><i data-lucide="arrow-up"></i>Tighten</span>';
  if (a === 'loosen') return '<span class="badge b-info"><i data-lucide="arrow-down"></i>Automate more</span>';
  if (a === 'policy') return '<span class="badge b-neutral"><i data-lucide="lock"></i>Auto-close off</span>';
  if (a === 'insufficient') return '<span class="badge b-crit"><i data-lucide="triangle-alert"></i>Escalate all</span>';
  return '<span class="badge b-neutral">Keep</span>';
}
const COLS = [
  { k: 'name', l: 'Rule', v: (r) => r.name },
  { k: 'closed', l: 'Auto-closed', num: true, v: (r) => r.closed },
  { k: 'escTP', l: 'Escalated · TP', num: true, v: (r) => r.escTP },
  { k: 'cal', l: 'Agent calibration', v: (r) => r.fit.b },
  { k: 'missed', l: 'Threats in closed', num: true, v: (r) => r.missed.point },
  { k: 'recall', l: 'Recall', v: (r) => r.recall.point },
  { k: 'check', l: 'Review hits', num: true, v: (r) => r.check.reviewed },
  { k: 'thr', l: 'Threshold', v: (r) => r.tau },
  { k: 'action', l: 'Action', v: (r) => ['tighten', 'insufficient', 'loosen', 'keep', 'policy'].indexOf(actionOf(r)) },
];
function renderRules() {
  const tighten = AN.rules.filter((r) => actionOf(r) === 'tighten').length;
  $('#rulesSub').textContent = `${AN.rules.length} detection rules · target recall per rule ${pct(1 - AN.alpha, 0)} at the 95th percentile · click a rule for its threshold what-if`;
  const thead = $('#rulesTbl thead'), tbody = $('#rulesTbl tbody');
  thead.innerHTML = '<tr>' + COLS.map((c) => `<th data-k="${c.k}" class="${c.num ? 'num' : ''}">${c.l}${sortKey === c.k ? `<span class="sort">${sortDir < 0 ? '▼' : '▲'}</span>` : ''}</th>`).join('') + '</tr>';
  thead.querySelectorAll('th').forEach((th) => th.addEventListener('click', () => { const k = th.dataset.k; sortDir = sortKey === k ? -sortDir : -1; sortKey = k; renderRules(); }));
  const col = COLS.find((c) => c.k === sortKey);
  let rows = AN.rules.slice().sort((a, b) => { const va = col.v(a), vb = col.v(b); return (typeof va === 'string' ? va.localeCompare(vb) : va - vb) * sortDir; });
  if (actionFilter !== 'all') rows = rows.filter((r) => actionOf(r) === actionFilter);
  if (searchQ) rows = rows.filter((r) => (r.name + ' ' + r.id + ' ' + r.tactic).toLowerCase().includes(searchQ));
  tbody.innerHTML = rows.map((r) => {
    const th = r.threshold, rec = th.recommended;
    const thr = r.tau > 1 ? '<span class="dim">Off</span>' : `<span class="mono">${r.tau.toFixed(3)}</span>${rec && rec.t !== r.tau ? `<span class="arrow">→</span><span class="mono" style="color:${rec.t > r.tau ? 'hsl(38 90% 70%)' : 'hsl(195 90% 72%)'}">${rec.t.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}</span>` : ''}`;
    const rc = r.recall;
    const missed = r.closed ? `${r.missed.point.toFixed(1)}<span class="ci">${r.missed.lo.toFixed(1)}–${r.missed.hi.toFixed(1)}</span>` : '<span class="dim">–</span>';
    const recall = r.closed ? `<span class="minibar"><i style="left:${(rc.lo * 100 - 80) * 5}%;right:${100 - (rc.hi * 100 - 80) * 5}%"></i></span>${pct(rc.point)}` : '<span class="dim">100%</span>';
    const chk = r.check.reviewed ? `<span title="${r.check.expected.toFixed(2)} expected under the recalibrated agent, p = ${r.check.pUpper.toFixed(2)}">${r.check.observed}<span class="ci">/ ${fmt(r.check.reviewed)}</span></span>` : '<span class="dim">–</span>';
    return `<tr data-id="${r.id}"><td><div class="rule-name">${esc(r.name)}</div><div class="rule-id">${r.id}<span class="tac">${r.tactic}</span></div></td><td class="num mono">${fmt(r.closed)}</td><td class="num mono">${fmt(r.escalated)} · ${fmt(r.escTP)}</td><td>${r.tau > 1 ? '<span class="dim">–</span>' : calBadge(r)}</td><td class="num mono">${missed}</td><td class="mono">${recall}</td><td class="num mono">${chk}</td><td>${thr}</td><td>${actionBadge(r)}</td></tr>`;
  }).join('');
  tbody.querySelectorAll('tr').forEach((tr) => tr.addEventListener('click', () => openSheet(AN.rules.find((x) => x.id === tr.dataset.id))));
  lucide.createIcons();
}

// ---------- review plan ----------
function fastHybrid(budget, K) {
  // reuse the global risk order
  const n = Q.length, pi = new Array(n);
  ORDER.forEach((i, j) => { if (j < K) pi[i] = 1; });
  const restIdx = ORDER.slice(K);
  const sub = hybridPlan(restIdx.map((i) => Q[i]), Math.max(budget - K, 0.002 * restIdx.length), 0);
  restIdx.forEach((i, j) => (pi[i] = sub.pi[j]));
  let found = 0, v = 0; for (let i = 0; i < n; i++) { found += pi[i] * Q[i]; if (pi[i] < 1) v += Q[i] * (1 - Q[i]) * (1 - pi[i]) / pi[i]; }
  return { pi, expectedFound: found, sd: Math.sqrt(v), K };
}
function renderPlan() {
  const days = T.tenant.period.days;
  const b = +$('#budget').value, k = +$('#take').value;
  $('#budgetVal').textContent = b; $('#takeVal').textContent = k;
  const B = b * days, K = k * days;
  const uni = uniformPlan(Q, B), plan = fastHybrid(B, K);
  const z = 1.645;
  // frontier
  const pts = []; const kmax = Math.min(Math.floor(b * 0.75), 40);
  for (let kk = 0; kk <= kmax; kk += Math.max(1, Math.round(kmax / 14))) pts.push(fastHybrid(B, kk * days));
  if (!pts.find((p) => p.K === K)) pts.push(plan);
  pts.sort((a, c) => a.K - c.K);
  const W = 760, H = 250, l = 46, r = 18, t = 14, bt = 36;
  const xmax = niceMax(Math.max(uni.sd, plan.sd, ...pts.map((p) => Math.min(p.sd, uni.sd * 1.6))) * z * 1.1), ymax = niceMax(Math.max(...pts.map((p) => p.expectedFound)) * 1.12);
  const X = (v) => l + (W - l - r) * v / xmax, Y = (v) => H - bt - (H - bt - t) * v / ymax;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  for (let i = 0; i <= 4; i++) {
    const yv = ymax * i / 4; el('line', { x1: l, x2: W - r, y1: Y(yv), y2: Y(yv), stroke: i ? C.grid : C.axis }, svg); txt(svg, l - 8, Y(yv) + 4, fmt(yv, yv % 1 ? 1 : 0), { 'text-anchor': 'end', 'font-size': 11, fill: C.muted2 });
    const xv = xmax * i / 4; txt(svg, X(xv), H - bt + 16, '±' + fmt(xv), { 'text-anchor': 'middle', 'font-size': 11, fill: C.muted2 });
  }
  txt(svg, (l + W - r) / 2, H - 4, 'cross-check interval, ± missed threats (lower is better)', { 'text-anchor': 'middle', 'font-size': 11, fill: C.muted2 });
  txt(svg, 10, t + 4, 'threats surfaced / mo', { 'font-size': 11, fill: C.muted2, transform: `rotate(-90 10 ${t + 4})`, 'text-anchor': 'end' });
  el('path', { d: pts.filter((p) => p.sd <= uni.sd * 1.6).map((p, i) => `${i ? 'L' : 'M'}${X(p.sd * z)},${Y(p.expectedFound)}`).join(''), fill: 'none', stroke: C.primary, 'stroke-width': 1.75, opacity: 0.8 }, svg);
  pts.filter((p) => p.sd <= uni.sd * 1.6).forEach((p) => { const c = el('circle', { cx: X(p.sd * z), cy: Y(p.expectedFound), r: 3, fill: '#0c1217', stroke: C.primary, 'stroke-width': 1.5 }, svg); c.addEventListener('mousemove', (e) => showTip(e, `Re-open top ${p.K / days}/day, sample the rest<br><span class="t-m">Surfaced</span> ${p.expectedFound.toFixed(1)}/mo · <span class="t-m">cross-check</span> ±${(p.sd * z).toFixed(1)}`)); c.addEventListener('mouseleave', hideTip); });
  el('circle', { cx: X(uni.sd * z), cy: Y(uni.expectedFound), r: 5, fill: C.muted2 }, svg);
  txt(svg, X(uni.sd * z) + 9, Y(uni.expectedFound) - 8, `Random ${b}/day (today)`, { 'font-size': 11, fill: C.muted });
  el('circle', { cx: X(plan.sd * z), cy: Y(plan.expectedFound), r: 6, fill: C.primary, stroke: '#0c1217', 'stroke-width': 2 }, svg);
  txt(svg, X(plan.sd * z) + 12, Y(plan.expectedFound) + 18, 'This plan', { 'font-size': 11.5, fill: C.fg, 'font-weight': 600 });
  $('#frontier').replaceChildren(svg);

  // power of the review check against agent drift
  const qs = Q.slice().sort((a, c) => a - c);
  const top2 = qs[Math.floor(qs.length * 0.98)], med = qs[Math.floor(qs.length * 0.5)];
  const pNearU = reviewPower(Q, uni.pi, 3, (i) => Q[i] >= top2).power, pNearP = reviewPower(Q, plan.pi, 3, (i) => Q[i] >= top2).power;
  const pBulkU = reviewPower(Q, uni.pi, 3, (i) => Q[i] <= med).power, pBulkP = reviewPower(Q, plan.pi, 3, (i) => Q[i] <= med).power;
  const gain = plan.expectedFound / Math.max(uni.expectedFound, 1e-9);
  $('#planStats').innerHTML = `
    <div class="ps"><div class="ps-l">Missed threats surfaced per month</div><div class="ps-v"><span class="from">${uni.expectedFound.toFixed(1)}</span>${plan.expectedFound.toFixed(1)}<span class="gain">${gain.toFixed(1)}× more</span></div><div class="ps-s">Expected true positives found by ${fmt(B)} reviews / 30 days</div></div>
    <div class="ps"><div class="ps-l">Design-unbiased cross-check, 90%</div><div class="ps-v"><span class="from">±${(uni.sd * z).toFixed(0)}</span>±${(plan.sd * z).toFixed(0)}</div><div class="ps-s">Width of the review-based estimate that needs no calibration assumption</div></div>
    <div class="ps"><div class="ps-l">Catches 3× under-calling near the threshold</div><div class="ps-v"><span class="from">${pct(pNearU, 0)}</span>${pct(pNearP, 0)}</div><div class="ps-s">Power of the review check when the riskiest 2% of closures hide 3× more threats</div></div>
    <div class="ps"><div class="ps-l">Catches 3× under-calling in the confident half</div><div class="ps-v"><span class="from">${pct(pBulkU, 0)}</span>${pct(pBulkP, 0)}</div><div class="ps-s">At these base rates no review budget sees bulk drift; the recalibration has to carry it</div></div>`;
  renderQueue(plan, k);
}
function renderQueue(plan, k) {
  const A = T.alerts, lastDay = T.tenant.period.days - 1;
  const idxDay = []; CLOSED.forEach((i, j) => { if (A.day[i] === lastDay) idxDay.push(j); });
  const byRisk = idxDay.slice().sort((a, b) => Q[b] - Q[a]);
  const take = byRisk.slice(0, k);
  const rnd = mulberry32(4242);
  const sampled = byRisk.slice(k).filter((j) => rnd() < plan.pi[j]);
  const rows = [...take.map((j) => ({ j, kind: 'take' })), ...sampled.map((j) => ({ j, kind: 'sample' }))];
  $('#queueSub').textContent = `${rows.length} of ${fmt(idxDay.length)} closures from Nov 7 · ${take.length} by risk, ${sampled.length} sampled`;
  const show = rows.slice(0, 8);
  $('#queue').innerHTML = show.map(({ j, kind }) => {
    const i = CLOSED[j], r = AN.rules[A.rule[i]];
    return `<div class="q-row"><div class="q-top"><span class="q-id">ALR-${A.id[i]}</span><span class="q-rule">${esc(r.name)}</span></div><div class="q-meta">FP confidence ${A.conf[i].toFixed(4)} · ${r.tactic}</div><div class="q-right"><span class="q-p">${(Q[j] * 100).toFixed(Q[j] < 0.01 ? 2 : 1)}% threat</span>${kind === 'take' ? '<span class="badge b-high">Re-open</span>' : `<span class="badge b-neutral">Sampled · π ${plan.pi[j].toFixed(3)}</span>`}</div></div>`;
  }).join('') + (rows.length > show.length ? `<div class="q-more">+${rows.length - show.length} more in the queue</div>` : '');
}

// ---------- method + simulation ----------
function renderMethod() {
  const t = AN.totals;
  $('#methodList').innerHTML = [
    `<b>Recalibrate per rule on escalated alerts.</b> Every one of the ${fmt(t.escalated)} escalated alerts has an analyst verdict. For each rule, fit one logistic intercept shift <code>q = σ(logit(1 − FP confidence) + b)</code> (prior b ~ N(0, 2²)). <code>b &gt; 0</code> means the agent under-calls threats on that rule.`,
    `<b>Estimate what is inside the ${fmt(t.closed)} auto-closes.</b> Sum <code>q</code> over each rule's closed alerts. The 90% interval propagates the uncertainty in <code>b</code> (2,000 draws) and the Bernoulli noise of which alerts are real.`,
    `<b>Check the model on closure reviews.</b> Reviews are an independent random sample, so the number of threats they find is Poisson-binomial under the model. An exact upper-tail p-value flags rules where the agent is worse on closed alerts than on escalated ones.`,
    `<b>Cross-check without the calibration assumption.</b> The difference estimator <code>Σq + Σ (y − q)/π</code> over reviewed alerts is unbiased for any <code>q</code>; its interval shows what the reviews can certify on their own.`,
    `<b>Plan reviews by risk.</b> Re-open the K riskiest closures each day and Neyman-sample the rest (inclusion ∝ √(q(1 − q)), known π), which keeps every estimate on this page unbiased while surfacing far more real threats.`,
    `<b>Threshold what-if.</b> For each candidate auto-close threshold, compute the rule's missed-threat rate across the 2,000 draws. Scanning from strict to lenient, recommend the most automation whose 95th-percentile miss rate meets the target; auto-close stays off where policy disables it.`,
  ].map((s) => `<li>${s}</li>`).join('');
}
function renderSim() {
  const [w, d] = SIM.scenarios;
  $('#simSub').textContent = `${w.reps} regenerated tenants per scenario · ${fmt(SIM.budget)} reviews / month · committed in scripts/simcheck.mjs`;
  const row = (l, a, b) => `<tr><td>${l}</td><td class="num">${a}</td><td class="num">${b}</td></tr>`;
  $('#sim').innerHTML = `<table class="sim-tbl"><thead><tr><th></th><th class="num">Calibrated agent</th><th class="num">Drift above 0.9995</th></tr></thead><tbody>
    ${row('90% interval covers true missed count (tenant)', pct(w.modelCoverageTotal, 0), pct(d.modelCoverageTotal, 0))}
    ${row('90% interval covers true count (per rule)', pct(w.modelCoveragePerRule, 0), pct(d.modelCoveragePerRule, 0))}
    ${row('Mean interval width, recalibrated vs review-only bound', `${w.meanWidthModel.toFixed(0)} vs ${w.meanClassicUpper.toFixed(0)}`, `${d.meanWidthModel.toFixed(0)} vs ${d.meanClassicUpper.toFixed(0)}`)}
    ${row('Cross-check coverage (random / risk plan)', `${pct(w.ppiCoverageUniform, 0)} / ${pct(w.ppiCoverageTargeted, 0)}`, `${pct(d.ppiCoverageUniform, 0)} / ${pct(d.ppiCoverageTargeted, 0)}`)}
    ${row('Threats surfaced per month (random / risk plan)', `${w.foundPerMonthUniform.toFixed(1)} / ${w.foundPerMonthTargeted.toFixed(1)}`, `${d.foundPerMonthUniform.toFixed(1)} / ${d.foundPerMonthTargeted.toFixed(1)}`)}
    ${row('Review check flags the drift (random / risk plan)', `${pct(w.checkPowerUniform, 0)} / ${pct(w.checkPowerTargeted, 0)}`, `${pct(d.checkPowerUniform, 0)} / ${pct(d.checkPowerTargeted, 0)}`)}
  </tbody></table>
  <p class="sim-note">When the agent's calibration on closed alerts matches the escalated range, the interval holds its 90% coverage and is several times tighter than anything reviews alone can certify. When the agent is 5× worse on closures above 0.9995 FP confidence than on the escalated range, the model under-counts and reviews at this budget rarely catch it: the honest limit of sampling at a ${pct(w.foundPerMonthUniform / SIM.budget, 2)} hit rate, and the reason the page reports its check power.</p>`;
}

// ---------- threshold sheet ----------
function openSheet(r) {
  $('#sheetTitle').textContent = r.name;
  const th = r.threshold;
  const body = $('#sheetBody');
  if (!th.rows.length || r.tau > 1) {
    body.innerHTML = `<div class="facts"><div class="fact"><div class="f-l">Alerts / 30 days</div><div class="f-v">${fmt(r.total)}</div></div><div class="fact"><div class="f-l">Confirmed threats</div><div class="f-v">${fmt(r.escTP)}</div></div><div class="fact"><div class="f-l">Auto-close</div><div class="f-v">Off</div></div></div><p class="sheet-note">Auto-close is disabled by policy for this rule, so every alert is escalated to an analyst. Closure Assurance never recommends enabling it.</p>`;
  } else {
    const cur = th.current, rec = th.recommended;
    const lines = { insufficient: 'No threshold on the scanned grid meets the target with 95% confidence, so this rule should escalate more until more verdicts arrive.', tighten: `Raising the threshold to ${rec && rec.t} adds about ${rec && rec.deltaEscalations} escalations a month (${rec && ((rec.deltaEscalations * r.minutes) / 60).toFixed(1)} analyst hours) and brings the 95th-percentile miss rate under ${pct(AN.alpha, 0)}.`, loosen: `Lowering the threshold to ${rec && rec.t} removes about ${rec && -rec.deltaEscalations} escalations a month (${rec && ((-rec.deltaEscalations * r.minutes) / 60).toFixed(1)} analyst hours) while the 95th-percentile miss rate stays under ${pct(AN.alpha, 0)}.`, keep: `The current threshold meets the target; no change saves at least 10 escalations a month.` };
    body.innerHTML = `<div class="facts"><div class="fact"><div class="f-l">Auto-closed · escalated</div><div class="f-v">${fmt(r.closed)} · ${fmt(r.escalated)}</div></div><div class="fact"><div class="f-l">Threats in closed (90%)</div><div class="f-v">${r.missed.point.toFixed(1)} <span class="ci">${r.missed.lo.toFixed(1)}–${r.missed.hi.toFixed(1)}</span></div></div><div class="fact"><div class="f-l">Threat odds vs agent</div><div class="f-v">×${r.oddsRatio.toFixed(2)} <span class="ci">±${(r.fit.se).toFixed(2)} logit</span></div></div></div>
      <div id="thrChart" class="chart"></div>
      <p class="sheet-note">${lines[th.action] || ''} Miss rates here carry the uncertainty in the rule's calibration (500 draws); expected counts exclude which individual alerts turn out to be real.</p>
      <table class="tbl small"><thead><tr><th>Threshold</th><th class="num">Escalations / mo</th><th class="num">Expected missed</th><th class="num">Miss rate, median</th><th class="num">Miss rate, p95</th></tr></thead><tbody>
      ${th.rows.map((x) => `<tr class="${x === cur ? 'cur' : ''} ${rec && x === rec && x !== cur ? 'rec' : ''}"><td class="mono">${x.t}${x === cur ? ' <span class="dim">current</span>' : ''}${rec && x === rec && x !== cur ? ' <span style="color:var(--green-t)">recommended</span>' : ''}</td><td class="num mono">${fmt(x.escalations)}</td><td class="num mono">${x.missedMed.toFixed(1)}</td><td class="num mono">${pct(x.fnrMed)}</td><td class="num mono">${pct(x.fnr95)}</td></tr>`).join('')}
      </tbody></table>`;
    drawThreshold(r);
  }
  $('#sheet').classList.add('open'); $('#scrim').classList.add('open'); $('#sheet').setAttribute('aria-hidden', 'false');
  history.replaceState(null, '', '#rule=' + r.id);
  lucide.createIcons();
}
function closeSheet() { $('#sheet').classList.remove('open'); $('#scrim').classList.remove('open'); $('#sheet').setAttribute('aria-hidden', 'true'); history.replaceState(null, '', location.pathname); }
function drawThreshold(r) {
  const rows = r.threshold.rows, W = 520, H = 220, l = 44, rt = 44, t = 12, b = 34;
  const n = rows.length, X = (j) => l + (W - l - rt) * j / (n - 1);
  const ymax = niceMax(Math.max(AN.alpha * 1.6, ...rows.map((x) => x.fnr95)) * 1.05), Y = (v) => H - b - (H - b - t) * v / ymax;
  const emax = niceMax(Math.max(...rows.map((x) => x.escalations))), E = (v) => H - b - (H - b - t) * v / emax;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%' });
  for (let i = 0; i <= 4; i++) { const v = ymax * i / 4; el('line', { x1: l, x2: W - rt, y1: Y(v), y2: Y(v), stroke: i ? C.grid : C.axis }, svg); txt(svg, l - 6, Y(v) + 4, pct(v, 0), { 'text-anchor': 'end', 'font-size': 10.5, fill: C.muted2 }); txt(svg, W - rt + 6, E(emax * i / 4) + 4, fmt(emax * i / 4), { 'font-size': 10.5, fill: C.muted2 }); }
  rows.forEach((x, j) => { const bw = Math.max(4, (W - l - rt) / n * 0.55); el('rect', { x: X(j) - bw / 2, y: E(x.escalations), width: bw, height: H - b - E(x.escalations), fill: '#2a3139', rx: 2 }, svg); if (j % 2 === 0 || j === n - 1) txt(svg, X(j), H - b + 14, String(x.t), { 'text-anchor': 'middle', 'font-size': 10, fill: C.muted2 }); });
  txt(svg, (l + W - rt) / 2, H - 3, 'auto-close threshold on agent FP confidence', { 'text-anchor': 'middle', 'font-size': 10.5, fill: C.muted2 });
  el('line', { x1: l, x2: W - rt, y1: Y(AN.alpha), y2: Y(AN.alpha), stroke: C.green, 'stroke-dasharray': '4 4' }, svg);
  txt(svg, W - rt - 4, Y(AN.alpha) - 5, `target ${pct(AN.alpha, 0)}`, { 'text-anchor': 'end', 'font-size': 10.5, fill: '#6bbd7c' });
  el('path', { d: rows.map((x, j) => `${j ? 'L' : 'M'}${X(j)},${Y(x.fnrMed)}`).join(''), fill: 'none', stroke: C.muted, 'stroke-width': 1.25, 'stroke-dasharray': '3 3' }, svg);
  el('path', { d: rows.map((x, j) => `${j ? 'L' : 'M'}${X(j)},${Y(x.fnr95)}`).join(''), fill: 'none', stroke: C.primary, 'stroke-width': 2 }, svg);
  const cur = rows.indexOf(r.threshold.current), rec = rows.indexOf(r.threshold.recommended);
  if (cur >= 0) { el('circle', { cx: X(cur), cy: Y(rows[cur].fnr95), r: 5, fill: '#0c1217', stroke: C.fg, 'stroke-width': 2 }, svg); }
  if (rec >= 0 && rec !== cur) el('circle', { cx: X(rec), cy: Y(rows[rec].fnr95), r: 5, fill: C.green }, svg);
  const lg = el('g', {}, svg);
  el('line', { x1: l + 4, x2: l + 20, y1: t + 6, y2: t + 6, stroke: C.primary, 'stroke-width': 2 }, lg); txt(lg, l + 24, t + 10, 'miss rate, p95', { 'font-size': 10.5, fill: C.muted });
  el('line', { x1: l + 110, x2: l + 126, y1: t + 6, y2: t + 6, stroke: C.muted, 'stroke-dasharray': '3 3' }, lg); txt(lg, l + 130, t + 10, 'median', { 'font-size': 10.5, fill: C.muted });
  el('rect', { x: l + 180, y: t + 1, width: 10, height: 10, fill: '#2a3139', rx: 2 }, lg); txt(lg, l + 195, t + 10, 'escalations / mo', { 'font-size': 10.5, fill: C.muted });
  $('#thrChart').replaceChildren(svg);
}

function exportCsv() {
  const head = ['rule_id', 'rule', 'tactic', 'auto_closed', 'escalated', 'confirmed_threats', 'calibration_shift', 'shift_se', 'est_missed', 'missed_lo90', 'missed_hi90', 'recall', 'review_n', 'review_found', 'review_expected', 'review_p', 'threshold', 'recommended', 'action'];
  const lines = [head.join(',')].concat(AN.rules.map((r) => [r.id, `"${r.name}"`, r.tactic, r.closed, r.escalated, r.escTP, r.fit.b.toFixed(3), r.fit.se.toFixed(3), r.missed.point.toFixed(2), r.missed.lo.toFixed(2), r.missed.hi.toFixed(2), r.recall.point.toFixed(4), r.check.reviewed, r.check.observed, r.check.expected.toFixed(3), r.check.pUpper.toFixed(3), r.tau, r.threshold.recommended ? r.threshold.recommended.t : '', r.threshold.action].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'closure-assurance-halvorsen-freight.csv'; a.click();
}

main().catch((e) => { console.error(e); $('#loading').textContent = 'Failed to load data: ' + e.message; });

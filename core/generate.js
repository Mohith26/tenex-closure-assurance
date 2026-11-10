// Seeded synthetic tenant generator (shared by scripts/generate.mjs, the
// simulation check and the unit tests). Nothing here is read by the estimator
// except the observable columns written to `alerts`.
import { mulberry32 } from './assurance.js';

export const SEED = 20261107;

// id, rule name, ATT&CK tactic, alerts / 30 days, benign-mode logit mean of the
// agent's FP confidence, share of alerts in the suspicious mode, calibration
// shift beta (true threat odds = agent-implied odds x e^beta), auto-close
// threshold on FP confidence (1.01 = auto-close disabled), analyst minutes per
// escalated case.
export const DEFAULT_RULES = [
  ['okta_mfa_push_fatigue', 'Okta: MFA push fatigue (5+ denied pushes / 10 min)', 'Credential Access', 1900, 8.2, 0.030, 1.20, 0.95, 14],
  ['entra_impossible_travel', 'Entra ID: Impossible travel sign-in', 'Initial Access', 5200, 8.9, 0.020, 0.10, 0.95, 11],
  ['entra_anon_proxy', 'Entra ID: Sign-in from anonymizing proxy', 'Initial Access', 2400, 8.7, 0.025, 0.00, 0.95, 12],
  ['m365_inbox_fwd_external', 'M365: Inbox rule forwards to external domain', 'Collection', 640, 8.0, 0.040, 0.90, 0.97, 18],
  ['m365_user_reported_phish', 'M365: User-reported phishing', 'Initial Access', 6100, 8.6, 0.030, 0.05, 0.93, 9],
  ['ps_encoded_command', 'Defender: Encoded PowerShell spawned by Office app', 'Execution', 1500, 8.8, 0.030, 0.00, 0.97, 16],
  ['lsass_access', 'CrowdStrike: Suspicious LSASS memory access', 'Credential Access', 420, 8.6, 0.050, 0.00, 0.99, 22],
  ['new_service_nonadmin', 'Windows: Service installed by non-admin account', 'Persistence', 1100, 9.0, 0.020, 0.10, 0.95, 13],
  ['gcp_sa_key_created', 'GCP: User-managed service account key created', 'Persistence', 900, 8.9, 0.020, 0.00, 0.95, 10],
  ['aws_console_no_mfa', 'AWS: Console login without MFA', 'Initial Access', 1300, 9.2, 0.015, 0.00, 0.95, 9],
  ['beacon_nrd', 'Network: Periodic beaconing to newly registered domain', 'Command and Control', 2600, 8.3, 0.025, 0.85, 0.95, 17],
  ['dns_high_entropy', 'DNS: High-entropy subdomain queries', 'Exfiltration', 3800, 9.0, 0.015, 0.00, 0.93, 12],
  ['proxy_exe_filesharing', 'Proxy: Executable downloaded from file-sharing site', 'Execution', 4400, 9.1, 0.015, 0.05, 0.93, 8],
  ['schtasks_created', 'Windows: Scheduled task created via schtasks.exe', 'Persistence', 3900, 9.4, 0.010, 0.00, 0.93, 8],
  ['okta_admin_role', 'Okta: Super admin role assigned', 'Privilege Escalation', 85, 7.0, 0.080, 0.00, 1.01, 20],
  ['unsigned_temp_binary', 'EDR: Unsigned binary executed from user temp', 'Execution', 2900, 8.9, 0.020, 0.15, 0.95, 12],
  ['vpn_concurrent_geo', 'VPN: Concurrent sessions from two countries', 'Initial Access', 1700, 8.8, 0.020, 0.00, 0.95, 10],
  ['saas_mass_download', 'Workspace: Mass file download by one user', 'Exfiltration', 1250, 8.5, 0.030, 0.60, 0.95, 15],
];

export function generateTenant(seed = SEED, opts = {}) {
  const rnd = mulberry32(seed);
  const randn = () => { let u = 0, v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const sigmoid = (z) => 1 / (1 + Math.exp(-z));
  const logit = (p) => Math.log(p / (1 - p));
  const RULES = opts.rules || DEFAULT_RULES;
  // optional misspecification: beta may depend on the agent confidence
  const betaFn = opts.betaFn || ((beta) => beta);
  const DAYS = 30;
  const UNIFORM_PI = opts.uniformPi ?? 0.03;
  const rules = [];
  const A = { rule: [], conf: [], esc: [], rev: [], pi: [], y: [], id: [], day: [] };
  const truthY = [];
  let seq = 0;
  RULES.forEach(([id, name, tactic, n, mu, susp, beta, tau, minutes], k) => {
    rules.push({ id, name, tactic, tau, minutes });
    for (let j = 0; j < n; j++) {
      const L = rnd() < susp ? 1.0 + 1.6 * randn() : mu + (opts.muShift ?? 0.4) + 1.15 * randn();
      const c = Math.min(0.999995, Math.max(0.0001, sigmoid(L)));
      const cr = Math.round(c * 1e6) / 1e6;
      const qTrue = sigmoid(logit(Math.max(1e-7, 1 - cr)) + betaFn(beta, cr));
      const y = rnd() < qTrue ? 1 : 0;
      const esc = cr < tau ? 1 : 0;
      const rev = !esc && rnd() < UNIFORM_PI ? 1 : 0;
      A.rule.push(k); A.conf.push(cr); A.esc.push(esc); A.rev.push(rev);
      A.pi.push(esc ? 1 : UNIFORM_PI);
      A.y.push(esc || rev ? y : -1);
      A.day.push(Math.floor(rnd() * DAYS));
      A.id.push(((seq * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(-6).toUpperCase());
      truthY.push(y);
      seq++;
    }
  });
  const tenant = {
    tenant: { name: 'Halvorsen Freight', fictional: true, siem: 'Google SecOps', period: { start: '2026-10-09', end: '2026-11-07', days: DAYS } },
    design: { kind: 'poisson', uniformPi: UNIFORM_PI },
    rules, alerts: A,
  };
  const truth = { seed, betas: Object.fromEntries(RULES.map((r) => [r[0], r[6]])), y: truthY };
  return { tenant, truth };
}

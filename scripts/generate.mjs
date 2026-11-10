// node scripts/generate.mjs -> data/tenant.json (what the product sees) + data/truth.json (simulation only)
import { writeFileSync, mkdirSync } from 'node:fs';
import { generateTenant, SEED } from '../core/generate.js';
const { tenant, truth } = generateTenant(SEED);
mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../data/tenant.json', import.meta.url), JSON.stringify(tenant));
writeFileSync(new URL('../data/truth.json', import.meta.url), JSON.stringify(truth));
const A = tenant.alerts;
let missed = 0, escTP = 0, esc = 0, rev = 0, found = 0;
truth.y.forEach((y, i) => { if (A.esc[i]) { esc++; escTP += y; } else { missed += y; if (A.rev[i]) { rev++; found += y; } } });
console.log({ alerts: A.rule.length, escalated: esc, escTP, closed: A.rule.length - esc, reviewed: rev, foundInReview: found, trueMissed: missed });

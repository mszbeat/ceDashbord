'use strict';

const path = require('node:path');
const fs = require('node:fs');

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(`--${name}`);
const argValue = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};

const BASE_URL = 'http://samad.partdp.ir';
const USER = 'mohammadsadeghZarei';
const PASS = 'mohammadsadeghZarei';
const ORG = 'mohammadsadeghZarei';
const DRY_RUN = hasFlag('dry-run');
const PRINT_CURL = hasFlag('print-curl');
const PARAM_STYLE = process.env.PARAM_STYLE || 'colon'; // colon | brace | star
const ENDPOINT = `${BASE_URL}/service/samad@8/accesses`;

/* ───────────────────────── ۱) استخراج روت‌ها از routes.js ───────────────────────── */
function extractRoutes() {
  const explicit = argValue('routes');
  const candidates = explicit
    ? [explicit]
    : [path.join(__dirname, '..', 'pd2', 'routes.js'), path.join(process.cwd(), 'routes.js')];
  const routesFile = candidates.find((p) => fs.existsSync(p));
  if (!routesFile) throw new Error('routes.js پیدا نشد؛ با --routes=<path> مشخص کنید.');

  const recorded = [];
  let current = null;
  const chain = {
    method(verb) { current.operation = String(verb).toUpperCase(); return chain; },
    validate() { return chain; },
    checkAccess(flag) { current.checkAccess = flag !== false; return chain; },
  };
  const router = {
    setRoute(resource, target) {
      current = { resource: String(resource), target: String(target), operation: null, checkAccess: false };
      recorded.push(current);
      return chain;
    },
  };

  require(path.resolve(routesFile))(router);

  return recorded.map((r) => {
    if (!r.operation) throw new Error(`روت ${r.resource} متد ندارد`);
    return {
      resource: normalizeParamStyle(r.resource),
      operation: r.operation,
      handler: r.target,
      checkAccess: r.checkAccess,
    };
  });
}

function normalizeParamStyle(resource) {
  if (PARAM_STYLE === 'brace') return resource.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
  if (PARAM_STYLE === 'star') return resource.replace(/:([A-Za-z0-9_]+)/g, '*');
  return resource; // colon
}

/* ───────────────────────── ۲) سیاست دسترسی هر نقش ───────────────────────── */
// هر نقش = فهرست patterns؛ نقش‌های بالاتر با extend از نقش پایین‌تر ارث می‌برند.
const PUBLIC = ['POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/logout', 'GET /api/auth/me', 'GET /api/health'];
const READER = [
  'GET /api/banks', 'GET /api/specs', 'GET /api/report', 'GET /api/diagnostics',
  'GET /api/summary', 'GET /api/list', 'GET /api/runs',
];
const ADMIN_OPS = [
  'POST /api/auth/role', 'GET /api/auth/role', 'POST /api/auth/remove',
  'GET /api/admin/overview', 'GET /api/admin/cron', 'PUT /api/admin/cron',
  'POST /api/admin/cron/run-now', 'POST /api/admin/runs/check', 'POST /api/admin/runs/start',
  'GET /api/admin/jobs', 'GET /api/admin/jobs/:id', 'POST /api/admin/runs', 'POST /api/runs',
];

const ROLE_POLICY = {
  visitor: [...PUBLIC, ...READER],
  creditEvaluation: [...PUBLIC, ...READER, 'GET /api/sample/:requestId'],
  admin: [...PUBLIC, ...READER, 'GET /api/sample/:requestId', ...ADMIN_OPS],
};

/* ───────────────────────── ۳) ساخت accesses برای هر نقش ───────────────────────── */
function buildAccesses(routes, patterns) {
  const wanted = new Set(patterns.map((p) => p.replace(/\s+/g, ' ').trim()));
  const picked = routes.filter((r) => wanted.has(`${r.operation} ${r.resource}`));

  const missing = [...wanted].filter((p) => !picked.some((r) => `${r.operation} ${r.resource}` === p));
  if (missing.length) {
    console.warn(`⚠️  این الگوها در routes.js پیدا نشدند: ${missing.join(' , ')}`);
  }
  return picked.map((r) => ({ resource: r.resource, operation: r.operation, situation: '' }));
}

/* ───────────────────────── ۴) ارسال به سمد ───────────────────────── */
async function assignRole(roleName, accesses) {
  const payload = { org: ORG, roleName, accesses };
  const body = JSON.stringify(payload);

  if (PRINT_CURL) {
    console.log(
      `curl --location --request PUT '${ENDPOINT}' \\\n` +
      `  --header 'user: ${USER ?? '<SAMAD_USER>'}' \\\n` +
      `  --header 'pass: ${PASS ?? '<SAMAD_PASS>'}' \\\n` +
      `  --header 'Content-Type: application/json' \\\n` +
      `  --data '${body}'\n`,
    );
  }

  if (DRY_RUN) {
    console.log(`[dry-run] ${roleName}: ${accesses.length} access → ${ENDPOINT}`);
    return { ok: true, dryRun: true };
  }

  const res = await fetch(ENDPOINT, {
    method: 'PUT',
    headers: { user: USER, pass: PASS, 'Content-Type': 'application/json' },
    body,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw new Error(`سمد برای نقش ${roleName} خطا داد: HTTP ${res.status} → ${text.slice(0, 500)}`);
  }
  console.log(`✅ ${roleName}: ${accesses.length} روت تخصیص یافت (HTTP ${res.status})`);
  return data;
}

/* ───────────────────────── ۵) main ───────────────────────── */
(async () => {
  if (!DRY_RUN && (!BASE_URL || !USER || !PASS || !ORG)) {
    console.error('❌ SAMAD_BASE_URL / SAMAD_USER / SAMAD_PASS / SAMAD_ORG را تنظیم کنید (یا --dry-run بزنید).');
    process.exit(1);
  }

  const routes = extractRoutes();
  console.log(`ℹ️  ${routes.length} روت از routes.js استخراج شد.`);

  const only = (argValue('roles') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const roles = only.length ? only : Object.keys(ROLE_POLICY);

  for (const roleName of roles) {
    const patterns = ROLE_POLICY[roleName];
    if (!patterns) {
      console.warn(`⚠️  سیاستی برای نقش «${roleName}» تعریف نشده؛ رد شد.`);
      continue;
    }
    const accesses = buildAccesses(routes, patterns);
    await assignRole(roleName, accesses);
  }
})().catch((err) => {
  console.error('❌', err.message || err);
  process.exit(1);
});
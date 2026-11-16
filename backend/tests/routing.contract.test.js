'use strict';

/**
 * قرارداد معماری pd2 (بدون نیاز به نصب پکیج‌های پارت):
 *  - routes.js مرکزی، ۲۶ روت با متدهای صحیح و checkAccess در جای مناسب
 *  - کنترلرها بدون دکوراتور + introduceToLoader
 *  - config.js هر کنترلر: name / path / exception.handler / handlers(params) / error
 *  - تطابق دقیق routes ↔ handlers ↔ main.js ↔ schema.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const EXPECTED_ROUTES = [
  // auth
  { verb: 'POST', url: '/api/auth/register', target: 'auth-controller.register', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/auth/login', target: 'auth-controller.login', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/auth/refresh', target: 'auth-controller.refresh', validate: false, checkAccess: true },
  { verb: 'POST', url: '/api/auth/logout', target: 'auth-controller.logout', validate: false, checkAccess: true },
  { verb: 'GET', url: '/api/auth/me', target: 'auth-controller.me', validate: false, checkAccess: true },
  { verb: 'POST', url: '/api/auth/role', target: 'auth-controller.assignRole', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/auth/role', target: 'auth-controller.getRole', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/auth/remove', target: 'auth-controller.removeUser', validate: true, checkAccess: true },
  // summary (سطح ۱)
  { verb: 'GET', url: '/api/health', target: 'summary-controller.health', validate: false, checkAccess: false },
  { verb: 'GET', url: '/api/banks', target: 'summary-controller.banks', validate: false, checkAccess: true },
  { verb: 'GET', url: '/api/specs', target: 'summary-controller.specs', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/report', target: 'summary-controller.report', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/diagnostics', target: 'summary-controller.diagnostics', validate: false, checkAccess: true },
  { verb: 'GET', url: '/api/summary', target: 'summary-controller.summary', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/list', target: 'summary-controller.list', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/runs', target: 'summary-controller.runs', validate: false, checkAccess: true },
  // detail (سطح ۲)
  { verb: 'GET', url: '/api/sample/:requestId', target: 'credit-evaluation-controller.sample', validate: false, checkAccess: true },
  // admin (سطح ۳)
  { verb: 'GET', url: '/api/admin/overview', target: 'admin-controller.getOverview', validate: false, checkAccess: true },
  { verb: 'GET', url: '/api/admin/cron', target: 'admin-controller.getCron', validate: false, checkAccess: true },
  { verb: 'PUT', url: '/api/admin/cron', target: 'admin-controller.updateCron', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/admin/cron/run-now', target: 'admin-controller.runCronNow', validate: false, checkAccess: true },
  { verb: 'POST', url: '/api/admin/runs/check', target: 'admin-controller.checkExisting', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/admin/runs/start', target: 'admin-controller.startRun', validate: true, checkAccess: true },
  { verb: 'GET', url: '/api/admin/jobs', target: 'admin-controller.listJobs', validate: false, checkAccess: true },
  { verb: 'GET', url: '/api/admin/jobs/:id', target: 'admin-controller.getJob', validate: false, checkAccess: true },
  { verb: 'POST', url: '/api/admin/runs', target: 'admin-controller.runAdminDay', validate: true, checkAccess: true },
  { verb: 'POST', url: '/api/runs', target: 'admin-controller.run', validate: true, checkAccess: true },
];

const CONTROLLER_DIRS = {
  'auth-controller': 'auth',
  'summary-controller': 'summaryController',
  'credit-evaluation-controller': 'creditEvaluationController',
  'admin-controller': 'adminController',
};

/** ثبت روت‌ها را با یک روتر جعلی شبیه‌سازی می‌کند. */
function recordRoutes() {
  const recorded = [];
  let current = null;

  const chain = {
    method(verb) {
      current.verb = String(verb).toUpperCase();
      return chain;
    },
    validate() {
      current.validate = true;
      return chain;
    },
    checkAccess(flag) {
      current.checkAccess = flag !== false;
      return chain;
    },
  };

  const router = {
    setRoute(url, target) {
      current = { url: String(url), target: String(target), verb: null, validate: false, checkAccess: false };
      recorded.push(current);
      return chain;
    },
  };

  require(path.join(ROOT, 'routes.js'))(router);
  return recorded;
}

test('pd2 routes.js registers every expected route with the right verb/validate/checkAccess flags', () => {
  const recorded = recordRoutes();

  assert.equal(recorded.length, 27, 'pd2 must expose all 27 API routes');
  assert.deepEqual(
    recorded.map(({ verb, url, target, validate, checkAccess }) => ({ verb, url, target, validate, checkAccess })),
    EXPECTED_ROUTES,
  );

  for (const route of recorded) {
    assert.notEqual(route.verb, null, `route ${route.url} is missing .method()`);
    assert.equal(route.verb, route.verb.toUpperCase(), `route ${route.url} verb must be uppercase`);
  }
});

test('every route targets an existing controller handler whose params carry _session only when checkAccess is on', () => {
  const recorded = recordRoutes();

  for (const route of recorded) {
    const [controllerName, handlerName] = route.target.split('.');
    const dir = CONTROLLER_DIRS[controllerName];
    assert.ok(dir, `unknown controller in route target: ${route.target}`);

    const config = require(path.join(ROOT, 'controllers', dir, 'config.js'));
    assert.equal(config.name, controllerName, `${dir}/config.js name mismatch`);

    const handler = config.handlers[handlerName];
    assert.ok(handler, `missing handler config for ${route.target}`);
    assert.equal(handler.needProtocolRef, false, `${route.target} must use needProtocolRef: false`);

    const usesSession = handler.params.includes('_session');
    if (usesSession) {
      assert.equal(
        route.checkAccess,
        true,
        `${route.target} receives _session, so routes.js MUST enable checkAccess(true)`,
      );
    }
    if (route.checkAccess === true) {
      assert.equal(
        typeof handler.params.find((p) => p === '_session') !== 'undefined' || !usesSession,
        true,
        'checkAccess routes inject _session only when listed in params',
      );
    }

    const mainSource = fs.readFileSync(path.join(ROOT, 'controllers', dir, 'main.js'), 'utf8');
    assert.match(
      mainSource,
      new RegExp(`\\n\\s+(async\\s+)?${handlerName}\\(`),
      `${dir}/main.js must define handler ${handlerName}`,
    );
    assert.equal(
      /@Route|@HTTP/.test(mainSource),
      false,
      `${dir}/main.js must not use decorators in the 10.2.0 central-router architecture`,
    );
    assert.match(
      mainSource,
      /BaseController\.exportedProperties\(\s*require\('\.\/schema'\),\s*require\('\.\/config'\)\s*,?\s*\)/s,
      `${dir}/main.js must export introduceToLoader via BaseController.exportedProperties`,
    );

    const schema = require(path.join(ROOT, 'controllers', dir, 'schema.js'));
    assert.ok(schema[handlerName] !== undefined, `missing schema for ${route.target}`);
  }
});

test('project-config enables central router + accessControl (partFramework 10.2.0)', () => {
  const routerConf = require(path.join(ROOT, 'project-config', 'dev', 'routerConf.js'));
  assert.equal(path.resolve(routerConf.routerPath), path.join(ROOT, 'routes.js'));
  assert.ok(routerConf.accessControl, 'accessControl must be enabled in routerConf.js');
  assert.ok(routerConf.accessControl.partSessionManagerConfig, 'partSessionManagerConfig is required');
  assert.ok(routerConf.accessControl.partSecurityConfig, 'partSecurityConfig is required');
  assert.equal(typeof routerConf.accessControl.config, 'object');
  assert.equal(typeof routerConf.accessControl.config.org, 'string');
});

test('every controller config ships an exception.handler that maps to a part-standard error object', () => {
  for (const [controllerName, dir] of Object.entries(CONTROLLER_DIRS)) {
    const config = require(path.join(ROOT, 'controllers', dir, 'config.js'));
    assert.equal(config.path, './main.js');
    assert.equal(typeof config.exception?.handler, 'function', `${dir} must define exception.handler`);

    const mapped = config.exception.handler({ statusCode: 418, meta: { code: 'teapot' }, data: { message: { fa: 'x', en: 'x' } } });
    assert.equal(mapped.statusCode, 418);
    assert.equal(mapped.meta.code, 'teapot');

    const fallback = config.exception.handler(new Error('boom'));
    assert.equal(fallback.statusCode, 500);
    assert.equal(typeof fallback.data.message.fa, 'string');

    for (const [key, def] of Object.entries(config.error)) {
      const resolved = typeof def === 'function' ? def({ sample: true }) : def;
      assert.equal(typeof resolved.statusCode, 'number', `${dir}.error.${key} statusCode`);
      assert.equal(typeof resolved.meta.code, 'string', `${dir}.error.${key} meta.code`);
      assert.equal(resolved.meta.sourceName, controllerName, `${dir}.error.${key} meta.sourceName`);
      assert.equal(typeof resolved.data.message.fa, 'string', `${dir}.error.${key} fa message`);
      assert.equal(typeof resolved.data.message.en, 'string', `${dir}.error.${key} en message`);
    }
  }
});

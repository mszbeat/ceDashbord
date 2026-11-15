'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const VALID_PARAM_TOKENS = new Set([
  '_protocolRef.request.queryString',
  '_protocolRef.request.data',
  '_protocolRef.request',
  '_protocolRef.response',
  '_inputData',
  '_session',
  '_trackingHeaders',
]);

const EXPECTED_CONTROLLERS = [
  {
    dir: 'summaryController',
    configFile: 'summaryController.config.js',
    packageName: 'summary-controller',
    routes: [
      { method: 'GET', route: '/api/health', handler: 'health', params: [] },
      { method: 'GET', route: '/api/banks', handler: 'banks', params: ['_protocolRef.response'] },
      {
        method: 'GET',
        route: '/api/specs',
        handler: 'specs',
        params: ['_protocolRef.request.queryString', '_protocolRef.response'],
      },
      {
        method: 'GET',
        route: '/api/report',
        handler: 'report',
        params: ['_protocolRef.request.queryString', '_protocolRef.response'],
      },
      { method: 'GET', route: '/api/diagnostics', handler: 'diagnostics', params: ['_protocolRef.response'] },
      {
        method: 'GET',
        route: '/api/summary',
        handler: 'summary',
        params: ['_protocolRef.request.queryString', '_protocolRef.response'],
      },
      {
        method: 'GET',
        route: '/api/list',
        handler: 'list',
        params: ['_protocolRef.request.queryString', '_protocolRef.response'],
      },
      { method: 'GET', route: '/api/runs', handler: 'runs', params: ['_protocolRef.response'] },
    ],
  },
  {
    dir: 'creditEvaluationController',
    configFile: 'creditEvaluationController.config.js',
    packageName: 'credit-evaluation-controller',
    routes: [
      {
        method: 'GET',
        route: '/api/sample/:requestId',
        handler: 'sample',
        params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
      },
    ],
  },
  {
    dir: 'adminController',
    configFile: 'adminController.config.js',
    packageName: 'admin-controller',
    routes: [
      { method: 'GET', route: '/api/admin/overview', handler: 'getOverview', params: ['_protocolRef.response'] },
      { method: 'GET', route: '/api/admin/cron', handler: 'getCron', params: ['_protocolRef.response'] },
      {
        method: 'PUT',
        route: '/api/admin/cron',
        handler: 'updateCron',
        params: ['_protocolRef.request.data', '_protocolRef.response'],
      },
      { method: 'POST', route: '/api/admin/cron/run-now', handler: 'runCronNow', params: ['_protocolRef.response'] },
      {
        method: 'POST',
        route: '/api/admin/runs/check',
        handler: 'checkExisting',
        params: ['_protocolRef.request.data', '_protocolRef.response'],
      },
      {
        method: 'POST',
        route: '/api/admin/runs/start',
        handler: 'startRun',
        params: ['_protocolRef.request.data', '_protocolRef.response'],
      },
      { method: 'GET', route: '/api/admin/jobs', handler: 'listJobs', params: ['_protocolRef.response'] },
      {
        method: 'GET',
        route: '/api/admin/jobs/:id',
        handler: 'getJob',
        params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
      },
      {
        method: 'POST',
        route: '/api/admin/runs',
        handler: 'runAdminDay',
        params: ['_protocolRef.request.data', '_protocolRef.response'],
      },
      {
        method: 'POST',
        route: '/api/runs',
        handler: 'run',
        params: ['_protocolRef.request.data', '_protocolRef.response'],
      },
    ],
  },
];

function parseDecoratedRoutes(mainSource) {
  const regex = /@Route\('([^']+)'\)\s*@HTTP\('([^']+)'\)\s*([A-Za-z0-9_]+)\s*\(([^)]*)\)/g;
  const found = [];
  let match;
  while ((match = regex.exec(mainSource)) !== null) {
    const argList = match[4].trim()
      ? match[4].split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    found.push({ route: match[1], method: match[2], handler: match[3], argCount: argList.length });
  }
  return found;
}

test('all 3 access-separated controller-packages use needProtocolRef: false and ordered params matching method signatures', () => {
  assert.equal(
    fs.existsSync(path.join(ROOT, 'controllers', 'ingestionController')),
    false,
    'Old ingestionController must remain merged into adminController',
  );
  assert.equal(
    fs.existsSync(path.join(ROOT, 'services', 'auth')),
    false,
    'Custom JS role guard must be removed so Samad handles route guards cleanly',
  );

  let totalRoutes = 0;

  for (const spec of EXPECTED_CONTROLLERS) {
    const ctrlDir = path.join(ROOT, 'controllers', spec.dir);
    const extConfigPath = path.join(ROOT, 'configs', spec.configFile);
    assert.equal(fs.existsSync(ctrlDir), true, `Missing controller dir: ${spec.dir}`);
    assert.equal(fs.existsSync(extConfigPath), true, `Missing external config: ${spec.configFile}`);

    const pkg = JSON.parse(fs.readFileSync(path.join(ctrlDir, 'package.json'), 'utf8'));
    assert.equal(pkg.name, spec.packageName);
    assert.equal(pkg.main, 'main.js');

    const ctrlConfig = require(path.join(ctrlDir, 'config.js'));
    const ctrlSchema = require(path.join(ctrlDir, 'schema.js'));
    const ctrlHelpers = require(path.join(ctrlDir, 'helpers.js'));
    const mainSource = fs.readFileSync(path.join(ctrlDir, 'main.js'), 'utf8');

    assert.equal(ctrlConfig.name, spec.packageName);
    assert.equal(
      mainSource.includes('BaseController.exportedProperties('),
      true,
      `${spec.dir}/main.js must export BaseController.exportedProperties(schema, config)`,
    );

    const parsedRoutes = parseDecoratedRoutes(mainSource);
    assert.deepEqual(
      parsedRoutes.map(({ route, method, handler }) => ({ route, method, handler })),
      spec.routes.map(({ route, method, handler }) => ({ route, method, handler })),
      `Route decorator mismatch in ${spec.dir}/main.js`,
    );
    totalRoutes += parsedRoutes.length;

    for (let i = 0; i < spec.routes.length; i++) {
      const r = spec.routes[i];
      const parsed = parsedRoutes[i];

      assert.equal(typeof ctrlHelpers[r.handler], 'function', `Missing helper ${spec.dir}.${r.handler}`);
      assert.equal(typeof ctrlSchema[r.handler], 'function', `Missing schema ${spec.dir}.${r.handler}`);

      const handlerCfg = ctrlConfig.handlers[r.handler];
      assert.deepEqual(
        handlerCfg,
        { needProtocolRef: false, params: r.params },
        `Handler config mismatch for ${spec.dir}.${r.handler}`,
      );
      for (const token of handlerCfg.params) {
        assert.equal(VALID_PARAM_TOKENS.has(token), true, `Invalid param token: ${token}`);
      }
      assert.equal(
        parsed.argCount,
        r.params.length,
        `main.js method ${spec.dir}.${r.handler} arg count (${parsed.argCount}) must match config.params.length (${r.params.length})`,
      );
      assert.equal(
        ctrlHelpers[r.handler].length,
        r.params.length,
        `helpers.js ${spec.dir}.${r.handler} arg count (${ctrlHelpers[r.handler].length}) must match config.params.length (${r.params.length})`,
      );

      const schemaObj = ctrlSchema[r.handler]();
      assert.equal(typeof schemaObj.header, 'object');
      assert.equal(typeof schemaObj.params, 'object');
      assert.equal(typeof schemaObj.queryString, 'object');
    }
  }

  assert.equal(totalRoutes, 19, 'Expected all 19 backend API routes across the 3 controllers');
});

test('project-config loads cleanly across dev, prod, and test modes and binds port 3000 by default', () => {
  const devCfg = require(path.join(ROOT, 'project-config', 'dev'));
  const prodCfg = require(path.join(ROOT, 'project-config', 'prod'));
  const testCfg = require(path.join(ROOT, 'project-config', 'test'));

  assert.equal(Array.isArray(devCfg.servers), true);
  assert.equal(devCfg.servers[0].packageName, '@partFramework/http');
  assert.equal(devCfg.servers[0].port, Number(process.env.BACKEND_PORT || process.env.PORT || 3000));
  assert.equal(Array.isArray(prodCfg.servers), true);
  assert.equal(Array.isArray(testCfg.servers), true);
});

test('http-adapter extracts injected queryString, request.data, route params, HTML response, and HTTP errors accurately', async () => {
  const {
    normalizeQuery,
    normalizeBody,
    extractRouteParam,
    sendHtml,
    runJsonHandler,
    BadRequestError,
    ForbiddenError,
    NotFoundError,
    ConflictError,
    registerFrameworkGlobals,
  } = require(path.join(ROOT, 'services', 'http-adapter'));

  const mockHeaders = {};
  const response = {
    statusCode: 200,
    setHeader(k, v) {
      mockHeaders[k.toLowerCase()] = v;
    },
  };

  assert.deepEqual(normalizeQuery({ bank: 'tavan_mellat', day: '1405-08-20' }), {
    bank: 'tavan_mellat',
    day: '1405-08-20',
  });
  assert.equal(
    extractRouteParam({ url: '/api/sample/REQ-42' }, { params: { requestId: 'REQ-42' } }, 'requestId', /\/api\/sample\/([^/?#]+)/),
    'REQ-42',
  );
  assert.deepEqual(normalizeBody({ mode: 'nightly', rebuild: true }), { mode: 'nightly', rebuild: true });
  assert.deepEqual(normalizeBody(JSON.stringify({ mode: 'intraday' })), { mode: 'intraday' });

  const okRes = await runJsonHandler(response, async () => ({ ok: true }), { noStore: true });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(okRes, { ok: true });
  assert.match(mockHeaders['cache-control'], /no-store/);

  const badRaw = await runJsonHandler(response, async () => {
    throw new BadRequestError('ورودی نامعتبر');
  });
  assert.equal(response.statusCode, 400);
  const badObj = typeof badRaw === 'string' ? JSON.parse(badRaw) : badRaw;
  assert.equal(badObj.message, 'ورودی نامعتبر');

  const forbiddenRaw = await runJsonHandler(response, async () => {
    throw new ForbiddenError('عدم مجوز');
  });
  assert.equal(response.statusCode, 403);
  const forbiddenObj = typeof forbiddenRaw === 'string' ? JSON.parse(forbiddenRaw) : forbiddenRaw;
  assert.equal(forbiddenObj.statusCode, 403);

  const notFoundRaw = await runJsonHandler(response, async () => {
    throw new NotFoundError('پیدا نشد');
  });
  assert.equal(response.statusCode, 404);
  const notFoundObj = typeof notFoundRaw === 'string' ? JSON.parse(notFoundRaw) : notFoundRaw;
  assert.equal(notFoundObj.statusCode, 404);

  const conflictRaw = await runJsonHandler(response, async () => {
    throw new ConflictError('تداخل اجرا');
  });
  assert.equal(response.statusCode, 409);
  const conflictObj = typeof conflictRaw === 'string' ? JSON.parse(conflictRaw) : conflictRaw;
  assert.equal(conflictObj.statusCode, 409);

  const htmlOut = sendHtml(response, '<!doctype html><html><body>OK</body></html>');
  assert.equal(response.statusCode, 200);
  assert.match(mockHeaders['content-type'], /text\/html/);
  assert.equal(htmlOut, '<!doctype html><html><body>OK</body></html>');

  class MockHttpResult {
    constructor(data, statusCode, headers, contentType) {
      this.data = data;
      this.statusCode = statusCode;
      this.headers = headers;
      this.contentType = contentType;
    }
  }
  registerFrameworkGlobals({ HttpResult: MockHttpResult });
  const wrappedHtml = sendHtml(response, '<!doctype html><html><body>RAW</body></html>', 200);
  assert.equal(wrappedHtml instanceof MockHttpResult, true);
  assert.equal(wrappedHtml.data, '<!doctype html><html><body>RAW</body></html>');
  assert.equal(wrappedHtml.statusCode, 200);
  assert.match(wrappedHtml.contentType, /text\/html/);
});

test('all controller main.js classes transpile and instantiate cleanly under decorator loader simulation and Program.js boots in order', async () => {
  const vm = require('node:vm');
  const Module = require('node:module');

  let ts = null;
  for (const candidate of [
    'typescript',
    path.join(ROOT, '..', 'backend', 'node_modules', 'typescript'),
  ]) {
    try {
      ts = require(candidate);
      break;
    } catch {}
  }

  if (ts) {
    const allDirs = ['sampleController', ...EXPECTED_CONTROLLERS.map((c) => c.dir)];
    for (const dir of allDirs) {
      const mainPath = path.join(ROOT, 'controllers', dir, 'main.js');
      const source = fs.readFileSync(mainPath, 'utf8');
      const transpiled = ts.transpileModule(source, {
        compilerOptions: {
          experimentalDecorators: true,
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.CommonJS,
        },
      }).outputText;

      const recordedDecorators = [];
      class MockBaseController {
        static exportedProperties(schema, config) {
          return { schema, config };
        }
      }

      const customRequire = Module.createRequire(mainPath);
      const modExports = {};
      const modObj = { exports: modExports };
      const sandbox = {
        module: modObj,
        exports: modExports,
        __filename: mainPath,
        __dirname: path.dirname(mainPath),
        require: (id) => {
          if (id === '@partFramework/baseController') return MockBaseController;
          return customRequire(id);
        },
        Route: (routePath) => (_target, propertyKey) => {
          recordedDecorators.push({ type: 'Route', value: routePath, handler: propertyKey });
        },
        HTTP: (verb) => (_target, propertyKey) => {
          recordedDecorators.push({ type: 'HTTP', value: verb, handler: propertyKey });
        },
        console,
      };

      vm.runInNewContext(transpiled, sandbox, { filename: mainPath });
      assert.equal(typeof modObj.exports.controller, 'function', `${dir} must export controller class`);
      assert.equal(typeof modObj.exports.introduceToLoader, 'object', `${dir} must export introduceToLoader`);
      const instance = new modObj.exports.controller();
      assert.equal(instance instanceof MockBaseController, true);
      assert.equal(recordedDecorators.length >= 2, true);
    }
  }

  const events = [];
  const originalLoad = Module._load;
  const container = require(path.join(ROOT, 'services', 'container'));
  container.setServicesForTest({
    async init() {
      events.push('services.init');
    },
    async close() {
      events.push('services.close');
    },
  });

  Module._load = function (request, parent, isMain) {
    if (request === 'partFramework') {
      return class MockPartFramework {
        constructor(cfg) {
          this.cfg = cfg;
          this.loader = {
            async loadControllersByPath(p) {
              events.push(`loadControllersByPath:${p}`);
            },
            async loadControllerPackages(pkgs) {
              events.push(`loadControllerPackages:${pkgs.length}`);
            },
            async loadServers(srvs) {
              events.push(`loadServers:${srvs[0].packageName}:${srvs[0].port}`);
            },
          };
        }
        async init() {
          events.push('core.init');
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[require.resolve(path.join(ROOT, 'Program.js'))];
    const Program = require(path.join(ROOT, 'Program.js'));
    const projectConfig = require(path.join(ROOT, 'project-config')).dev;
    const program = new Program(projectConfig);
    await program.run();

    assert.deepEqual(events, [
      'core.init',
      'services.init',
      'loadControllersByPath:./controllers',
      `loadServers:@partFramework/http:${projectConfig.servers[0].port}`,
    ]);
  } finally {
    Module._load = originalLoad;
  }
});

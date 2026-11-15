'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const EXPECTED_CONTROLLERS = [
  {
    dir: 'summaryController',
    configFile: 'summaryController.config.js',
    packageName: 'summary-controller',
    routes: [
      { method: 'GET', route: '/api/health', handler: 'health' },
      { method: 'GET', route: '/api/banks', handler: 'banks' },
      { method: 'GET', route: '/api/specs', handler: 'specs' },
      { method: 'GET', route: '/api/report', handler: 'report' },
      { method: 'GET', route: '/api/diagnostics', handler: 'diagnostics' },
      { method: 'GET', route: '/api/summary', handler: 'summary' },
      { method: 'GET', route: '/api/list', handler: 'list' },
      { method: 'GET', route: '/api/sample/:requestId', handler: 'sample' },
      { method: 'GET', route: '/api/runs', handler: 'runs' },
    ],
  },
  {
    dir: 'ingestionController',
    configFile: 'ingestionController.config.js',
    packageName: 'ingestion-controller',
    routes: [
      { method: 'POST', route: '/api/runs', handler: 'run' },
    ],
  },
  {
    dir: 'adminController',
    configFile: 'adminController.config.js',
    packageName: 'admin-controller',
    routes: [
      { method: 'GET', route: '/api/admin/overview', handler: 'getOverview' },
      { method: 'GET', route: '/api/admin/cron', handler: 'getCron' },
      { method: 'PUT', route: '/api/admin/cron', handler: 'updateCron' },
      { method: 'POST', route: '/api/admin/cron/run-now', handler: 'runCronNow' },
      { method: 'POST', route: '/api/admin/runs/check', handler: 'checkExisting' },
      { method: 'POST', route: '/api/admin/runs/start', handler: 'startRun' },
      { method: 'GET', route: '/api/admin/jobs', handler: 'listJobs' },
      { method: 'GET', route: '/api/admin/jobs/:id', handler: 'getJob' },
    ],
  },
];

function parseDecoratedRoutes(mainSource) {
  const regex = /@Route\('([^']+)'\)\s*@HTTP\('([^']+)'\)\s*([A-Za-z0-9_]+)\s*\(/g;
  const found = [];
  let match;
  while ((match = regex.exec(mainSource)) !== null) {
    found.push({ route: match[1], method: match[2], handler: match[3] });
  }
  return found;
}

test('all partFramework controller-packages have valid metadata, schemas, configs, decorators, and helpers', () => {
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
    assert.deepEqual(parsedRoutes, spec.routes, `Route decorator mismatch in ${spec.dir}/main.js`);
    totalRoutes += parsedRoutes.length;

    for (const r of spec.routes) {
      assert.equal(typeof ctrlHelpers[r.handler], 'function', `Missing helper ${spec.dir}.${r.handler}`);
      assert.equal(typeof ctrlSchema[r.handler], 'function', `Missing schema ${spec.dir}.${r.handler}`);
      assert.deepEqual(
        ctrlConfig.handlers[r.handler],
        { needProtocolRef: true, params: [] },
        `Invalid handler config for ${spec.dir}.${r.handler}`,
      );

      const schemaObj = ctrlSchema[r.handler]();
      assert.equal(typeof schemaObj.header, 'object');
      assert.equal(typeof schemaObj.params, 'object');
      assert.equal(typeof schemaObj.queryString, 'object');
      if (r.method === 'POST' || r.method === 'PUT') {
        assert.equal(typeof schemaObj.body, 'object', `${spec.dir}.${r.handler} must define body schema`);
      }
    }
  }

  assert.equal(totalRoutes, 18, 'Expected all 18 backend API routes across controllers');
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

test('http-adapter extracts query, params, JSON body, HTML response, and HTTP errors accurately', async () => {
  const {
    getQuery,
    getParams,
    getBody,
    sendHtml,
    runJsonHandler,
    BadRequestError,
    NotFoundError,
    ConflictError,
  } = require(path.join(ROOT, 'services', 'http-adapter'));

  const mockHeaders = {};
  const protocolRef = {
    request: {
      url: '/api/sample/REQ-42?bank=tavan_mellat&day=1405-08-20',
      body: JSON.stringify({ mode: 'nightly', rebuild: true }),
    },
    response: {
      statusCode: 200,
      setHeader(k, v) {
        mockHeaders[k.toLowerCase()] = v;
      },
    },
  };

  assert.deepEqual(getQuery(protocolRef), { bank: 'tavan_mellat', day: '1405-08-20' });
  assert.deepEqual(getParams(protocolRef, /\/api\/sample\/([^/?#]+)/, 'requestId'), { requestId: 'REQ-42' });
  assert.deepEqual(getBody(protocolRef), { mode: 'nightly', rebuild: true });

  const okRes = await runJsonHandler(protocolRef, async () => ({ ok: true }), { noStore: true });
  assert.equal(protocolRef.response.statusCode, 200);
  assert.deepEqual(okRes, { ok: true });
  assert.match(mockHeaders['cache-control'], /no-store/);

  const badRaw = await runJsonHandler(protocolRef, async () => {
    throw new BadRequestError('ورودی نامعتبر');
  });
  assert.equal(protocolRef.response.statusCode, 400);
  const badObj = typeof badRaw === 'string' ? JSON.parse(badRaw) : badRaw;
  assert.equal(badObj.message, 'ورودی نامعتبر');

  const notFoundRaw = await runJsonHandler(protocolRef, async () => {
    throw new NotFoundError('پیدا نشد');
  });
  assert.equal(protocolRef.response.statusCode, 404);
  const notFoundObj = typeof notFoundRaw === 'string' ? JSON.parse(notFoundRaw) : notFoundRaw;
  assert.equal(notFoundObj.statusCode, 404);

  const conflictRaw = await runJsonHandler(protocolRef, async () => {
    throw new ConflictError('تداخل اجرا');
  });
  assert.equal(protocolRef.response.statusCode, 409);
  const conflictObj = typeof conflictRaw === 'string' ? JSON.parse(conflictRaw) : conflictRaw;
  assert.equal(conflictObj.statusCode, 409);

  const htmlOut = sendHtml(protocolRef, '<!doctype html><html><body>OK</body></html>');
  assert.equal(protocolRef.response.statusCode, 200);
  assert.match(mockHeaders['content-type'], /text\/html/);
  assert.equal(htmlOut, '<!doctype html><html><body>OK</body></html>');

  // تست زمانی که HttpResult توسط لودر partFramework تزریق میشود
  const { registerFrameworkGlobals } = require(path.join(ROOT, 'services', 'http-adapter'));
  class MockHttpResult {
    constructor(data, statusCode, headers, contentType) {
      this.data = data;
      this.statusCode = statusCode;
      this.headers = headers;
      this.contentType = contentType;
    }
  }
  registerFrameworkGlobals({ HttpResult: MockHttpResult });
  const wrappedHtml = sendHtml(protocolRef, '<!doctype html><html><body>RAW</body></html>', 200);
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

  // تست ترتیب بوتشدن Program.js با شبیهسازی هستهٔ partFramework
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

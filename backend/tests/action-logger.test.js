'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const ROOT = path.join(__dirname, '..');

const {
  ActionLoggerService,
  sanitizeLogData,
  getActionLogger,
  setActionLogger,
} = require(path.join(ROOT, 'services', 'logger', 'action-logger.service'));
const { installHttpAuditLogger, sanitizeRequestUrl } = require(path.join(ROOT, 'services', 'logger', 'http-audit'));
const { requireAuthenticatedSession } = require(path.join(ROOT, 'services', 'http', 'session-guard'));
const { getVazirmatnFontCss } = require(path.join(ROOT, 'services', 'legacy-report', 'font-face'));
const { buildReport } = require(path.join(ROOT, 'services', 'legacy-report', 'report-builder'));

test('ActionLoggerService redacts secrets, writes NDJSON actions + errors files, and inserts into DB', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-action-logger-'));
  const queries = [];
  const fakeDb = {
    async query(sql, params) {
      queries.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  };

  try {
    const logger = new ActionLoggerService({
      logDir: tmpDir,
      consoleEnabled: false,
      enableFiles: true,
      enableDb: true,
      db: fakeDb,
    });

    const sanitized = sanitizeLogData({
      username: 'sadegh',
      password: 'my-secret-password',
      refreshToken: 'tok-12345',
      nationalCode: '0012345678',
      passed: 12,
      nested: {
        authorization: 'Bearer abc.def.ghi',
        cookie: 'ce_refresh=xyz',
        safeNote: 'Bearer secret-inline ce_refresh=inline-val',
      },
    });

    assert.equal(sanitized.username, 'sadegh');
    assert.equal(sanitized.password, '[REDACTED]');
    assert.equal(sanitized.refreshToken, '[REDACTED]');
    assert.equal(sanitized.nationalCode, '[REDACTED]');
    assert.equal(sanitized.passed, 12);
    assert.equal(sanitized.nested.authorization, '[REDACTED]');
    assert.equal(sanitized.nested.cookie, '[REDACTED]');
    assert.match(sanitized.nested.safeNote, /Bearer \[REDACTED\]/);
    assert.match(sanitized.nested.safeNote, /ce_refresh=\[REDACTED\]/);

    logger.info({
      category: 'auth',
      action: 'auth.login.success',
      actor: 'sadegh',
      roles: ['admin'],
      statusCode: 200,
      meta: { password: 'hidden', bank: 'tavan_mellat' },
    });

    logger.error({
      category: 'admin',
      action: 'admin.job.step_failed',
      actor: 'sadegh',
      statusCode: 500,
      errorCode: 'TEST_ERR',
      message: 'step failed',
      stack: 'Error: boom\n  at test:1',
    });

    await logger.flush();

    const files = fs.readdirSync(tmpDir).sort();
    assert.equal(files.some((f) => f.startsWith('actions-') && f.endsWith('.log')), true);
    assert.equal(files.some((f) => f.startsWith('errors-') && f.endsWith('.log')), true);

    const actionsFile = path.join(tmpDir, files.find((f) => f.startsWith('actions-')));
    const errorsFile = path.join(tmpDir, files.find((f) => f.startsWith('errors-')));

    const actionLines = fs.readFileSync(actionsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const errorLines = fs.readFileSync(errorsFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

    assert.equal(actionLines.length, 2);
    assert.equal(actionLines[0].meta.password, '[REDACTED]');
    assert.equal(actionLines[0].meta.bank, 'tavan_mellat');
    assert.equal(errorLines.length, 1);
    assert.equal(errorLines[0].action, 'admin.job.step_failed');

    const inserts = queries.filter((q) => q.sql.includes('INSERT INTO backend_action_logs'));
    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].params[3], 'auth.login.success');
    assert.equal(inserts[1].params[1], 'error');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ActionLoggerService does not create log files by default', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-no-file-logs-'));
  const previousEnable = process.env.ENABLE_FILE_LOGS;
  const previousDisable = process.env.DISABLE_FILE_LOGS;
  delete process.env.ENABLE_FILE_LOGS;
  delete process.env.DISABLE_FILE_LOGS;
  try {
    const logger = new ActionLoggerService({ logDir: tmpDir, consoleEnabled: false, enableDb: false });
    logger.info({ category: 'test', action: 'test.no_file' });
    await logger.flush();
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  } finally {
    if (previousEnable === undefined) delete process.env.ENABLE_FILE_LOGS;
    else process.env.ENABLE_FILE_LOGS = previousEnable;
    if (previousDisable === undefined) delete process.env.DISABLE_FILE_LOGS;
    else process.env.DISABLE_FILE_LOGS = previousDisable;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('PartLogger filesystem transports are disabled in runtime configs', () => {
  const frameworkConfig = require(path.join(ROOT, 'project-config', 'dev')).partFrameworkConfig.partLoggerConfig;
  const instanceConfig = require(path.join(ROOT, 'configs', 'instance', 'partLogger.config'))
    .introduceToLoader.config.instance;
  const legacyConfig = require(path.join(ROOT, 'project-config', 'dev', 'dependencies', 'partLoggerConfig')).instance;
  assert.equal(frameworkConfig.instance.file.enabled, false);
  assert.equal(instanceConfig.file.enabled, false);
  assert.equal(legacyConfig.storageConfig.fileSystem.enabled, false);
});

test('ActionLoggerService forwards redacted action events to the injected PartLogger', () => {
  const captured = [];
  const partLogger = {
    info(payload) { captured.push({ level: 'info', payload }); },
    warn(payload) { captured.push({ level: 'warn', payload }); },
    error(payload) { captured.push({ level: 'error', payload }); },
  };
  const logger = new ActionLoggerService({
    consoleEnabled: false,
    enableFiles: false,
    enableDb: false,
    partLogger,
  });

  logger.info({
    category: 'auth',
    action: 'auth.login.success',
    message: 'Signed in',
    meta: { username: 'ali', password: 'must-not-leak' },
  });
  logger.warn({ category: 'admin', action: 'admin.run.denied' });
  logger.error({ category: 'ingestion', action: 'ingestion.day.failed', errorCode: 'TEST' });

  assert.deepEqual(captured.map((item) => item.level), ['info', 'warn', 'error']);
  assert.equal(captured[0].payload.event, 'auth.login.success');
  assert.equal(captured[0].payload.msg, 'Signed in');
  assert.equal(captured[0].payload.additionalInfo.meta.password, '[REDACTED]');
  assert.equal(captured[1].payload.event, 'admin.run.denied');
  assert.equal(captured[2].payload.additionalInfo.errorCode, 'TEST');
});

test('PartLogger resolver injects the framework logger into the shared ActionLogger', () => {
  const previous = getActionLogger();
  const logger = new ActionLoggerService({ consoleEnabled: false, enableFiles: false, enableDb: false });
  const captured = [];
  const partLogger = { info(payload) { captured.push(payload); } };
  const PartLoggerActionSink = require(path.join(ROOT, 'services', 'logger', 'part-logger-action-sink'));
  try {
    setActionLogger(logger);
    new PartLoggerActionSink(partLogger);
    logger.info({ category: 'summary', action: 'summary.report.rendered' });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].event, 'summary.report.rendered');
  } finally {
    setActionLogger(previous);
  }
});

test('installHttpAuditLogger logs HTTP requests with AsyncLocalStorage actor & exception code', async () => {
  const prevLogger = getActionLogger();
  const captured = [];
  const mockLogger = {
    logEvent(entry) {
      captured.push(entry);
      return entry;
    },
    info(entry) {
      return this.logEvent({ ...entry, level: 'info' });
    },
    warn(entry) {
      return this.logEvent({ ...entry, level: 'warn' });
    },
    error(entry) {
      return this.logEvent({ ...entry, level: 'error' });
    },
    flush: async () => {},
  };

  setActionLogger(mockLogger);
  installHttpAuditLogger();

  assert.equal(
    sanitizeRequestUrl('/api/sample?requestId=req-1&token=secret123&bank=tavan_mellat&nationalCode=1234567890'),
    '/api/sample?requestId=req-1&token=%5BREDACTED%5D&bank=tavan_mellat&nationalCode=%5BREDACTED%5D',
  );

  const authException = require(path.join(ROOT, 'controllers', 'auth', 'exceptions', 'authException.js'));

  const server = http.createServer(async (req, res) => {
    if (req.url.startsWith('/api/test-ok')) {
      await requireAuthenticatedSession({ samadUsername: 'ali-admin', roles: ['admin'] }, () => new Error('unauth'));
      res.statusCode = 200;
      res.end('ok');
      return;
    }
    const mapped = authException({ statusCode: 401, code: 'invalidCredentials' });
    res.statusCode = mapped.statusCode;
    res.end(JSON.stringify(mapped));
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;

    const r1 = await fetch(`http://127.0.0.1:${port}/api/test-ok?token=topsecret`);
    assert.equal(r1.status, 200);
    assert.ok(r1.headers.get('x-request-id'));

    const r2 = await fetch(`http://127.0.0.1:${port}/api/test-err`);
    assert.equal(r2.status, 401);

    await new Promise((r) => setTimeout(r, 20));

    const httpOk = captured.find((e) => e.category === 'http' && String(e.path).startsWith('/api/test-ok'));
    assert.ok(httpOk);
    assert.equal(httpOk.actor, 'ali-admin');
    assert.deepEqual(httpOk.roles, ['admin']);
    assert.equal(httpOk.statusCode, 200);
    assert.doesNotMatch(httpOk.path, /topsecret/);

    const excLog = captured.find((e) => e.category === 'controller' && e.action === 'controller.auth.exception');
    assert.ok(excLog);
    assert.equal(excLog.statusCode, 401);
    assert.equal(excLog.errorCode, 'invalidCredentials');

    const httpErr = captured.find((e) => e.category === 'http' && e.path === '/api/test-err');
    assert.ok(httpErr);
    assert.equal(httpErr.level, 'warn');
    assert.equal(httpErr.statusCode, 401);
    assert.equal(httpErr.errorCode, 'invalidCredentials');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    setActionLogger(prevLogger);
  }
});

test('Vazirmatn self-hosted font CSS and clean 403 message are bundled into legacy-report', async () => {
  const fontCss = getVazirmatnFontCss();
  assert.match(fontCss, /font-family:'Vazirmatn'/);
  assert.match(fontCss, /data:font\/woff2;base64,/);

  const clientJs = fs.readFileSync(
    path.join(ROOT, 'services', 'legacy-report', 'assets', 'client.js'),
    'utf8',
  );
  assert.match(clientJs, /شما مجوز مشاهدهٔ جزئیات گزارش را ندارید\./);
  assert.equal(clientJs.includes('شما مجوز مشاهدهٔ جزئیات گزارش را ندارید (نیازمند نقش'), false);

  const html = buildReport(
    { errors: [], totalSamples: 0, invalidSamples: 0 },
    { groups: {}, ranges: {}, processedFiles: 0, evaluatorErrors: {}, runtimeErrors: [] },
    {},
  );
  assert.match(html, /font-family:'Vazirmatn'/);

  const { EvaluatorService } = require(path.join(ROOT, 'services', 'evaluator', 'evaluator.service'));
  const { SummaryService } = require(path.join(ROOT, 'services', 'summary', 'summary.service'));
  const summarySvc = new SummaryService({ async query() { return { rows: [], rowCount: 0 }; } }, new EvaluatorService());
  const fullHtml = await summarySvc.report('tavan_mellat', '1405-08-01', '1405-08-01', 25);
  assert.match(fullHtml, /id="ce-font-vazirmatn"/);
  assert.match(fullHtml, /__CE_FONT_CSS=/);
  assert.match(fullHtml, /'Vazirmatn'/);
  const errHtml = summarySvc.errorHtml(new Error('upstream down'));
  assert.match(errHtml, /font-family:'Vazirmatn'/);
  assert.match(errHtml, /'Vazirmatn',Tahoma/);
});

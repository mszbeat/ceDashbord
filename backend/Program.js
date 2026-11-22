'use strict';

const PartFramework = require('partFramework');
const PartRequest = require('partRequest');

const pr = new PartRequest();

const { getServices } = require('./services/container');
const { config, cleanEnv, requiredEnv, assertEnv } = require('./services/config');

const SessionManager = require('./controllers/auth/session-manager');
const SamadService = require('./controllers/auth/samad.service');
const { installHttpCookiePathNormalizer } = require('./services/http/cookie-normalize');
const { installHttpAuditLogger } = require('./services/logger/http-audit');
const { getActionLogger } = require('./services/logger/action-logger.service');

/**
 * بوت‌استرپ بک‌اند داشبورد روی `partFramework` — الگوی `samplePF`.
 *
 * ترتیب اجرا:
 *   1) core.init()
 *   2) بارگذاری وابستگی‌های تزریقی (sessionManager / samadService / authService)
 *      به‌همراه راه‌اندازی کانتینر سرویس‌های دامنه (DB + cron)
 *   3) loadControllersByPath('./controllers')
 *   4) loadServers(servers)  →  سرویس HTTP + خواندن مسیرها از `routes.js`
 */
class Program {
  #core;
  #config;
  #servers;
  #controllers = './controllers';
  #controllerPackages = [];

  constructor(projectConfig) {
    this.#config = projectConfig;
    this.#core = new PartFramework(this.#config);
    this.#servers = this.#config.servers;
  }

  #loadManualControllers() {}

  async #loadDependencies() {
    this.#core.loader.load('sessionManager', SessionManager);

    const samadBaseUrl = cleanEnv(process.env.SAMAD_SERVICE_URL) || 'http://samad-v8-dev.partdp.ir';
    const samadProtocol = samadBaseUrl.startsWith('https://') ? 'https' : 'http';
    const samadUser = requiredEnv('SAMAD_USER');
    const samadPass = requiredEnv('SAMAD_PASS');

    // کلاینت HTTP سرویس سمد (تخصیص/خواندن/حذف نقش کاربران)
    this.#core.loader.load('samadService', SamadService).inject(
      new pr({
        defaultHttpRequestOptions: {
          baseURL: samadBaseUrl,
          headers: {
            user: samadUser,
            pass: samadPass,
          },
          timeout: Number(cleanEnv(process.env.SAMAD_TIMEOUT_MS) || 7000),
          protocol: samadProtocol,
        },
      }),
    );

    // لایهٔ اصالت‌سنجی پارت (partAuthenticationInterface) از طریق loaderConf
    this.#core.loader.loadResolver(
      'authService',
      './controllers/auth/authentication.service',
      undefined,
      { resolveConfig: true },
    );

    const services = getServices();
    await services.init();

    const shutdown = async (signal) => {
      try {
        getActionLogger().info({
          category: 'system',
          action: 'system.shutdown',
          message: `Received ${signal || 'shutdown signal'}`,
        });
        await services.close();
      } catch {
        // خاموشی امن؛ خطای بستن اتصال نباید فرآیند را متوقف کند
      }
    };
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }

  async #loadControllers() {
    return this.#core.loader.loadControllersByPath(this.#controllers);
  }

  async #loadControllerPackages() {
    if (this.#controllerPackages.length) {
      return this.#core.loader.loadControllerPackages(this.#controllerPackages);
    }
  }

  async #loadServers() {
    return this.#core.loader.loadServers(this.#servers);
  }

  async run() {
    /**
     * D5/env fail-fast: پیش از هر اتصال یا گوش‌دادن روی پورت، تنظیمات محیط اعتبارسنجی می‌شود.
     * بدون این، سرویس با `DATABASE_URL` خالی بالا می‌آمد و اولین درخواست، خطای مبهم می‌داد.
     * خطای صریح و فوری = استارت ناموفق، نه سرویسِ نیمه‌کاره.
     */
    try {
      assertEnv(process.env);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`❌ ${error.message}`);
      process.exit(1);
    }
    installHttpCookiePathNormalizer();
    installHttpAuditLogger();
    await this.#core.init();
    await this.#loadDependencies();
    await this.#loadControllers();
    await this.#loadControllerPackages();
    this.#loadManualControllers();
    await this.#loadServers();
    getActionLogger().info({
      category: 'system',
      action: 'system.startup.ready',
      message: `CE Dashboard backend listening on http://${config.backendHost}:${config.backendPort}/api`,
      meta: { host: config.backendHost, port: config.backendPort },
    });
    // eslint-disable-next-line no-console
    console.log(
      `✅ CE Dashboard backend (partFramework) running on http://${config.backendHost}:${config.backendPort}/api`,
    );
  }
}

module.exports = Program;

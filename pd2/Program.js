'use strict';

const PartFramework = require('partFramework');
const PartRequest = require('partRequest');

const { getServices } = require('./services/container');
const { config } = require('./services/config');

const SessionManager = require('./controllers/auth/session-manager');
const SamadService = require('./controllers/auth/samad.service');
const AuthenticationService = require('./controllers/auth/authentication.service');

/**
 * بوت‌استرپ پروژهٔ pd2 روی `partFramework@10.2.0` — الگوی `samplePF`.
 *
 * ترتیب اجرا (مثل samplePF):
 *   1) core.init()
 *   2) بارگذاری وابستگی‌های تزریقی (sessionManager / samadService / authenticationService)
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
    this.#core.loader.load('authenticationService', AuthenticationService);

    // کلاینت HTTP سرویس سمد (تخصیص/خواندن/حذف نقش کاربران)
    this.#core.loader.load('samadService', SamadService).inject(
      new PartRequest({
        defaultHttpRequestOptions: {
          baseURL: process.env.SAMAD_SERVICE_URL,
          headers: {
            user: process.env.SAMAD_USER,
            pass: process.env.SAMAD_PASS,
          },
          timeout: Number(process.env.SAMAD_TIMEOUT_MS || 7000),
          protocol: 'http',
        },
      }),
    );

    // لایهٔ اصالت‌سنجی پارت (partAuthenticationInterface) از طریق loaderConf
    this.#core.loader.loadResolver(
      'authService',
      './controllers/auth/auth.service',
      undefined,
      { resolveConfig: true },
    );

    const services = getServices();
    await services.init();

    const shutdown = async () => {
      try {
        await services.close();
      } catch {
        // خاموشی امن؛ خطای بستن اتصال نباید فرآیند را متوقف کند
      }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
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
    await this.#core.init();
    await this.#loadDependencies();
    await this.#loadControllers();
    await this.#loadControllerPackages();
    this.#loadManualControllers();
    await this.#loadServers();
    // eslint-disable-next-line no-console
    console.log(
      `✅ pd2 (partFramework) running on http://${config.backendHost}:${config.backendPort}/api`,
    );
  }
}

module.exports = Program;

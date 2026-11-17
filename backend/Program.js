'use strict';

const PartFramework = require('partFramework');
const PartRequest = require('partRequest');

const pr = new PartRequest();

const { getServices } = require('./services/container');
const { config } = require('./services/config');

const SessionManager = require('./controllers/auth/session-manager');
const SamadService = require('./controllers/auth/samad.service');
const { installHttpCookiePathNormalizer } = require('./services/http/cookie-normalize');

function cleanEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed)) return undefined;
  return trimmed;
}

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

    const samadBaseUrl = process.env.SAMAD_SERVICE_URL ;
    const samadProtocol = samadBaseUrl.startsWith('https://') ? 'https' : 'http';

    // کلاینت HTTP سرویس سمد (تخصیص/خواندن/حذف نقش کاربران)
    this.#core.loader.load('samadService', SamadService).inject(
      new pr({
        defaultHttpRequestOptions: {
          baseURL: samadBaseUrl,
          headers: {
            user: cleanEnv(process.env.SAMAD_USER) || 'mohammadsadeghZarei',
            pass: cleanEnv(process.env.SAMAD_PASS) || 'mohammadsadeghZarei',
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
    installHttpCookiePathNormalizer();
    await this.#core.init();
    await this.#loadDependencies();
    await this.#loadControllers();
    await this.#loadControllerPackages();
    this.#loadManualControllers();
    await this.#loadServers();
    // eslint-disable-next-line no-console
    console.log(
      `✅ CE Dashboard backend (partFramework) running on http://${config.backendHost}:${config.backendPort}/api`,
    );
  }
}

module.exports = Program;

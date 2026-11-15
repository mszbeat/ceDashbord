const PartFramework = require('partFramework');
const { getServices } = require('./services/container');
const { config } = require('./services/config');
const AuthService = require('./controllers/auth/auth.service')

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

  #loadManualControllers() { }

  async #loadDependencies() {
    this.#core.loader.loadResolver('authService', './controllers/auth/auth.service', undefined, { resolveConfig: true })
    const services = getServices();
    await services.init();

    const shutdown = async () => {
      try {
        await services.close();
      } catch { }
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  }

  async #loadControllers() {
    return this.#core.loader.loadControllersByPath(this.#controllers);
  }

  async #loadServers() {
    return this.#core.loader.loadServers(this.#servers);
  }

  async #loadControllerPackages() {
    if (this.#controllerPackages.length) {
      return this.#core.loader.loadControllerPackages(this.#controllerPackages);
    }
  }

  async run() {
    await this.#core.init();
    await this.#loadDependencies();
    await this.#loadControllers();
    await this.#loadControllerPackages();
    this.#loadManualControllers();
    await this.#loadServers();
    console.log(`✅ CE Dashboard (partFramework): http://${config.backendHost}:${config.backendPort}/api`);
  }
}

module.exports = Program;

const PartFramework = require('partFramework');
const samadService = require("./services/samadService")
const transactions = require("./helpers/transactions")
const operations = require("./helpers/operations")
const rollback = require("./helpers/rollback")
const sessionManager = require("./utils/sessionManager")
const authentication = require("./services/authentication")
const profileService = require("./services/profileService")
const employeeService = require("./services/employeeService")

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
  #loadDependencies() {
    this.#core.loader.load('sessionManager', sessionManager)
    this.#core.loader.load('transactions', transactions)
    this.#core.loader.load('operations', operations)
    this.#core.loader.load('employeeService', employeeService)
    this.#core.loader.load('samadService', samadService)
    this.#core.loader.load('authentication', authentication)
    this.#core.loader.loadFunction('rollback', rollback)
    this.#core.loader.load('profileService', profileService)
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
    this.#loadDependencies();
    await this.#loadControllers();
    await this.#loadControllerPackages();
    this.#loadManualControllers();
    await this.#loadServers();
  }
}

module.exports = Program;
const BaseController = require('@partFramework/baseController');

exports.controller = class MyController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   * @param {Dependency1} dependency1
   * @param {Dependency2} dependency2
   */
  constructor(core, schema, config, authService) {
    super(core, schema, config);
    this.authService = authService;
  }

  @Route('/api/auth/register')
  @HTTP('POST')
  async register(postData, trackingHeaders) {
    return await this.authService.addAuthEntry(postData, trackingHeaders);
  }
};

exports.introduceToLoader = BaseController.exportedProperties(
  require('./schema'),
  require('./config')
);

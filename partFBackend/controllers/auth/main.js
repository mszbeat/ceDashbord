const BaseController = require('@partFramework/baseController');

class AuthController extends BaseController {
  /**
   * @param {Core} core
   * @param {Schema} schema
   * @param {Config} config
   * @param {AuthService} authService
   */
  constructor(core, schema, config, authService) {
    super(core, schema, config);
    this.authService = authService;
  }

  @Route('/api/auth/register')
  @HTTP('POST')
  async register(postData, trackingHeaders, session) {
    return await this.authService.addAuthEntry(postData, trackingHeaders, session);
  }

  @Route('/api/auth/login')
  @HTTP('POST')
  async login(postData, trackingHeaders, session) {
    return await this.authService.authenticate(postData, trackingHeaders, session);
  }

  @Route('/api/auth/remove')
  @HTTP('POST')
  async removeUser(postData, trackingHeaders, session) {
    return await this.authService.removeUser(postData, trackingHeaders, session);
  }
}

module.exports = {
  controller: AuthController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  ),
};

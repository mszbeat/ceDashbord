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

  @Route('/api/auth/logout')
  @HTTP('POST')
  async logout(session, response) {
    return await this.authService.logout(session, response);
  }

  @Route('/api/auth/me')
  @HTTP('GET')
  async me(session) {
    return await this.authService.getCurrentSession(session);
  }

  @Route('/api/auth/role')
  @HTTP('POST')
  async assignRole(postData, session) {
    return await this.authService.assignRole(postData, session);
  }

  @Route('/api/auth/role')
  @HTTP('GET')
  async getRole(queryString) {
    return await this.authService.getUserRoles(queryString);
  }

  @Route('/api/auth/remove')
  @HTTP('POST')
  async removeUser(postData, trackingHeaders, session, response) {
    return await this.authService.removeUser(postData, trackingHeaders, session, response);
  }
}

module.exports = {
  controller: AuthController,
  introduceToLoader: BaseController.exportedProperties(
    require('./schema'),
    require('./config')
  ),
};

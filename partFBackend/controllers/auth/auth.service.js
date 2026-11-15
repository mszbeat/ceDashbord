
class AuthService {
  #user = process.env.PART_AUTH_USERNAME;
  #pass = process.env.PART_AUTH_PASS;
  #system = process.env.PART_AUTH_SYSTEM;
  #status = 'Active';

  constructor(
    partAuthenticationInterface,
    partRequest,
    partLogger,
  ) {
    this.partRequest = partRequest;
    this.logger = partLogger;
    this.partAuth = partAuthenticationInterface;
  }

  async addAuthEntry({ username, password }, trackingHeaders) {
    const payload = {
      username,
      password
    }
    try {
      await this.partAuth.addUser(payload, this.#status, this.#system, trackingHeaders);
      return "ok"
    }
    catch (err) {
      if (err?.meta?.code === 'authEntryAlreadyExists') {
        throw {
          statusCode: 409,
          data: {
            message: {
              fa: 'ترکیب اصالت صنجی تکراری است',
              en: 'auth entry alreadyExists',
            }
          }
        }
      }
      this.logger.error(err);
    }
  }
}

module.exports = AuthService;
const { parseDurationMs } = require('../../../services/config');

module.exports={
  global: {
    tokenLength: 25,
    sessionExpireTime: parseDurationMs(process.env.SESSION_EXPIRE_MS, 300000),
    maxIdleTime: parseDurationMs(process.env.SESSION_IDLE_MS, 120000),
    maxFailedLogins: 4,
    loginFailedTimeLimit: 20000,
    multiAccessTime: 5000,
    defaultVisitorObj: {
      samadUsername: 'visitor',
      roles: ['visitor']
    },
    redisConfig: {
      global: {
        partLoggerConfig: require('./partLoggerConfig')
      },
      activeDbInstance: {
        host: '127.0.0.1',
        port: 6379,
        db: 5
      },
      mapDbInstance: {
        host: '127.0.0.1',
        port: 6379,
        db: 6
      }
    },
    partLoggerConfig: require('./partLoggerConfig')
  },
  instance: {}
};

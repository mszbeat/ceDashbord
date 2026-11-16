module.exports={
  global: {
    tokenLength: 25,
    sessionExpireTime: 120000,
    maxIdleTime: 20000,
    maxFailedLogins: 4,
    loginFailedTimeLimit: 20000,
    multiAccessTime: 5000,
    defaultVisitorObj: {
      samadUsername: 'visitor',
      roles: ['visitor']
    },
    redisConfig: {
      global: {
        partLoggerConfig: require('../dependencies/partLoggerConfig')
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
    partLoggerConfig: require('../dependencies/partLoggerConfig')
  },
  instance: {}
};

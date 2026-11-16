module.exports = {
  global: {
    partLoggerConfig: require('./partLoggerConfig'),
  },
  instance: {
    host: '127.0.0.1',
    httpPort: 80,
    httpsPort: 443,
    maxBodyLength: 5000,
    partSamadInterfaceConfig: require('./partSamadInterfaceConfig')
  }
};
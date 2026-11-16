const path = require('path');
const fs = require('fs');

module.exports = [
  {
    name: 'http',
    packageName: '@partFramework/http',
    port: 4001,
    host: 'localhost',
    responseHeaders: {},

    // ===========================
    // https config

    httpsServerConfig: {
      host: 'localhost',
      port: 4000
      //  certificate:
    },
    // ===========================

    // partSecurityConfig: require('./dependencies/partSecurityConfig'),
    // partServeIndexConfig: require('./dependencies/partServeIndexConfig'),
    // partUrlRewriterConfig: require('./dependencies/partUrlRewriterConfig'),
    // corsConfig: require('./dependencies/corsConfig')
  }
];
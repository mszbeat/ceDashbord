const envMode = process.env.mode || process.env.MODE || 'dev';

exports.routerConf = require('./routerConf');
exports.loaderConf = require('./loaderConf');
exports.servers = require('./servers');
exports.middlewareManagerConf = require('./middlewareManagerConf');
exports.scriptsConnectorConfig = require('./scriptsConnectorConfig');
exports.partFrameworkConfig = {
  partLoggerConfig: {
    //version: 7
    global: {
      levels: {
        error: 10,
        warn: 20,
        event: 30,
        info: 30,
        debug: 40,
        trace: 50,
      },
    },
    instance: {
      viewStackTrace: true,
      console: {
        enabled: true
      },
      file: {
        enabled: true,
        json: envMode === 'prod'
      },
      http: {
        enabled: false,
      },
      dls: {
        enabled: false
      },
    }
  }
};

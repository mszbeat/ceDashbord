const envMode = process.env.mode || process.env.MODE || 'dev';

exports.introduceToLoader = {
  config: {
    instance: {
      id: 'dashboard-auth-logger',
      sourceType: 'module',        
      sourceName: 'ce-dashboard-backend',
      viewStackTrace: true,
      console: {
        enabled: true,
        singleLine: false
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
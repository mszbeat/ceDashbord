module.exports={
  global: {},
  instance: {
    sourceTypeWidth: 8,
    sourceNameWidth: 20,
    winstonConfig: {
      handleExceptions: true,
      json: true,
      colorize: true,
      timestamp: function () {
        return (new Date()).toLocaleTimeString();
      },
      prettyPrint: true
    },
    storageConfig: {
      dls: {
        enabled: false,
        storageName: 'Logger@6-test'
      },
      mongo: {
        enabled: false,
        storageName: 'Logger@6-test'
      },
      fileSystem: {
        enabled: true,
        storageName: 'logfile'
      },
      http: {
        enabled: false,
        host: '127.0.0.1',
        port: '80',
        path: '/service/logServer/saveLog',
        method: 'POST'
      }
    },
    levelConfig: {
      event: {
        view: true,
        save: true,
        color: 'green',
        viewPath: false,
        priority: 2
      },
      warning: {
        view: true,
        save: true,
        color: 'yellowBg',
        viewPath: true,
        priority: 1
      },
      error: {
        view: true,
        save: true,
        color: 'redBg',
        viewPath: true,
        priority: 0
      },
      info: {
        view: true,
        save: true,
        color: 'blueBg',
        viewPath: true,
        priority: 3
      },
      saves: {
        view: true,
        save: true,
        color: 'cyanBg',
        viewPath: true,
        priority: 4
      }
    }
  }
};
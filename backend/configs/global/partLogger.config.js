exports.introduceToLoader = {
  config: {
    global: {
      dirName: './logs',
      levels: {
        error: 10,
        warn: 20,
        event: 30,
        info: 30,
        debug: 40,
        trace: 50,
      },
    }
  }
};
exports.introduceToLoader = {
  config: {
    instance: {
      auth: {
        user: process.env.PART_AUTH_USERNAME,
        pass: process.env.PART_AUTH_PASS
      }
    }
  }
};
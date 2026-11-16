exports.introduceToLoader = {
  config: {
    global: {
      gatewayEnable: process.env.PART_AUTH_GATEWAY_ENABLE === 'true',
      host: process.env.PART_AUTH_HOST || 'authentication.partdp.ir',
      protocol: process.env.PART_AUTH_PROTOCOL || 'http',
      port: Number(process.env.PART_AUTH_PORT || 80),
    }
  }
};

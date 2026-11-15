module.exports={
  global: {
    gatewayEnable: false,
    host: 'samad-v8-dev.partdp.ir', // دامنه‌ی سرویس از طریق گیت‌وی
    protocol: 'http',
    port: 80,
    partLoggerConfig: require('./partLoggerConfig'),
    // partRedisInterfaceConfig: {
    //     global: {
    //         partLoggerConfig: partLoggerConfig
    //     },
    //     instance: {
    //         host: '127.0.0.1',
    //         port: 6379,
    //         db: 5,
    //         // clientOptions: {
    //         //   password: 'sardgh'
    //         // },
    //         log: {
    //             view: true,
    //             save: true
    //         }
    //     }
    // }
  },
  instance: {
    cacheTtl: 60 * 60 * 1000,// مدت زمان نگهداری cache
    auth: { // نام کاربری و پسورد برای دریافت توکن از گیت‌وی
      user: 'test',
      pass: 'test'
    }
  }
};
module.exports= {
  global: {
    partLoggerConfig: require('../dependencies/partLoggerConfig')
  },
  instance: {
    directory: 'test/uploads', // محل ذخیره کردن فایل آپلود شده,
    fileSize: 200000000,// حداکثر سایز فایل بر حسب بایت
    fileLimit: 10
  }
};
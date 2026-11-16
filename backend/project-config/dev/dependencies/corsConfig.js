module.exports = {
  enabled: true,
  optionsSuccessStatus: 204,
  // '\/service\/myService\/[A-Za-z0-9]+': {
  //   option : {
  //     //pre-flight-header
  //     'Access-Control-Allow-Credentials' : '*',
  //   },
  //   static : {
  //     'Access-Control-Allow-Origin' : 'https/foo.ir'
  //   },
  //   'Access-Control-Request-Method': 'POST'
  // },
  '/service/myService/myServiceApi': {
    static: {
      'Access-Control-Allow-Origin': 'https/foo.ir'
    },
  },
  // or constant path
  '/apps/CORS/allowed-method': {
    // if we dose not use 'static' or 'option' we mean "both" of them
  },
};
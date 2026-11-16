module.exports = {
  name: 'userProfile-controller',
  path: './main.js',
  exception: {
    handler: require('./exceptions/userProfileException')
  },
  handlers: {
    signUp: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data','_trackingHeaders'],
    },
    getInfo: {
      needProtocolRef: false,
      params: ['_session', '_trackingHeaders']
    },
    updateInfo: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_trackingHeaders', '_session']
    },
    login: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_trackingHeaders', '_session']
    },
    logout: {
      needProtocolRef: false,
      params: ['_session', '_protocolRef.response']
    },
    http_sendStream: {
      needProtocolRef: false,
      params: ['_protocolRef.request','_protocolRef.response','_inputData'],
    }
  }
};



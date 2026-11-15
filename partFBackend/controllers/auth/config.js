module.exports = {
  name: 'my-controller',
  path: './main.js',
  handlers: {
    register: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders'
      ],
    },
    login: {
      needProtocolRef: false,
      params: ['_protocolRef.request.postData']
    },
    http_sendStream: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request',
        '_protocolRef.response',
        '_inputData'
      ],
    }
  }
};   

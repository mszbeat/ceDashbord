module.exports = {
  name: 'auth-controller',
  path: './main.js',
  handlers: {
    register: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session'
      ],
    },
    login: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session'
      ],
    },
    removeUser: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
        '_session'
      ],
    },
  },
};

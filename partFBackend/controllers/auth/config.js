module.exports = {
  name: 'auth-controller',
  path: './main.js',
  handlers: {
    register: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
      ],
    },
    login: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
      ],
    },
    removeUser: {
      needProtocolRef: false,
      params: [
        '_protocolRef.request.postData',
        '_trackingHeaders',
      ],
    },
  },
};

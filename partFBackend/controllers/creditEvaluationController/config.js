module.exports = {
  name: 'credit-evaluation-controller',
  path: './',
  handlers: {
    sample: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
    },
  },
};

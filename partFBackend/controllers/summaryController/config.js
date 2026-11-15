module.exports = {
  name: 'summary-controller',
  path: './',
  handlers: {
    health: {
      needProtocolRef: false,
      params: [],
    },
    banks: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    specs: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    report: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    diagnostics: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    summary: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    list: {
      needProtocolRef: false,
      params: ['_protocolRef.request.queryString', '_protocolRef.response'],
    },
    runs: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
  },
};

module.exports = {
  name: 'admin-controller',
  path: './',
  handlers: {
    getOverview: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    getCron: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    updateCron: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_protocolRef.response'],
    },
    runCronNow: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    checkExisting: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_protocolRef.response'],
    },
    startRun: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_protocolRef.response'],
    },
    listJobs: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    getJob: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
    },
    runAdminDay: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_protocolRef.response'],
    },
    run: {
      needProtocolRef: false,
      params: ['_protocolRef.request.data', '_protocolRef.response'],
    },
  },
};

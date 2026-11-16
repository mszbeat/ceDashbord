module.exports = {
  name: 'employee-controller',
  path: './main.js',
  exception:{
    handler:require('./exceptions/employeeException')
  },
  handlers: {
    getEmployees: {
      needProtocolRef: false,
      params: [
        '_session',
      ],
    },
    addEmployee: {
      needProtocolRef: false,
      params: [
        '_session',
        '_protocolRef.request.data',
      ],
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

const config = {
  url: {
    url: 'creditevaluation-v2.ara.partdp.ir/creditEvaluation@2/report',
    protocol: 'http',
    method: 'GET',
    params: {
      page: null,
      limit:50,
      status: null,
      date: null,
      nationalCode: null,
      requestId: null,
      uniqueKey: null
    },
  },
  headers:{
    'gateway-system': 'creditEvaluation',
    'gateway-token': '*****'
  },
  count: null,
  all: true,
  nationalCode: null,
  uniqueKey: null,
  requestId: null,
  date: ['1405/08/10', '1405/08/10'],
  filterKey: 'date'
};

module.exports = config;
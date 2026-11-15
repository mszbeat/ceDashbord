'use strict';
const { getServices } = require('../../services/container');
const {
  extractRouteParam,
  extractClientMeta,
  runJsonHandler,
} = require('../../services/http-adapter');

exports.sample = function (request, response, inputData) {
  return runJsonHandler(
    response,
    () => {
      const requestId = extractRouteParam(request, inputData, 'requestId', /\/api\/sample\/([^/?#]+)/);
      const clientMeta = extractClientMeta(request);
      return getServices().summary.sample(requestId, clientMeta);
    },
    { noStore: true },
  );
};

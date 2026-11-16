'use strict';
const { getServices } = require('../../services/container');
const {
  extractRouteParam,
  extractClientMeta,
  runJsonHandler,
} = require('../../services/http-adapter');
const { error: ceError } = require('./config');

exports.sample = function (request, response, inputData) {
  return runJsonHandler(
    response,
    () => {
      const requestId = extractRouteParam(request, inputData, 'requestId', /\/api\/sample\/([^/?#]+)/);
      if (!requestId) {
        throw ceError.requestIdRequired;
      }
      const clientMeta = extractClientMeta(request);
      return getServices().summary.sample(requestId, clientMeta);
    },
    { noStore: true },
  );
};

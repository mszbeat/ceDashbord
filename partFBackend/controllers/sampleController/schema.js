// Input validation schemas, one export per handler name.
// Keys here must match the handler's method name exactly — a mismatched
// name is silently ignored, not an error, so it's an easy typo to miss.
exports.httpGet = function () {
  return {
    header: {},
    params: {},
    queryString: {
      name: {}
    }
  };
};

exports.httpGetWithNext = function () {
  return {
    header: {},
    params: {},
    queryString: {}
  };
};

'use strict';

exports.sample = {
  header: {},
  params: {
    requestId: {
      type: 'string',
      minLength: 1,
      errorMessages: {
        type: 'requestId must be a string',
        minLength: 'requestId is required',
      },
    },
  },
  queryString: {},
};

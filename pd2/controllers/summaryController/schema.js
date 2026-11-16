'use strict';

const bankEnum = ['tavan_mellat', 'tavan_resalat', 'tavan_postbank'];

const bankQuery = {
  bank: {
    type: 'string',
    enum: bankEnum,
    errorMessages: {
      type: 'bank must be a string',
      enum: 'bank must be one of tavan_mellat | tavan_resalat | tavan_postbank',
    },
  },
  from: {
    type: 'string',
    errorMessages: { type: 'from must be a jalali date string (YYYY-MM-DD)' },
  },
  to: {
    type: 'string',
    errorMessages: { type: 'to must be a jalali date string (YYYY-MM-DD)' },
  },
};

exports.health = { header: {}, params: {}, queryString: {} };

exports.banks = { header: {}, params: {}, queryString: {} };

exports.specs = { header: {}, params: {}, queryString: { bank: bankQuery.bank } };

exports.report = {
  header: {},
  params: {},
  queryString: {
    ...bankQuery,
    rowsCap: { type: 'string', errorMessages: { type: 'rowsCap must be numeric string' } },
  },
};

exports.diagnostics = { header: {}, params: {}, queryString: {} };

exports.summary = { header: {}, params: {}, queryString: { ...bankQuery } };

exports.list = {
  header: {},
  params: {},
  queryString: {
    ...bankQuery,
    indicator: { type: 'string', errorMessages: { type: 'indicator must be a string' } },
    type: { type: 'string', errorMessages: { type: 'type must be a string' } },
    id: { type: 'string', errorMessages: { type: 'id must be a string' } },
    value: { type: 'string', errorMessages: { type: 'value must be a string' } },
    status: { type: 'string', errorMessages: { type: 'status must be a string' } },
    limit: { type: 'string', errorMessages: { type: 'limit must be numeric string' } },
    offset: { type: 'string', errorMessages: { type: 'offset must be numeric string' } },
  },
};

exports.runs = { header: {}, params: {}, queryString: {} };

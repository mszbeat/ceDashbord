'use strict';

const daySchema = {
  type: 'string',
  pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  errorMessages: {
    type: 'day must be a jalali date string (YYYY-MM-DD)',
    pattern: 'day must have the YYYY-MM-DD format',
  },
};

const banksSchema = {
  type: 'array',
  items: { type: 'string', enum: ['tavan_mellat', 'tavan_resalat', 'tavan_postbank'] },
  errorMessages: { type: 'banks must be an array of supported bank keys' },
};

const filtersSchema = {
  type: 'object',
  properties: {
    requestId: { type: 'string', errorMessages: { type: 'requestId must be a string' } },
    uniqueKey: { type: 'string', errorMessages: { type: 'uniqueKey must be a string' } },
    nationalCode: { type: 'string', errorMessages: { type: 'nationalCode must be a string' } },
    status: { type: 'string', errorMessages: { type: 'status must be a string' } },
    maxCount: { type: 'number', errorMessages: { type: 'maxCount must be a number' } },
    pageSize: { type: 'number', errorMessages: { type: 'pageSize must be a number' } },
  },
  additionalProperties: false,
};

exports.getOverview = { header: {}, params: {}, queryString: {} };

exports.getCron = { header: {}, params: {}, queryString: {} };

exports.updateCron = {
  body: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', errorMessages: { type: 'enabled must be boolean' } },
      schedule_mode: {
        type: 'string',
        enum: ['daily', 'cron'],
        errorMessages: { type: 'schedule_mode must be daily or cron', enum: 'schedule_mode must be daily or cron' },
      },
      hour: { type: 'number', errorMessages: { type: 'hour must be a number' } },
      minute: { type: 'number', errorMessages: { type: 'minute must be a number' } },
      cron_expr: { type: 'string', errorMessages: { type: 'cron_expr must be a string' } },
      target_offset_days: { type: 'number', errorMessages: { type: 'target_offset_days must be a number' } },
      rebuild: { type: 'boolean', errorMessages: { type: 'rebuild must be boolean' } },
      banks: banksSchema,
    },
    additionalProperties: false,
  },
};

exports.runCronNow = { header: {}, params: {}, queryString: {}, body: {} };

exports.checkExisting = {
  body: {
    type: 'object',
    properties: {
      banks: banksSchema,
      dateScope: {
        type: 'string',
        enum: ['single', 'range', 'filter_only'],
        errorMessages: { type: 'dateScope must be single | range | filter_only' },
      },
      day: daySchema,
      fromDay: daySchema,
      toDay: daySchema,
      filters: filtersSchema,
    },
    additionalProperties: false,
  },
};

exports.startRun = {
  body: {
    type: 'object',
    properties: {
      banks: banksSchema,
      dateScope: {
        type: 'string',
        enum: ['single', 'range', 'filter_only'],
        errorMessages: { type: 'dateScope must be single | range | filter_only' },
      },
      day: daySchema,
      fromDay: daySchema,
      toDay: daySchema,
      mode: {
        type: 'string',
        enum: ['nightly', 'intraday'],
        errorMessages: { type: 'mode must be nightly or intraday' },
      },
      conflictStrategy: {
        type: 'string',
        enum: ['upsert', 'rebuild'],
        errorMessages: { type: 'conflictStrategy must be upsert or rebuild' },
      },
      confirmedConflict: { type: 'boolean', errorMessages: { type: 'confirmedConflict must be boolean' } },
      filters: filtersSchema,
    },
    additionalProperties: false,
  },
};

exports.listJobs = { header: {}, params: {}, queryString: {} };

exports.getJob = {
  header: {},
  params: {
    id: {
      type: 'string',
      minLength: 1,
      errorMessages: { type: 'id must be a string', minLength: 'id is required' },
    },
  },
  queryString: {},
};

exports.runAdminDay = {
  body: {
    type: 'object',
    properties: {
      bank: {
        type: 'string',
        enum: ['tavan_mellat', 'tavan_resalat', 'tavan_postbank'],
        errorMessages: { type: 'bank must be a supported bank key' },
      },
      day: daySchema,
      mode: {
        type: 'string',
        enum: ['nightly', 'intraday'],
        errorMessages: { type: 'mode must be nightly or intraday' },
      },
      rebuild: { type: 'boolean', errorMessages: { type: 'rebuild must be boolean' } },
      filters: filtersSchema,
    },
    additionalProperties: false,
  },
};

exports.run = exports.runAdminDay;

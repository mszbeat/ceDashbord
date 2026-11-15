'use strict';
const { getServices } = require('../../services/container');
const { getBody, BadRequestError, runJsonHandler } = require('../../services/http-adapter');
const { tehranToday, tehranYesterday } = require('../../services/utils/date');

exports.run = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    const body = getBody(protocolRef);
    const mode = body.mode === 'intraday' ? 'intraday' : 'nightly';
    const rebuild = body.rebuild === true;
    if (rebuild && !body.day) {
      throw new BadRequestError('rebuild نیاز به day صریح دارد.');
    }
    const day = body.day ?? (mode === 'nightly' ? tehranYesterday() : tehranToday());
    return getServices().ingestion.runDay(body.bank ?? 'tavan_mellat', day, mode, {
      rebuild,
      filters: body.filters,
    });
  });
};

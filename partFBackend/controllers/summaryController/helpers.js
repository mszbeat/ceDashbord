'use strict';
const { getServices } = require('../../services/container');
const {
  normalizeQuery,
  sendHtml,
  runJsonHandler,
} = require('../../services/http-adapter');

exports.health = function () {
  return {
    ok: true,
    service: 'ce-dashboard-partframework',
    framework: 'partFramework',
    time: new Date().toISOString(),
  };
};

exports.banks = function (response) {
  return runJsonHandler(response, async () => getServices().summary.banks());
};

exports.specs = function (queryString, response) {
  return runJsonHandler(response, async () => {
    const q = normalizeQuery(queryString);
    return getServices().summary.specs(q.bank || 'tavan_mellat');
  });
};

exports.report = async function (queryString, response) {
  const q = normalizeQuery(queryString);
  const bank = q.bank || 'tavan_mellat';
  const from = q.from || undefined;
  const to = q.to || undefined;
  const rowsCap = q.rowsCap ? Number(q.rowsCap) : 100;
  try {
    const html = await getServices().summary.report(bank, from, to, rowsCap);
    return sendHtml(response, html, 200);
  } catch (error) {
    const html = getServices().summary.errorHtml(error);
    return sendHtml(response, html, 503);
  }
};

exports.diagnostics = function (response) {
  return runJsonHandler(response, () => getServices().summary.diagnostics(), { noStore: true });
};

exports.summary = function (queryString, response) {
  return runJsonHandler(response, () => {
    const q = normalizeQuery(queryString);
    return getServices().summary.summary(q.bank || 'tavan_mellat', q.from || undefined, q.to || undefined);
  });
};

exports.list = function (queryString, response) {
  return runJsonHandler(response, () => {
    const q = normalizeQuery(queryString);
    return getServices().summary.list({
      bank: q.bank || 'tavan_mellat',
      from: q.from || undefined,
      to: q.to || undefined,
      indicator: q.indicator || undefined,
      type: q.type || undefined,
      id: q.id || undefined,
      value: q.value || undefined,
      status: q.status || undefined,
      limit: q.limit ? Number(q.limit) : undefined,
      offset: q.offset ? Number(q.offset) : undefined,
    });
  });
};

exports.runs = function (response) {
  return runJsonHandler(response, () => getServices().summary.runs());
};

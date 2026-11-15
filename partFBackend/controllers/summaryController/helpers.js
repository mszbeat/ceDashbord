'use strict';
const { getServices } = require('../../services/container');
const {
  getQuery,
  getParams,
  getClientMeta,
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

exports.banks = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => getServices().summary.banks());
};

exports.specs = function (protocolRef) {
  return runJsonHandler(protocolRef, async () => {
    const q = getQuery(protocolRef);
    return getServices().summary.specs(q.bank || 'tavan_mellat');
  });
};

exports.report = async function (protocolRef) {
  const q = getQuery(protocolRef);
  const bank = q.bank || 'tavan_mellat';
  const from = q.from || undefined;
  const to = q.to || undefined;
  const rowsCap = q.rowsCap ? Number(q.rowsCap) : 100;
  try {
    const html = await getServices().summary.report(bank, from, to, rowsCap);
    return sendHtml(protocolRef, html, 200);
  } catch (error) {
    const html = getServices().summary.errorHtml(error);
    return sendHtml(protocolRef, html, 503);
  }
};

exports.diagnostics = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().summary.diagnostics(), { noStore: true });
};

exports.summary = function (protocolRef) {
  return runJsonHandler(protocolRef, () => {
    const q = getQuery(protocolRef);
    return getServices().summary.summary(q.bank || 'tavan_mellat', q.from || undefined, q.to || undefined);
  });
};

exports.list = function (protocolRef) {
  return runJsonHandler(protocolRef, () => {
    const q = getQuery(protocolRef);
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

exports.sample = function (protocolRef) {
  return runJsonHandler(
    protocolRef,
    () => {
      const params = getParams(protocolRef, /\/api\/sample\/([^/?#]+)/, 'requestId');
      const clientMeta = getClientMeta(protocolRef);
      return getServices().summary.sample(String(params.requestId || ''), clientMeta);
    },
    { noStore: true },
  );
};

exports.runs = function (protocolRef) {
  return runJsonHandler(protocolRef, () => getServices().summary.runs());
};

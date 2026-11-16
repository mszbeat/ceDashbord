'use strict';

const { getServices } = require('../../services/container');
const { sendHtml } = require('../../services/http/result');
const { readQuery } = require('../../services/http/request');

/**
 * سطح دسترسی ۱ — کاربر عادی (`visitor`/کاربر عادی):
 * صفحهٔ اول داشبورد، تحلیل‌های کلی، متادیتای بانک‌ها و گزارش HTML زنده.
 */

function getSummaryService() {
  return getServices().summary;
}

exports.health = function () {
  return {
    ok: true,
    service: 'ce-dashboard-pd2',
    framework: 'partFramework@10.2.0',
    time: new Date().toISOString(),
  };
};

exports.banks = function () {
  return getSummaryService().banks();
};

exports.specs = function (queryString) {
  const query = readQuery(queryString);
  return getSummaryService().specs(query.bank || 'tavan_mellat');
};

exports.report = async function (queryString) {
  const query = readQuery(queryString);
  const bank = query.bank || 'tavan_mellat';
  const rowsCap = query.rowsCap ? Number(query.rowsCap) : 100;
  try {
    const html = await getSummaryService().report(bank, query.from || undefined, query.to || undefined, rowsCap);
    return sendHtml(html, 200);
  } catch (err) {
    return sendHtml(getSummaryService().errorHtml(err), 503);
  }
};

exports.diagnostics = function () {
  return getSummaryService().diagnostics();
};

exports.summary = function (queryString) {
  const query = readQuery(queryString);
  return getSummaryService().summary(query.bank || 'tavan_mellat', query.from || undefined, query.to || undefined);
};

exports.list = function (queryString) {
  const query = readQuery(queryString);
  return getSummaryService().list({
    bank: query.bank || 'tavan_mellat',
    from: query.from || undefined,
    to: query.to || undefined,
    indicator: query.indicator || undefined,
    type: query.type || undefined,
    id: query.id || undefined,
    value: query.value || undefined,
    status: query.status || undefined,
    limit: query.limit ? Number(query.limit) : undefined,
    offset: query.offset ? Number(query.offset) : undefined,
  });
};

exports.runs = function () {
  return getSummaryService().runs();
};

'use strict';

const { getServices } = require('../../services/container');
const { sendHtml } = require('../../services/http/result');
const { readQuery } = require('../../services/http/request');
const { requireAuthenticatedSession } = require('../../services/http/session-guard');
const { error: summaryError } = require('./config');

/**
 * سطح دسترسی ۱ — کاربر دارای سشن احرازشده:
 * صفحهٔ اول داشبورد، تحلیل‌های کلی، متادیتای بانک‌ها و گزارش HTML زنده.
 */

function getSummaryService() {
  return getServices().summary;
}

exports.health = function () {
  return {
    ok: true,
    service: 'ce-dashboard-backend',
    framework: 'partFramework',
    time: new Date().toISOString(),
  };
};

exports.banks = async function (session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  return getSummaryService().banks();
};

exports.specs = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  return getSummaryService().specs(query.bank || 'tavan_mellat');
};

exports.report = async function (queryString, response, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  const bank = query.bank || 'tavan_mellat';
  const rowsCap = query.rowsCap ? Number(query.rowsCap) : 100;
  try {
    const html = await getSummaryService().report(bank, query.from || undefined, query.to || undefined, rowsCap);
    return sendHtml(html, 200, response);
  } catch (err) {
    return sendHtml(getSummaryService().errorHtml(err), 503, response);
  }
};

exports.diagnostics = async function (session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  return getSummaryService().diagnostics();
};

exports.summary = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  const query = readQuery(queryString);
  return getSummaryService().summary(query.bank || 'tavan_mellat', query.from || undefined, query.to || undefined);
};

exports.list = async function (queryString, session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
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

exports.runs = async function (session) {
  await requireAuthenticatedSession(session, () => summaryError.sessionRequired);
  return getSummaryService().runs();
};

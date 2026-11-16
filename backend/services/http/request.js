'use strict';

/**
 * ابزارهای خواندن ورودی درایور HTTP فریم‌ورک (`_protocolRef`) برای کنترلرهای
 * `partFramework` 10.2.0 با `needProtocolRef: false`.
 *
 * توکن‌هایی که در `config.js` هر کنترلر استفاده می‌شوند:
 *   - `_session`
 *   - `_trackingHeaders`
 *   - `_inputData`
 *   - `_protocolRef.request`
 *   - `_protocolRef.request.data`
 *   - `_protocolRef.request.queryString`
 *   - `_protocolRef.response`
 */

const METHOD_BODY_KEYS = ['data', 'postData', 'putData', 'patchData', 'body'];

/**
 * بدنهٔ درخواست را از `_protocolRef.request` یا `_protocolRef.request.data` بیرون می‌کشد.
 * هم از بدنهٔ JSON و هم از بدنهٔ رشته‌ای/فرم پشتیبانی می‌کند.
 */
function readBody(requestOrData) {
  if (requestOrData === null || requestOrData === undefined || requestOrData === '') return {};
  if (typeof requestOrData === 'string') {
    const text = requestOrData.trim();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { username: text };
    }
  }
  if (typeof requestOrData !== 'object') return {};

  const isRequestObject = ['url', 'headers', 'method', 'queryString', 'urlParams'].some(
    (key) => key in requestOrData,
  );

  if (isRequestObject) {
    for (const key of METHOD_BODY_KEYS) {
      if (requestOrData[key] !== undefined && requestOrData[key] !== null) {
        const parsed = readBody(requestOrData[key]);
        if (parsed && Object.keys(parsed).length) return parsed;
      }
    }
    return {};
  }

  return requestOrData;
}

/**
 * رشتهٔ کوئری را از `queryString` شیئی یا از `request.url` استخراج می‌کند.
 */
function readQuery(queryStringOrRequest) {
  if (!queryStringOrRequest) return {};
  if (typeof queryStringOrRequest === 'string') {
    const raw = queryStringOrRequest.includes('?')
      ? queryStringOrRequest.slice(queryStringOrRequest.indexOf('?') + 1).split('#')[0]
      : queryStringOrRequest;
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  if (typeof queryStringOrRequest !== 'object') return {};

  // خودِ شیء queryString تزریق شده است (نه request) → همان را برگردان
  const wrapperKeys = ['queryString', 'query', 'url', 'originalUrl', 'headers', 'method'];
  const isRequestObject = wrapperKeys.some((key) => key in queryStringOrRequest);
  if (!isRequestObject) return queryStringOrRequest;

  const direct = queryStringOrRequest.queryString || queryStringOrRequest.query;
  if (direct && typeof direct === 'object') return direct;

  const rawUrl = queryStringOrRequest.url || queryStringOrRequest.originalUrl || '';
  const qIndex = String(rawUrl).indexOf('?');
  if (qIndex >= 0) {
    const raw = String(rawUrl).slice(qIndex + 1).split('#')[0];
    return Object.fromEntries(new URLSearchParams(raw).entries());
  }
  return {};
}

/**
 * پارامتر مسیر (مثل `/api/sample/:requestId`) را از `_inputData.params`،
 * `request.params` یا در نهایت از خود URL بیرون می‌کشد.
 */
function readRouteParam(request, inputData, paramName, fallbackRegex) {
  const candidates = [
    inputData?.params?.[paramName],
    inputData?.urlParams?.[paramName],
    inputData?.[paramName],
    request?.params?.[paramName],
    request?.urlParams?.[paramName],
  ];
  for (const value of candidates) {
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  if (fallbackRegex) {
    const rawUrl = request?.url || request?.originalUrl || request?.path || '';
    const matched = String(rawUrl).match(fallbackRegex);
    if (matched && matched[1]) return decodeURIComponent(matched[1]);
  }
  return '';
}

/**
 * متادیتای کلاینت (IP و هدرها) برای ثبت در گزارش‌ها.
 */
function readClientMeta(requestOrInputData) {
  const request = requestOrInputData?.request || requestOrInputData || {};
  const headers = request.headers || request.header || {};
  const forwarded = headers['x-forwarded-for'];
  const ip =
    request.ip ||
    (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : null) ||
    request.socket?.remoteAddress ||
    request.connection?.remoteAddress ||
    null;
  return { ip, headers };
}

module.exports = {
  readBody,
  readQuery,
  readRouteParam,
  readClientMeta,
};

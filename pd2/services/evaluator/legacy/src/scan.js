'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { get, own } = require('../banks/_helpers');
const { SERVICE_FA, toText } = require('./common');
const { autoBank } = require('./banks');

const STATUSES = ['success', 'fail'];
const methodOf = (sample) => toText(get(sample, 'input.method')).trim().toLowerCase();
const isSample = (sample) => sample !== null && typeof sample === 'object' && !Array.isArray(sample);
const asSamples = (parsed) => Array.isArray(parsed) ? parsed : [parsed];

function parseFile(file) { return asSamples(JSON.parse(fs.readFileSync(file, 'utf8'))); }
function scan(root, banks) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`پوشهٔ ورودی یافت نشد: ${root}`);
  const days = fs.readdirSync(root, { withFileTypes: true })
    .filter((item) => item.isDirectory() && STATUSES.some((status) => {
      const folder = path.join(root, item.name, status);
      return fs.existsSync(folder) && fs.statSync(folder).isDirectory();
    }))
    .map((item) => item.name).sort();
  const files = [], errors = [], methodCounts = new Map(), labels = new Map(), serviceKeys = new Map();
  let totalSamples = 0, invalidSamples = 0;
  for (const day of days) for (const status of STATUSES) {
    const dir = path.join(root, day, status);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const filename of fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json')).sort()) {
      const full = path.join(dir, filename), relative = path.join(day, status, filename);
      let samples;
      try { samples = parseFile(full); }
      catch (error) { errors.push({ file: relative, error: error.message }); continue; }
      const counts = new Map();
      for (const sample of samples) {
        totalSamples++;
        if (!isSample(sample)) { invalidSamples++; continue; }
        const method = methodOf(sample);
        counts.set(method, (counts.get(method) || 0) + 1);
        methodCounts.set(method, (methodCounts.get(method) || 0) + 1);
        if (!labels.has(method)) labels.set(method, toText(get(sample, 'input.method')).trim());
        const input = sample.ai_input;
        if (input && typeof input === 'object' && !Array.isArray(input)) {
          const keys = serviceKeys.get(method) || new Set();
          for (const [key, value] of Object.entries(input)) {
            if (own(SERVICE_FA, key) || (value && typeof value === 'object' && own(value, 'status'))) keys.add(key);
          }
          serviceKeys.set(method, keys);
        }
      }
      files.push({ full, relative, filename, day, status, counts });
    }
  }
  const ranked = [...methodCounts.keys()].sort((a, b) => methodCounts.get(b) - methodCounts.get(a) || a.localeCompare(b));
  const selectedMethod = ranked[0];
  const bank = selectedMethod === undefined ? null : (banks[selectedMethod] || autoBank(labels.get(selectedMethod)));
  const selectedFiles = selectedMethod === undefined ? [] : files.filter((f) => f.counts.has(selectedMethod));
  const selectedDays = [...new Set(selectedFiles.map((f) => f.day))].sort();
  const selectedServices = bank ? [...new Set([...(serviceKeys.get(selectedMethod) || []), ...bank.expectedServices])].sort() : [];
  const ignoredRows = ranked.slice(1).map((key) => ({
    'input.method': labels.get(key) || '(ثبت نشده)',
    'نوع تحلیل': banks[key] ? banks[key].label : 'گزارش عمومی', 'تعداد گزارش': methodCounts.get(key),
  }));
  return { root, days, files, errors, totalSamples, invalidSamples, methodCounts, selectedMethod,
    bank, selectedFiles, selectedDays, selectedServices, ignoredRows };
}
module.exports = { scan, parseFile, methodOf, isSample, STATUSES };

/* تست تطبیق M0/M1: خروجی ارزیاب کتابخانهای با analyzeOne قدیمی همخوانی دارد. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { EvaluatorService } from './evaluator.service';

const sample = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'test-data/mellat-sample.json'), 'utf8'),
);
const service = new EvaluatorService();
const normalized = service.normalizeSample(sample);
const isSuccess = service.isReportSuccess(normalized);
const row = service.evaluate(normalized, isSuccess, '1405-08-18');

assert.equal(isSuccess, true, 'پیام موفق باید شناسایی شود');
assert.equal(row.request_id, sample.requestId, 'requestId حفظ شود');
assert.equal(row.pd, 0.5, 'PD خام بدون گرد کردن ذخیره شود');
assert.equal(row.total_time_s, 0.04, 'زمان اجرای مدل از metrics قدیمی خوانده شود');
assert.equal(Object.values(row.flags).filter(Boolean).length, 10, 'تعداد فلگهای فعال ملت');
assert.equal(row.services.iran, 'failed', 'وضعیت سرویس رتبهبندی');
assert.ok(row.cats.messageSuccess?.startsWith('MSG_'), 'متن آزاد پیام نباید ذخیره شود');
assert.ok(!JSON.stringify(row).includes('اطلاعات تاریخچه'), 'هیچ متن آزاد پیامی در ردیف نباشد');
assert.ok(!JSON.stringify(row).includes('nationalCode'), 'کد ملی ذخیره نشود');
assert.equal(row.analysis_version, 'mellat-1.0.0');

console.log('✅ evaluator parity test passed:', {
  requestId: row.request_id, flags: Object.values(row.flags).filter(Boolean).length,
  metrics: Object.keys(row.metrics).length, cats: Object.keys(row.cats).length,
  paths: Object.keys(row.paths).length, services: Object.keys(row.services).length,
});

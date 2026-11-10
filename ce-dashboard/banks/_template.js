'use strict';
/**
 * راهنمای افزودن بانک:
 * این فایل را با نام بانک جدید (بدون زیرخط آغازین) کپی کنید.
 * شناسهٔ id باید با input.method گزارش‌ها مطابق باشد (حروف بزرگ/کوچک اهمیتی ندارد).
 * شاخص‌های مشترک خروجی مدل و وضعیت سرویس‌ها به‌صورت خودکار افزوده می‌شوند.
 * تحلیل فقط برای بانکی با بیشترین گزارش معتبر در ورودی انجام می‌شود.
 * قرارداد کامل‌تر و مثال اجرای آزمایش‌ها در README.md آمده است.
 */
const { get, isFullList, isRotbeNullData } = require('./_helpers');

module.exports = function createBank({ minNull = 3 } = {}) {
  return {
    id: 'tavan_newbank',
    label: 'بانک جدید',
    rootLabel: 'input.data.collectedData',
    collected: (sample) => get(sample, 'input.data.collectedData'),
    // برای افزودن جدول بدهی معوق و چک برگشتی، مسیرهای ساختاریافتهٔ این بانک را تعیین کنید:
    // creditSources: { facilities: (c) => get(c, 'samatFacilities.TashilatItem'),
    //   cheques: (c) => get(c, 'samatCheque.chequeList') },
    rotbePath: 'input.data.collectedData.rotbebandiStandard.data',
    // حتی اگر سرویس در هیچ گزارشی حاضر نباشد، غیبت آن گزارش شود:
    expectedServices: ['iran'],
    topics: [{ id: 'quality', icon: '◈', label: 'کنترل کیفیت', desc: 'کامل بودن داده‌های این بانک' }],
    paths: ['samatFacilities', 'historicalLoans'],
    flags: [
      { id: 'rotbeNull', topic: 'quality', label: 'رتبه‌بندی فاقد داده است', daily: true,
        test: (collected) => isRotbeNullData(get(collected, 'rotbebandiStandard.data'), minNull) },
      { id: 'loansFull', topic: 'quality', label: 'سوابق وام موجود است',
        test: (collected) => isFullList(get(collected, 'historicalLoans')) },
    ],
    categories: [],
    counters: [],
    metrics: [],
    cross: [],
    lists: [{ title: 'رتبه‌بندی فاقد داده', when: (flags) => flags.rotbeNull,
      row: () => ({}) }],
    // summaryCols: (sample) => ({ PD: ..., ... }),
    // viewer: (collected, sample) => ({ cards: [['عنوان', 'مقدار', 'hot']], tables: [] }),
    // sanitizeSample: (sample) => گزارش بدون فیلدهای حساس/غیرضروری,
  };
};

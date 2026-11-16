const { createErrorInfo } = require('../../services/error-info');
const errorInfo = createErrorInfo(require('./package.json'));

module.exports = {
  name: 'admin-controller',
  path: './',
  handlers: {
    getOverview: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    getCron: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    updateCron: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response'],
    },
    runCronNow: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    checkExisting: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response'],
    },
    startRun: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response'],
    },
    listJobs: {
      needProtocolRef: false,
      params: ['_protocolRef.response'],
    },
    getJob: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response', '_inputData'],
    },
    runAdminDay: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response'],
    },
    run: {
      needProtocolRef: false,
      params: ['_protocolRef.request', '_protocolRef.response'],
    },
  },
  error: {
    rebuildRequiresExplicitDay: {
      meta: errorInfo('rebuildRequiresExplicitDay'),
      data: {
        message: {
          fa: 'rebuild نیاز به day صریح دارد.',
          en: 'rebuild requires an explicit day',
        },
      },
      statusCode: 400,
    },
    emptyRebuildAborted: function (day) {
      return {
        meta: errorInfo('emptyRebuildAborted'),
        data: {
          message: {
            fa: `عملیات بازسازی (rebuild) لغو شد: سرویس مبدا برای ${day} هیچ رکوردی برنگرداند؛ دادههای موجود دستنخورده ماندند.`,
            en: 'rebuild aborted because upstream returned zero records for target day',
          },
          additionalInfo: { day },
        },
        statusCode: 409,
      };
    },
    bankSelectionRequired: {
      meta: errorInfo('bankSelectionRequired'),
      data: {
        message: {
          fa: 'حداقل یک بانک باید انتخاب شود.',
          en: 'at least one bank must be selected',
        },
      },
      statusCode: 400,
    },
    invalidBank: function (bank) {
      return {
        meta: errorInfo('invalidBank'),
        data: {
          message: {
            fa: `بانک نامعتبر است: ${bank}`,
            en: 'invalid bank',
          },
          additionalInfo: { bank },
        },
        statusCode: 400,
      };
    },
    invalidNationalCode: {
      meta: errorInfo('invalidNationalCode'),
      data: {
        message: {
          fa: 'کد ملی واردشده معتبر نیست (باید فقط رقم و بین ۸ تا ۱۲ کاراکتر باشد).',
          en: 'invalid nationalCode format',
        },
      },
      statusCode: 400,
    },
    invalidMaxCount: {
      meta: errorInfo('invalidMaxCount'),
      data: {
        message: {
          fa: 'سقف تعداد رکورد (maxCount) باید عددی صحیح بین ۱ تا ۵۰۰٬۰۰۰ باشد.',
          en: 'maxCount must be an integer between 1 and 500000',
        },
      },
      statusCode: 400,
    },
    invalidPageSize: {
      meta: errorInfo('invalidPageSize'),
      data: {
        message: {
          fa: 'اندازهٔ صفحه (pageSize) باید عددی صحیح بین ۱ تا ۲۰۰ باشد.',
          en: 'pageSize must be an integer between 1 and 200',
        },
      },
      statusCode: 400,
    },
    filterRequiredWithoutDate: {
      meta: errorInfo('filterRequiredWithoutDate'),
      data: {
        message: {
          fa: 'در حالت «بدون قید تاریخ»، حداقل یکی از فیلترهای شناسهٔ درخواست (requestId)، کلید یکتا (uniqueKey) یا کد ملی الزامی است.',
          en: 'at least one lookup filter is required in filter_only mode',
        },
      },
      statusCode: 400,
    },
    incompleteDateRange: {
      meta: errorInfo('incompleteDateRange'),
      data: {
        message: {
          fa: 'بازهٔ تاریخ ناقص است؛ هر دو فیلد «از تاریخ» و «تا تاریخ» الزامی‌اند.',
          en: 'both fromDay and toDay are required for range scope',
        },
      },
      statusCode: 400,
    },
    invalidDateInput: function (additionalInfo) {
      return {
        meta: errorInfo('invalidDateInput'),
        data: {
          message: {
            fa: typeof additionalInfo === 'string' && additionalInfo ? additionalInfo : 'تاریخ واردشده معتبر نیست.',
            en: 'invalid jalali date input',
          },
          additionalInfo,
        },
        statusCode: 400,
      };
    },
    invalidCronHour: {
      meta: errorInfo('invalidCronHour'),
      data: {
        message: {
          fa: 'ساعت اجرای کران باید عددی صحیح بین ۰ تا ۲۳ باشد.',
          en: 'cron hour must be an integer between 0 and 23',
        },
      },
      statusCode: 400,
    },
    invalidCronMinute: {
      meta: errorInfo('invalidCronMinute'),
      data: {
        message: {
          fa: 'دقیقهٔ اجرای کران باید عددی صحیح بین ۰ تا ۵۹ باشد.',
          en: 'cron minute must be an integer between 0 and 59',
        },
      },
      statusCode: 400,
    },
    invalidCronExpression: function (additionalInfo) {
      return {
        meta: errorInfo('invalidCronExpression'),
        data: {
          message: {
            fa: typeof additionalInfo === 'string' && additionalInfo ? additionalInfo : 'عبارت کران معتبر نیست.',
            en: 'invalid cron expression',
          },
          additionalInfo,
        },
        statusCode: 400,
      };
    },
    invalidCronOffsetDays: {
      meta: errorInfo('invalidCronOffsetDays'),
      data: {
        message: {
          fa: 'فاصلهٔ روز هدف کران (target_offset_days) باید بین ۰ تا ۳۰ روز باشد.',
          en: 'target_offset_days must be between 0 and 30',
        },
      },
      statusCode: 400,
    },
    rebuildRequiresDate: {
      meta: errorInfo('rebuildRequiresDate'),
      data: {
        message: {
          fa: 'حالت بازسازی کامل (Rebuild) نیازمند انتخاب روز یا بازهٔ تاریخ مشخص است.',
          en: 'rebuild strategy requires a specific day or date range',
        },
      },
      statusCode: 400,
    },
    existingDataConflict: function (check) {
      return {
        meta: errorInfo('EXISTING_DATA_CONFLICT'),
        data: {
          code: 'EXISTING_DATA_CONFLICT',
          message: {
            fa: 'برای بانک/روز انتخاب‌شده دادهٔ قبلی در دیتابیس وجود دارد؛ لطفاً نوع عملیات (Rebuild یا Upsert) را مشخص کنید.',
            en: 'existing data found for target bank/day; select Rebuild or Upsert',
          },
          check,
        },
        statusCode: 400,
      };
    },
    jobNotFound: function (jobId) {
      return {
        meta: errorInfo('jobNotFound'),
        data: {
          message: {
            fa: `جاب مورد نظر یافت نشد: ${jobId}`,
            en: 'job not found',
          },
          additionalInfo: { jobId },
        },
        statusCode: 404,
      };
    },
    creditEvaluationBaseServiceError: function (additionalInfo) {
      return {
        meta: errorInfo('creditEvaluationBaseServiceError'),
        data: {
          message: {
            fa: 'خطای سرویس پایه اعتبارسنجی هنگام دریافت گزارش‌ها',
            en: 'credit evaluation upstream service error',
          },
          additionalInfo,
        },
        statusCode: 503,
      };
    },
    internalServerError: function (additionalInfo) {
      return {
        meta: errorInfo('internalServerError'),
        data: {
          message: {
            fa: 'خطای داخلی سرور، لطفا بعدا مجددا تلاش نمایید',
            en: 'Internal server error',
          },
          additionalInfo,
        },
        statusCode: 500,
      };
    },
  },
};

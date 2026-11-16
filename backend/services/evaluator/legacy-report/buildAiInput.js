const { keyMapMellat, keyMapResalat, keyMapPostbank, keyMapSepah } = require('./aiInputKeyMaps');

/**
 * سازنده‌ی داده‌ی ورودی نرمال‌شده برای سرویس هوش مصنوعی امتیازدهی/تسهیلات،
 * چه از یک آبجکت از پیش شکل‌گرفته و چه از یک گزارش خام بانکی.
 */
class BuildAiInput {
  static #instance;

  constructor() {
    if (BuildAiInput.#instance) {
      BuildAiInput.#instance = this;
    }
  }

  static getInstance() {
    if (!BuildAiInput.#instance) {
      BuildAiInput.#instance = new BuildAiInput();
    }
    return BuildAiInput.#instance;
  }

  /**
   * ساخت ورودی هوش مصنوعی از یک داده‌ی از پیش شکل‌گرفته (نه گزارش خام بانکی).
   * @param {object} input - داده‌ی ورودی هوش مصنوعی که از قبل ساختار مناسب دارد.
   * @param {string} requestId - شناسه‌ی درخواست.
   * @param {string} serviceName - نام سرویس.
   * @returns {object} ورودی هوش مصنوعی نرمال‌شده.
   */
  buildFromInput(input, requestId, serviceName) {
    const aiInput = this.#normalizeFields(structuredClone(input));
    aiInput.requestId = requestId;
    aiInput.serviceName = serviceName;
    return aiInput;
  }

  /**
   * ساخت ورودی هوش مصنوعی از یک گزارش خام بانکی، با استخراج و نگاشت
   * فیلدها بر اساس متد (نوع بانک) گزارش.
   * @param {object} report - گزارش خام بانکی.
   * @returns {object|undefined} ورودی نهایی هوش مصنوعی، یا undefined در صورت شکست ساخت.
   */
  buildFromReport(report) {
    try {
      if (report.input?.bankInput) {
        report.input = report.input.bankInput;
      }

      const method = report.input.method;
      const handler = this.#METHOD_HANDLERS[method];
      if (!handler) {
        throw new Error(`Unsupported report method: ${method}`);
      }

      let aiInput = this.#extractAiInputForMethod(report, handler);
      aiInput = this.#normalizeFields(aiInput);

      aiInput.current_loan = {
        date_granted: report.insertDate_yearMonthDay,
        national_code: report.input?.data?.nationalCode ?? null,
      };
      aiInput.requestId = report.requestId;
      aiInput.serviceName = handler.serviceName;

      return this.finalizeAiInputStructure(aiInput);
    }
    catch (err) {
      console.error(`Failed to build AI input from report. error: ${err}`);
    }
  }

  /**
   * پوشاندن فیلدهای مشخصی از ورودی هوش مصنوعی در ساختار `{ status, data }`
   * تا مصرف‌کننده بتواند داده‌ی معتبر را از داده‌ی گمشده/نامعتبر تشخیص دهد.
   * @param {object} aiInput
   * @returns {object} aiInput با فیلدهای پوشانده‌شده.
   */
  finalizeAiInputStructure(aiInput) {
    aiInput.iran = aiInput.iran?.directContracts
      && aiInput.iran?.contractNegativeStatus
      ? aiInput.iran : {};
    aiInput.iran = this.#wrapField(
      aiInput.iran,
      {},
      (value) => {
        return value && typeof value === 'object' && value?.directContracts;
      }
    );

    for (const field of ['historical_loans', 'averageDeposit', 'chequeList']) {
      aiInput[field] = this.#wrapField(aiInput[field], [], Array.isArray);
    }

    aiInput.EstelamAsliRows = this.#wrapEstelamAsliRows(aiInput.EstelamAsliRows);

    return aiInput;
  }


  /**
   * تنظیمات مربوط به هر متد (نوع بانک) پشتیبانی‌شده:
   * - serviceName: شناسه استاندارد سرویس که برای سرویس هوش مصنوعی ارسال می‌شود
   * - keyMap: نگاشت کلیدهای خام داده جمع‌آوری‌شده به کلیدهای مورد انتظار هوش مصنوعی
   * - extractCollectedData: استخراج آبجکت خام "collectedData" از گزارش،
   *   همراه با پیش‌پردازش‌های مخصوص هر بانک (مثلاً حذف فیلدهای خطا)
   */
  #METHOD_HANDLERS = {
    tavan_mellat: {
      serviceName: 'tavan-mellat',
      keyMap: keyMapMellat,
      extractCollectedData: (report) => {
        return report.input?.data ?? null;
      },
    },
    tavan_resalat: {
      serviceName: 'tavan-resalat',
      keyMap: keyMapResalat,
      extractCollectedData: (report) => {
        const data = report.input?.data?.collectedData ?? report?.collectedData;
        if (!data) return null;
        const { meratInformation, meratInformationError, ...collectedData } = data;
        return collectedData;
      },
    },
    tavan_postBank: {
      serviceName: 'tavan-postbank',
      keyMap: keyMapPostbank,
      extractCollectedData: (report) => {
        return report.collectedData ?? null;
      },
    },
    tavan_sepah: {
      serviceName: 'tavan-sepah',
      keyMap: keyMapSepah,
      extractCollectedData: (report) => {
        if (!report.collectedData) return null;
        const { rotbebandiScoreResult, rotbebandiScoreError, ...collectedData } = report.collectedData;
        return collectedData;
      },
    },
  };


  /**
   * استخراج داده‌ی خام جمع‌آوری‌شده برای یک متد و نگاشت کلیدهای آن
   * به نام کلیدهای مورد انتظار هوش مصنوعی.
   */
  #extractAiInputForMethod(report, handler) {
    const collectedData = handler.extractCollectedData(report);
    if (!collectedData) return null;
    return this.#remapKeys(collectedData, handler.keyMap);
  }

  #remapKeys(collectedData, keyMap) {
    const result = {};
    for (const [key, value] of Object.entries(collectedData)) {
      result[keyMap[key] ?? key] = value;
    }
    return result;
  }

  #wrapWithStatus(data, isSuccess) {
    return { status: isSuccess ? 'ok' : 'failed', data };
  }

  #wrapField(value, fallback, isValid) {
    const valid = isValid(value);
    return this.#wrapWithStatus(valid ? value : fallback, valid);
  }

  #wrapEstelamAsliRows(value) {
    if (value === null) {
      return this.#wrapWithStatus([], true);
    }
    const isValid = Array.isArray(value);
    return this.#wrapWithStatus(isValid ? value : [], isValid);
  }

  #pickFirst(...values) {
    return values.find((value) => {
      return value !== undefined;
    });
  }

  /**
   * بازکردن فیلدهای تودرتوی ناهماهنگ به یک ساختار یکسان و مسطح.
   */
  #normalizeFields(aiInput) {
    if (!aiInput) return aiInput;

    aiInput.iran = this.#pickFirst(
      aiInput.iran?.data?.data,
      aiInput.iran?.data,
      aiInput.iran
    );

    aiInput.chequeList = aiInput.chequeList?.ErrorList
      ? null
      : this.#pickFirst(
        aiInput.chequeList?.data?.chequeList,
        aiInput.chequeList?.chequeList,
        aiInput.chequeList?.data,
        aiInput.chequeList
      );

    if (aiInput.EstelamAsliRows === null || aiInput.EstelamAsliRows?.data?.ReturnValue?.TashilatItem === null) {
      aiInput.EstelamAsliRows = [];
    }
    else {
      aiInput.EstelamAsliRows = this.#pickFirst(
        aiInput.EstelamAsliRows?.TashilatItem,
        aiInput.EstelamAsliRows?.tashilat?.TashilatItem,
        aiInput.EstelamAsliRows?.data?.ReturnValue?.TashilatItem,
        aiInput.EstelamAsliRows?.ReturnValue?.TashilatItem,
        aiInput.EstelamAsliRows?.data,
        aiInput.EstelamAsliRows
      );

      if (aiInput.EstelamAsliRows && !Array.isArray(aiInput.EstelamAsliRows)) {
        aiInput.EstelamAsliRows = [aiInput.EstelamAsliRows];
      }
    }

    aiInput.historical_loans = this.#pickFirst(
      aiInput.historical_loans?.data?.resultData,
      aiInput.historical_loans?.resultData,
      aiInput.historical_loans?.data,
      aiInput.historical_loans
    );

    aiInput.averageDeposit = this.#pickFirst(
      aiInput.averageDeposit?.data?.resultData,
      aiInput.averageDeposit?.data?.outputs,
      aiInput.averageDeposit?.data?.averageList,
      aiInput.averageDeposit?.data,
      aiInput.averageDeposit
    );

    return aiInput;
  }
}

module.exports = BuildAiInput;
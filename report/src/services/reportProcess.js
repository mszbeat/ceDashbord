const PartRequest = require('partRequest');
const partRequest = new PartRequest();
const pr = new partRequest();
const config = require('../config.js');
const pLimit = require('p-limit');
const limit = pLimit(10);
const utils = require('../utils/fileUtils.js');
const BuildAiinput = require('../utils/buildAiInput.js');

const PAGE_SIZE = 50;

const getTotalCount = async (filterKey, filterValue) => {
  try {
    const data = await sendRequest(filterKey, filterValue, 1, 1);
    return data.count;
  }
  catch (error) {
    console.error(error);
    return 0;
  }
};

const sendRequest = async (filterKey, filterValue, page, limit) => {
  try {
    const headers = config.headers;
    const params = {
      ...config.url.params,
      page: page,
      [filterKey]: filterValue,
      limit: limit
    };

    Object.keys(params).forEach(
      key => {
        return params[key] === null && delete params[key];
      }
    );

    const options = { ...config.url, params, headers };
    const { data } = await pr.sendHttp(options, null);
    return data;
  }
  catch (error) {
    console.error('Send request to report api encountered with an error: ', error);
    return 0;
  }
};

const isReportSuccess = (report, statusIsSuccess) => {
  const message = report?.output?.message;
  const enMessage = message?.en;
  const responseSuccessMessages = [
    'You currently have overdue debt.please improve your credit behavior and try again.',
    'Validation was successful.',
    'Your historical data is not enough.',
    'You still have bounced check. please improve your credit behavior and try again.'
  ];
  return (responseSuccessMessages.includes(enMessage));
};

const flushBatch = (isSuccess, batch, filterKey, filterValue, pageRef, writeOperations) => {
  pageRef.value++;
  writeOperations.push(
    utils.writePage(isSuccess ? 'success' : 'fail', filterKey, filterValue, pageRef.value, [...batch])
  );
  batch.length = 0;
};

const reportClassification = async (data, filterKey, filterValue, successPage, failPage) => {
  try {
    const reports = data?.reportResults || [];
    const statusIsSuccess = config.url.params.status === 'success';

    const successBatch = [];
    const failBatch = [];
    const writeOperations = [];

    const successPageRef = { value: successPage };
    const failPageRef = { value: failPage };

    let successCreditEvaluation = 0;
    let failCreditEvaluation = 0;

    for (const rawReport of reports) {
      const processedReport = applyAiOutput(applyAiInput(rawReport));

      const isSuccess = isReportSuccess(processedReport, statusIsSuccess);
      const batch = isSuccess ? successBatch : failBatch;
      batch.push(processedReport);

      if (batch.length === PAGE_SIZE) {
        flushBatch(isSuccess, batch, filterKey, filterValue, isSuccess ? successPageRef : failPageRef, writeOperations);

        if (isSuccess) {
          successCreditEvaluation += PAGE_SIZE;
        }
        else {
          failCreditEvaluation += PAGE_SIZE;
        }
      }
    }

    if (successBatch.length) {
      successPageRef.value++;
      writeOperations.push(utils.writePage('success', filterKey, filterValue, successPageRef.value, successBatch));
      successCreditEvaluation += successBatch.length;
    }

    if (failBatch.length) {
      failPageRef.value++;
      writeOperations.push(utils.writePage('fail', filterKey, filterValue, failPageRef.value, failBatch));
      failCreditEvaluation += failBatch.length;
    }

    const limitedOperations = writeOperations.map(op => {
      return limit(() => {
        return op;
      });
    });
    await Promise.all(limitedOperations);

    return {
      success: {
        count: successCreditEvaluation,
        page: successPageRef.value
      },
      fail: {
        count: failCreditEvaluation,
        page: failPageRef.value
      }
    };
  }
  catch (error) {
    console.error('Classificating report encountered with an error: ', error);
    return 0;
  }
};

const run = async (filterKey, filterValue) => {
  try {
    await utils.addDirs(filterKey, filterValue);

    let successCreditEvaluation = 0;
    let failCreditEvaluation = 0;
    let successPage = 0;
    let failPage = 0;
    let defaultLimit = config.url.params.limit;
    let defaultCount = config.count;
    let totalCount = await getTotalCount(filterKey, filterValue);

    if (config.all) defaultCount = totalCount;
    if (totalCount < defaultCount && !config.all) defaultCount = totalCount;
    let neededPages = Math.floor(defaultCount / defaultLimit);
    if (defaultCount % defaultLimit !== 0) neededPages++;

    let currentPage = 1;
    while ((currentPage - 1) < neededPages && defaultCount > 0) {

      if (defaultCount < defaultLimit) defaultLimit = defaultCount;

      const data = await sendRequest(filterKey, filterValue, currentPage, defaultLimit);
      const result = await reportClassification(data, filterKey, filterValue, successPage, failPage);

      successCreditEvaluation += result.success.count;
      successPage = result.success.page;
      failCreditEvaluation += result.fail.count;
      failPage = result.fail.page;

      currentPage++;
      defaultCount -= defaultLimit;
    }

    const finalMessage = `⭐ Count of succcess credit evaluation is ${successCreditEvaluation} and failed credit evalutaion is ${failCreditEvaluation} - total : ${successCreditEvaluation + failCreditEvaluation}\n`;
    await utils.writeFinalFile(filterValue, finalMessage);

    return { finalMessage, failCreditEvaluation, successCreditEvaluation };
  }
  catch (error) {
    console.error('Running report encountered with an error: ', error);
  }

};

const applyAiInput = (report) => {
  if (report.input?.ai_input) {
    return replaceInput(report);
  }
  report.ai_input = new BuildAiinput().buildFromReport(report);
  return report;
};

const applyAiOutput = (report) => {
  if (report.output?.ai_output) {
    return replaceOutput(report);
  }
  return report;
};

const replaceInput = (report) => {
  report.ai_input = report.input.ai_input;
  report.input = report.input.bankInput;
  return report;
};

const replaceOutput = (report) => {
  report.ai_output = report.output.ai_output;
  report.output = report.output.legacyOutput;
  return report;
};

module.exports = {
  run
};
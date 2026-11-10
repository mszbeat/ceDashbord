const moment = require('moment-jalaali');
const config = require('./config');
const utils = require('./utils/fileUtils');
const reportProcess = require('./services/reportProcess');

(async () => {
  const filterKey = config.filterKey;
  await utils.updateDirs();
  if (filterKey == 'date') {
    const startedTime = config.date[0];
    const finishedTime = config.date[1];

    let time = moment(startedTime, 'jYYYY/jMM/jDD');
    const finish = moment(finishedTime, 'jYYYY/jMM/jDD');
    let totalFailed = 0;
    let totalSuccess = 0;
    while (time.isSameOrBefore(finish)) {
      const result = await reportProcess.run(filterKey, time.format('jYYYY/jMM/jDD'));
      totalFailed += result.failCreditEvaluation;
      totalSuccess += result.successCreditEvaluation;
      console.log(result.finalMessage);
      time.add(1, 'day');
    }
    const totalMessage = `${totalFailed + totalSuccess} - total success ${totalSuccess} and total failed ${totalFailed}`;
    await utils.writeFinalFile('total', totalMessage);
    console.log(totalMessage);
  }
  else {
    const filterValues = config[config.filterKey];
    let value = 0;
    while (value < filterValues.length) {
      const result = await reportProcess.run(filterKey, filterValues[value]);
      console.log(result);
      value++;
    }
  }
})();
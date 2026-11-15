module.exports = {
  getConfigFrom: {
    CCS: false,
  },
  makeInstanceOnBoot: [
    'auth',
    'summaryController',
    'creditEvaluationController',
    'adminController',
  ],
};

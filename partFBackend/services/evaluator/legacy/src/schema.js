'use strict';
// مسیرهای قطعی تأییدشده؛ مسیر جایگزین یا خواندن از ai_input برای آرایه‌ها نداریم.
const SCHEMAS = {
  tavan_resalat: {
    root: 'input.data.collectedData', rotbe: 'input.data.collectedData.rotbebandiStandard.data',
    facilities: 'input.data.collectedData.samatFacilities.tashilat.TashilatItem',
    facilityEnvelope: 'input.data.collectedData.samatFacilities.tashilat',
    cheques: 'input.data.collectedData.samatCheque.chequeList',
    loans: 'input.data.collectedData.historicalLoans', deposit: 'input.data.collectedData.depositAverage',
    currency: 'ArzCode', bankCode: 'BankCode', requestNumber: 'RequestNum',
  },
  tavan_postbank: {
    root: 'collectedData', rotbe: 'collectedData.rotbebandiStandardResult.data',
    facilities: 'collectedData.samatFacilitiesResult.data.ReturnValue.TashilatItem',
    facilityEnvelope: 'collectedData.samatFacilitiesResult.data.ReturnValue',
    cheques: 'collectedData.samatChequeResult.data.chequeList',
    loans: 'collectedData.postBankLoansDataResult.data.resultData',
    deposit: 'collectedData.postBankDepositAverageResult.data.averageList',
    currency: 'ArzCD', bankCode: 'BnkCD', requestNumber: 'RequestNO',
  },
  tavan_mellat: {
    root: 'input.data', rotbe: 'input.data.rotbebandiStandard.data',
    facilities: 'input.data.samatFacilities.TashilatItem', facilityEnvelope: 'input.data.samatFacilities',
    cheques: 'input.data.samatCheque.chequeList', loans: 'input.data.historicalLoans',
    deposit: 'input.data.depositAverage', currency: 'ArzCD', bankCode: 'BnkCD', requestNumber: 'RequestNO',
  },
};
module.exports = { SCHEMAS };

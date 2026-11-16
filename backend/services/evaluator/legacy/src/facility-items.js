'use strict';
// Shared shape contract for TashilatItem only. Never rewrite the raw record or unwrap envelopes.
const validItem = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).length > 0;
function normalizeFacilities(value) {
  if (value === undefined) return {kind:'missing',items:[]};
  if (value === null) return {kind:'null',items:[]};
  if (Array.isArray(value)) {
    if (!value.length) return {kind:'emptyArray',items:[]};
    const items=value.filter(validItem);
    return {kind:items.length===value.length?null:'invalidItems',items};
  }
  if (validItem(value)) return {kind:null,items:[value]};
  return {kind:value && typeof value==='object'?'emptyObject':'invalidFacility',items:[]};
}
const facilityKind = value => normalizeFacilities(value).kind;
const hasFacilities = value => normalizeFacilities(value).items.length > 0;
module.exports={normalizeFacilities,facilityKind,hasFacilities};

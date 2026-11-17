'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FONT_PATH = path.join(__dirname, 'assets', 'Vazirmatn-Variable.woff2');

let cachedCss = null;

function getVazirmatnFontCss() {
  if (cachedCss !== null) return cachedCss;
  try {
    const b64 = fs.readFileSync(FONT_PATH).toString('base64');
    cachedCss = `@font-face{font-family:'Vazirmatn';src:url('data:font/woff2;base64,${b64}') format('woff2');font-weight:100 900;font-style:normal;font-display:swap;}`;
  } catch {
    cachedCss = '';
  }
  return cachedCss;
}

module.exports = {
  getVazirmatnFontCss,
};

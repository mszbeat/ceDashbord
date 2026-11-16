function cleanEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed)) return undefined;
  return trimmed;
}

let parsedUrl = null;
const rawServiceUrl = cleanEnv(process.env.SAMAD_SERVICE_URL);
if (rawServiceUrl) {
  try {
    parsedUrl = new URL(rawServiceUrl);
  } catch {
    parsedUrl = null;
  }
}

const protocol =
  cleanEnv(process.env.SAMAD_PROTOCOL) ||
  (parsedUrl ? parsedUrl.protocol.replace(/:$/, '') : 'http');

const host =
  cleanEnv(process.env.SAMAD_HOST) ||
  parsedUrl?.hostname ||
  'samad-v8-dev.partdp.ir';

const port = Number(
  cleanEnv(process.env.SAMAD_PORT) ||
  parsedUrl?.port ||
  (protocol === 'https' ? 443 : 80),
);

const gatewayEnv = cleanEnv(process.env.SAMAD_GATEWAY_ENABLE);
const gatewayEnable = gatewayEnv
  ? gatewayEnv === 'true'
  : Boolean(parsedUrl && parsedUrl.pathname && parsedUrl.pathname.includes('/service/'));

module.exports = {
  global: {
    gatewayEnable,
    host, // دامنه‌ی سرویس (مستقیم یا از طریق گیت‌وی)
    protocol,
    port,
    partLoggerConfig: require('./partLoggerConfig'),
  },
  instance: {
    cacheTtl: 60 * 60 * 1000,
    auth: {
      user: cleanEnv(process.env.SAMAD_USER) || 'mohammadsadeghZarei',
      pass: cleanEnv(process.env.SAMAD_PASS) || 'mohammadsadeghZarei',
    },
  },
};

function cleanEnv(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || /[\u0600-\u06FF]/.test(trimmed)) return undefined;
  return trimmed;
}

const protocol = cleanEnv(process.env.SAMAD_PROTOCOL) || 'http';
const host = cleanEnv(process.env.SAMAD_HOST) || 'samad-v8-dev.partdp.ir';
const port = Number(
  cleanEnv(process.env.SAMAD_PORT) || (protocol === 'https' ? 443 : 80),
);
const gatewayEnable = cleanEnv(process.env.SAMAD_GATEWAY_ENABLE) === 'true';

module.exports = {
  global: {
    gatewayEnable,
    host, // دامنه‌ی مستقیم سرویس سمد (پیش‌فرض: samad-v8-dev.partdp.ir بدون نیاز به gateway token)
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

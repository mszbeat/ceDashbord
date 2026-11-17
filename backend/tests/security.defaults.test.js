'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('هیچ شناسه/رمز شخصی بهعنوان پیشفرض در کد وجود ندارد', () => {
  for (const rel of [
    'Program.js',
    'project-config/dev/dependencies/partSamadInterfaceConfig.js',
    'project-config/dev/routerConf.js',
    'controllers/auth/samad.service.js',
    '.env.example',
  ]) {
    assert.doesNotMatch(read(rel), /mohammadsadeghZarei/, `${rel} contains a personal default`);
  }
});

test('CORS با کوکی احراز هویت از wildcard استفاده نمیکند', () => {
  const source = read('project-config/dev/servers.js');
  assert.doesNotMatch(source, /'Access-Control-Allow-Origin'\s*:\s*'\*'/);
  assert.match(source, /'Access-Control-Allow-Credentials'\s*:\s*'true'/);
  assert.match(source, /CORS_ALLOWED_ORIGIN/);
});

test('کلید خصوصی TLS از درخت ریپو حذف و ignore شده است', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'certificate', 'key.pem')), false);
  assert.equal(fs.existsSync(path.join(ROOT, 'certificate', 'key-cert.pem')), false);
  assert.match(read('../.gitignore'), /backend\/certificate\//);
});

test('پیشنیازهای محیطی با اسکریپت مشخص راستیآزمایی میشوند', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'scripts', 'check-env.js')), true);
  assert.match(read('package.json'), /"check:env"/);
});

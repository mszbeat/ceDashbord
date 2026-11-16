'use strict';

const Program = require('./Program');
const projectConfig = require('./project-config');

const rawEnv = process.env.MODE || process.env.mode || process.env.NODE_ENV || 'dev';
const env = rawEnv === 'production' ? 'prod' : rawEnv === 'development' ? 'dev' : rawEnv;

(async () => {
  const program = new Program(projectConfig[env] || projectConfig.dev);
  await program.run();
})();

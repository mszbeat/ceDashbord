const Program = require('./Program');
const projectConfig = require('./project-config');
const env = process.env.MODE || process.env.mode || 'dev';

(async () => {
  const program = new Program(projectConfig[env]);
  await program.run();
})();
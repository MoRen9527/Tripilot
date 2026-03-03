const path = require('node:path');
const Mocha = require('mocha');
const { glob } = require('glob');

async function run() {
  const mocha = new Mocha({
    ui: 'bdd',
    color: true,
    timeout: 60_000
  });

  const testsRoot = __dirname;
  const files = await glob('**/*.test.cjs', { cwd: testsRoot });
  files.forEach((f) => mocha.addFile(path.resolve(testsRoot, f)));

  return new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} extension-host E2E test(s) failed.`));
      } else {
        resolve();
      }
    });
  });
}

module.exports = { run };

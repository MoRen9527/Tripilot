import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

async function main() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const extensionDevelopmentPath = path.resolve(__dirname, '../..');
  const extensionTestsPath = path.resolve(__dirname, './suite/index.cjs');
  const userDataDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'tripilot-e2e-user-data');
  const extensionsDir = path.resolve(extensionDevelopmentPath, '.vscode-test', 'tripilot-e2e-extensions');

  await runTests({
    version: 'stable',
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: [
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes'
    ],
    extensionTestsEnv: {
      TRIPILOT_E2E: '1'
    }
  });
}

main().catch((error) => {
  console.error('Extension-host E2E failed:', error);
  process.exit(1);
});

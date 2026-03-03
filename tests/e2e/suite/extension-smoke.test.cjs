const assert = require('node:assert');
const vscode = require('vscode');

describe('Tripilot extension host smoke', function () {
  it('activates tripilot extension', async function () {
    const extension = vscode.extensions.getExtension('local.tripilot-chat');
    assert.ok(extension, 'extension local.tripilot-chat should be present');

    if (!extension.isActive) {
      await extension.activate();
    }

    assert.strictEqual(extension.isActive, true, 'extension should be active after activation');
  });

  it('registers critical commands', async function () {
    const allCommands = await vscode.commands.getCommands(true);
    assert.ok(allCommands.includes('tripilot.chat.open'), 'tripilot.chat.open should be registered');
    assert.ok(allCommands.includes('tripilot.chat.toggle'), 'tripilot.chat.toggle should be registered');
  });
});

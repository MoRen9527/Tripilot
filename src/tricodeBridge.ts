/**
 * TriCode bridge — unified code execution interface for the TriPilot extension.
 * Wraps @trimetaverse/tricode so all callers use a single access point.
 */

import type {
	CodeTaskRequest,
	CodeTaskResult,
	ToolAvailability,
} from '@trimetaverse/tricode';

export type { CodeTaskRequest, CodeTaskResult, ToolAvailability };

let tricodeModule: typeof import('@trimetaverse/tricode') | null = null;

function getModule(): typeof import('@trimetaverse/tricode') {
	if (!tricodeModule) {
		tricodeModule = require('@trimetaverse/tricode');
	}
	return tricodeModule!;
}

export function executeCodeTask(request: CodeTaskRequest): Promise<CodeTaskResult> {
	return getModule().executeCodeTask(request);
}

export function listAvailableTools(): string[] {
	return getModule().listAvailableTools();
}

export async function getToolStatus(tool: string): Promise<ToolAvailability> {
	return getModule().getToolStatus(tool);
}

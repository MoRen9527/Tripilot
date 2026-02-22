export type GitHubSession = {
	accessToken: string;
	accountLabel?: string;
	/** Best-effort hint of how the token was obtained (for diagnostics/UX). */
	source?: 'vscode-auth' | 'device-flow';
};

export type CopilotTokenEnvelope = {
	token: string;
	expires_at?: number;
	refresh_in?: number;
	endpoints?: {
		api?: string;
		proxy?: string;
		telemetry?: string;
		['origin-tracker']?: string;
	};
};

export type CopilotToken = {
	token: string;
	expiresAtMs?: number;
	endpoints: {
		api?: string;
		proxy?: string;
		telemetry?: string;
		originTracker?: string;
	};
};

export type OpenAIChatMessage =
	| { role: 'system'; content: string }
	| { role: 'user'; content: string }
	| { role: 'assistant'; content?: string; tool_calls?: OpenAIToolCall[] }
	| { role: 'tool'; content: string; tool_call_id: string };

export type OpenAITool = {
	type: 'function';
	function: {
		name: string;
		description?: string;
		parameters?: any;
	};
};

export type OpenAIToolCall = {
	id: string;
	type: 'function';
	function: {
		name: string;
		arguments: string;
	};
};

export type OpenAIChatCompletionsChunk = {
	id?: string;
	choices?: Array<{
		delta?: {
			content?: string;
			tool_calls?: Array<{
				index?: number;
				id?: string;
				type?: 'function';
				function?: { name?: string; arguments?: string };
			}>;
		};
		finish_reason?: string | null;
	}>;
};

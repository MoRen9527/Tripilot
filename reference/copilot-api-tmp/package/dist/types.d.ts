export interface IAbortSignal {
    readonly aborted: boolean;
    addEventListener(type: "abort", listener: (this: AbortSignal) => void): void;
    removeEventListener(type: "abort", listener: (this: AbortSignal) => void): void;
}
export interface FetchOptions {
    headers?: {
        [name: string]: string;
    };
    body?: BodyInit;
    timeout?: number;
    json?: any;
    method?: "GET" | "POST";
    signal?: IAbortSignal;
    suppressIntegrationId?: boolean;
}
export interface PaginationOptions<T> extends FetchOptions {
    pageSize?: number;
    startPage?: number;
    getItemsFromResponse: (data: any) => T[];
    buildUrl: (baseUrl: string, pageSize: number, page: number) => string;
}
export interface IFetcherService {
    fetch(url: string, options: FetchOptions): Promise<any>;
    fetchWithPagination<T>(baseUrl: string, options: PaginationOptions<T>): Promise<T[]>;
}
export interface IExtensionInformation {
    name: string;
    sessionId: string;
    machineId: string;
    vscodeVersion: string;
    version: string;
    buildType: "dev" | "prod";
}
export interface CopilotToken {
    endpoints: {
        api?: string;
        telemetry?: string;
        proxy?: string;
        "origin-tracker"?: string;
    };
    sku: string;
}
export interface RemoteAgentJobPayload {
    problem_statement: string;
    event_type: string;
    pull_request?: {
        title?: string;
        body_placeholder?: string;
        body_suffix?: string;
        base_ref?: string;
        head_ref?: string;
    };
    run_name?: string;
    custom_agent?: string;
    agent_id?: number;
    model?: string;
}
export declare enum RequestType {
    CopilotToken = "CopilotToken",
    CopilotNLToken = "CopilotNLToken",
    ChatCompletions = "ChatCompletions",
    ChatResponses = "ChatResponses",
    ChatMessages = "ChatMessages",
    ProxyCompletions = "ProxyCompletions",
    ProxyChatCompletions = "ProxyChatCompletions",
    RemoteAgent = "RemoteAgent",
    RemoteAgentChat = "RemoteAgentChat",
    CodeReviewAgent = "CodeReviewAgent",
    CAPIEmbeddings = "CAPIEmbeddings",
    DotcomEmbeddings = "DotcomEmbeddings",
    EmbeddingsModels = "EmbeddingsModels",
    Models = "Models",
    AutoModels = "AutoModels",
    Chunks = "Chunks",
    EmbeddingsCodeSearch = "EmbeddingsCodeSearch",
    ListSkills = "ListSkills",
    SearchSkill = "SearchSkill",
    ContentExclusion = "ContentExclusion",
    Telemetry = "Telemetry",
    CopilotUserInfo = "CopilotUserInfo",
    ModelPolicy = "ModelPolicy",
    ListModel = "ListModel",
    SnippyMatch = "SnippyMatch",
    SnippyFilesForMatch = "SnippyFlesForMatch",
    CodingGuidelines = "CodingGuidelines",
    EmbeddingsIndex = "EmbedingsIndex",
    ChatAttachmentUpload = "ChatAttachmentUpload",
    CopilotSessionLogs = "CopilotSessionLogs",
    CopilotSessionDetails = "CopilotSessionDetails",
    CopilotSessions = "CopilotSessions",
    CopilotAgentJob = "CopilotAgentJob",
    CCAModelsList = "CCAModelsList",
    CopilotCustomAgents = "CopilotCustomAgents",
    CopilotCustomAgentsDetail = "CopilotCustomAgentsDetail",
    OrgCustomInstructions = "OrgCustomInstructions"
}
export type RequestMetadata = {
    type: Omit<RequestType, RequestType.ListModel | RequestType.ModelPolicy | RequestType.SearchSkill | RequestType.RemoteAgentChat | RequestType.ContentExclusion | RequestType.ChatCompletions | RequestType.Models | RequestType.CodingGuidelines | RequestType.EmbeddingsIndex | RequestType.ChatAttachmentUpload | RequestType.CopilotSessionLogs | RequestType.CopilotSessionDetails | RequestType.CopilotSessions | RequestType.CopilotAgentJob | RequestType.CCAModelsList | RequestType.CopilotCustomAgents | RequestType.CopilotCustomAgentsDetail | RequestType.OrgCustomInstructions>;
} | {
    type: RequestType.CodingGuidelines | RequestType.EmbeddingsIndex;
    repoWithOwner: string;
} | {
    type: RequestType.ChatCompletions | RequestType.ChatResponses | RequestType.ChatMessages | RequestType.Models;
    isModelLab?: boolean;
} | {
    type: RequestType.ListModel | RequestType.ModelPolicy;
    modelId: string;
    isModelLab?: boolean;
} | {
    type: RequestType.SearchSkill;
    slug: string;
} | {
    type: RequestType.RemoteAgentChat;
    slug?: string;
} | {
    type: RequestType.ContentExclusion;
    repos: string[];
} | {
    type: RequestType.ChatAttachmentUpload;
    uploadName: string;
    mimeType: string;
} | {
    type: RequestType.CopilotSessionLogs | RequestType.CopilotSessionDetails;
    sessionId: string;
} | {
    type: RequestType.CopilotSessions;
    prId?: string;
    nwo?: string;
    resourceState?: string;
} | {
    type: RequestType.CopilotAgentJob;
    owner: string;
    repo: string;
    payload?: RemoteAgentJobPayload;
    jobId?: string;
    sessionId?: string;
    apiVersion?: string;
} | {
    type: RequestType.CCAModelsList;
} | {
    type: RequestType.CopilotCustomAgents;
    owner: string;
    repo: string;
    target?: "github-copilot" | "vscode";
    exclude_invalid_config?: boolean;
    dedupe?: boolean;
    include_sources?: Array<"repo" | "org" | "enterprise">;
} | {
    type: RequestType.CopilotCustomAgentsDetail;
    owner: string;
    repo: string;
    customAgentName: string;
    version?: string;
} | {
    type: RequestType.OrgCustomInstructions;
    orgLogin: string;
};
export interface IDomainChangeResponse {
    capiUrlChanged: boolean;
    telemetryUrlChanged: boolean;
    dotcomUrlChanged: boolean;
    proxyUrlChanged: boolean;
}
interface CCAModelBilling {
    is_premium: boolean;
    multiplier: number;
    restricted_to: string[];
}
interface CCAModelVisionLimits {
    max_prompt_image_size: number;
    max_prompt_images: number;
    supported_media_types: string[];
}
interface CCAModelLimits {
    max_context_window_tokens: number;
    max_output_tokens: number;
    max_prompt_tokens: number;
    vision?: CCAModelVisionLimits;
}
interface CCAModelSupports {
    max_thinking_budget?: number;
    min_thinking_budget?: number;
    parallel_tool_calls: boolean;
    streaming: boolean;
    tool_calls: boolean;
    vision: boolean;
}
interface CCAModelCapabilities {
    family: string;
    limits: CCAModelLimits;
    object: string;
    supports: CCAModelSupports;
    tokenizer: string;
    type: string;
}
interface CCAModelPolicy {
    state: string;
    terms: string;
}
export interface CCAModel {
    billing: CCAModelBilling;
    capabilities: CCAModelCapabilities;
    id: string;
    is_chat_default: boolean;
    is_chat_fallback: boolean;
    model_picker_category: string;
    model_picker_enabled: boolean;
    name: string;
    object: string;
    policy: CCAModelPolicy;
    preview: boolean;
    supported_endpoints: string[];
    vendor: string;
    version: string;
}
export {};

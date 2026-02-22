"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonlChatHistoryStore = void 0;
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const promises_1 = require("node:fs/promises");
function nowIso() {
    return new Date().toISOString();
}
function hashText(value) {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
function getWorkspaceInfo(folder) {
    if (!folder)
        return undefined;
    const name = folder.name;
    // Store only a hash of the local path to avoid leaking absolute paths.
    const pathHash = hashText(folder.uri.fsPath);
    return { name, pathHash };
}
class JsonlChatHistoryStore {
    dirFsPath;
    currentSessionId;
    currentFileFsPath;
    constructor(storageBaseUri) {
        this.dirFsPath = storageBaseUri.fsPath;
    }
    async startSession(meta) {
        await (0, promises_1.mkdir)(this.dirFsPath, { recursive: true });
        const sessionId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
        this.currentSessionId = sessionId;
        this.currentFileFsPath = path.join(this.dirFsPath, `${sessionId}.jsonl`);
        await this.append({
            kind: 'session_start',
            ts: nowIso(),
            sessionId,
            workspace: getWorkspaceInfo(meta.workspaceFolder),
            profileId: meta.profileId,
            modelId: meta.modelId
        });
        return sessionId;
    }
    async resumeSession(sessionId) {
        await (0, promises_1.mkdir)(this.dirFsPath, { recursive: true });
        const normalized = String(sessionId || '').trim();
        if (!normalized)
            return;
        this.currentSessionId = normalized;
        this.currentFileFsPath = path.join(this.dirFsPath, `${normalized}.jsonl`);
    }
    async append(event) {
        if (!this.currentSessionId || !this.currentFileFsPath) {
            // If a consumer forgot to start a session, ignore safely.
            return;
        }
        const line = JSON.stringify(event) + '\n';
        await (0, promises_1.appendFile)(this.currentFileFsPath, line, { encoding: 'utf8' });
    }
}
exports.JsonlChatHistoryStore = JsonlChatHistoryStore;
//# sourceMappingURL=chatHistory.js.map
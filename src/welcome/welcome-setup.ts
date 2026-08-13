/**
 * TriCade Phase 1 -- TriPilot First-Launch Welcome / Setup Wizard (tricade-2)
 *
 * Four-step wizard shown when `tripilot.setupCompleted` is not set.
 * Does not block TriLC startup -- fire-and-forget on activation.
 */

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';

// -- Types --

interface WelcomeSetupResult {
  language: 'zh' | 'en';
  apiKey: string;
  modelId: string;
  apiEndpoint: string;
  trimcUrl: string;
  tricompanyEnabled: boolean;
}

// -- i18n strings --

const zh = {
  title: '欢迎使用 TriCade',
  subtitle: 'AI 驱动的本地开发环境',
  step1Title: '欢迎',
  step2Title: 'API 配置',
  step3Title: 'TriMC 连接',
  step4Title: '赛博公司',
  next: '下一步',
  back: '上一步',
  finish: '完成',
  skip: '跳过',
  testConnection: '测试连接',
  testing: '测试中...',
  testSuccess: '连接成功',
  testFailed: '连接失败',
  step1Desc: 'TriCade 是一个 AI 驱动的本地开发环境，集成了强大的编码助手和团队协作工具。',
  step1LangLabel: '选择语言 / Select Language',
  step2ApiKeyLabel: 'API Key',
  step2ApiKeyPlaceholder: '输入你的 API Key',
  step2ModelIdLabel: 'Model ID',
  step2EndpointLabel: 'API Endpoint URL',
  step2Note: '你的 API Key 将安全保存在本地，仅用于 TriLC 代理请求。',
  step3Title2: '是否连接 TriMC 云端协作服务？',
  step3Desc: 'TriMC 提供增强的 AI pipeline 和团队协作，但不是必需的。你可以稍后在设置中配置。',
  step3UrlLabel: 'TriMC URL',
  step3UrlPlaceholder: '留空跳过',
  step3LaterLabel: '稍后可以在设置中配置',
  step4Title2: '是否启用赛博公司模式？',
  step4Desc: '加载 13 个 AI 员工角色（CEO 总助、产品总裁、技术总裁等），用于专业项目开发。',
  step4EnableLabel: '启用赛博公司模式',
  step4LaterLabel: '稍后可以在设置中配置',
  errorTitle: '错误',
  errorClose: '关闭',
};

const en = {
  title: 'Welcome to TriCade',
  subtitle: 'AI-Powered Local Development Environment',
  step1Title: 'Welcome',
  step2Title: 'API Setup',
  step3Title: 'TriMC Connect',
  step4Title: 'TriCompany',
  next: 'Next',
  back: 'Back',
  finish: 'Finish',
  skip: 'Skip',
  testConnection: 'Test Connection',
  testing: 'Testing...',
  testSuccess: 'Connection Successful',
  testFailed: 'Connection Failed',
  step1Desc: 'TriCade is an AI-powered local development environment with an integrated coding assistant and team collaboration tools.',
  step1LangLabel: '选择语言 / Select Language',
  step2ApiKeyLabel: 'API Key',
  step2ApiKeyPlaceholder: 'Enter your API Key',
  step2ModelIdLabel: 'Model ID',
  step2EndpointLabel: 'API Endpoint URL',
  step2Note: 'Your API key is stored securely on your local machine. Used only for TriLC proxy requests.',
  step3Title2: 'Connect to TriMC Cloud Service?',
  step3Desc: 'TriMC provides enhanced AI pipelines and team collaboration features. It is optional and not required for local development.',
  step3UrlLabel: 'TriMC URL',
  step3UrlPlaceholder: 'Leave blank to skip',
  step3LaterLabel: 'You can configure this later in settings',
  step4Title2: 'Enable TriCompany Mode?',
  step4Desc: 'Load 13 AI employee roles (CEO Chief of Staff, CPO, CTO, etc.) for professional project development.',
  step4EnableLabel: 'Enable TriCompany mode',
  step4LaterLabel: 'You can configure this later in settings',
  errorTitle: 'Error',
  errorClose: 'Close',
};

function t(key: string, lang: 'zh' | 'en'): string {
  return (lang === 'zh' ? (zh as Record<string, string>)[key] : (en as Record<string, string>)[key]) || key;
}

// -- HTML generation --

function getWizardHtml(webview: vscode.Webview, language: 'zh' | 'en'): string {
  const _ = (key: string) => t(key, language);

  return `<!DOCTYPE html>
<html lang="${language}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${_('title')}</title>
<style>
:root {
  --bg: var(--vscode-editor-background);
  --fg: var(--vscode-editor-foreground);
  --border: var(--vscode-panel-border);
  --input-bg: var(--vscode-input-background);
  --input-fg: var(--vscode-input-foreground);
  --input-border: var(--vscode-input-border);
  --btn-bg: var(--vscode-button-background);
  --btn-fg: var(--vscode-button-foreground);
  --btn-hover: var(--vscode-button-hoverBackground);
  --btn-secondary-bg: var(--vscode-button-secondaryBackground);
  --btn-secondary-fg: var(--vscode-button-secondaryForeground);
  --btn-secondary-hover: var(--vscode-button-secondaryHoverBackground);
  --focus-outline: var(--vscode-focusBorder);
  --desc-color: var(--vscode-descriptionForeground);
  --error-fg: var(--vscode-errorForeground);
  --success-fg: #4ec9b0;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: var(--vscode-font-family, -apple-system, sans-serif);
  font-size: var(--vscode-font-size, 13px);
  color: var(--fg); background: var(--bg);
  padding: 24px 32px; line-height: 1.6;
  display: flex; flex-direction: column; min-height: 100vh;
}
.container { max-width: 520px; margin: 0 auto; width: 100%; flex: 1; }
.logo { font-size: 28px; font-weight: 700; text-align: center; margin-bottom: 8px; }
.subtitle { text-align: center; color: var(--desc-color); margin-bottom: 32px; font-size: 14px; }
.steps { display: flex; justify-content: center; gap: 16px; margin-bottom: 32px; }
.step-dot {
  width: 12px; height: 12px; border-radius: 50%;
  background: var(--btn-secondary-bg); border: 2px solid var(--border);
  transition: all 0.2s;
}
.step-dot.active { background: var(--btn-bg); border-color: var(--btn-bg); }
.step-dot.done { background: var(--success-fg); border-color: var(--success-fg); }
.step-content { margin-bottom: 24px; }
.step-content h2 { font-size: 18px; margin-bottom: 12px; font-weight: 600; }
.desc-block {
  background: var(--input-bg); border: 1px solid var(--border);
  border-radius: 6px; padding: 14px 16px; margin-bottom: 20px;
  font-size: 13px; line-height: 1.7; color: var(--desc-color);
}
.form-group { margin-bottom: 16px; }
.form-group label {
  display: block; font-weight: 600; margin-bottom: 4px;
  font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px;
  color: var(--desc-color);
}
.form-group input, .form-group select {
  width: 100%; padding: 8px 12px;
  background: var(--input-bg); color: var(--input-fg);
  border: 1px solid var(--input-border); border-radius: 4px;
  font-family: var(--vscode-editor-font-family, monospace);
  font-size: var(--vscode-font-size, 13px); outline: none;
}
.form-group input:focus, .form-group select:focus { border-color: var(--focus-outline); }
.form-group input::placeholder { color: var(--desc-color); opacity: 0.6; }
.form-group select { font-family: var(--vscode-font-family, sans-serif); }
.checkbox-row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; cursor: pointer; }
.checkbox-row input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--btn-bg); }
.checkbox-row label { cursor: pointer; font-size: 13px; }
.btn-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-top: 8px; }
.btn {
  padding: 8px 20px; border: none; border-radius: 4px;
  font-size: 13px; font-weight: 500; cursor: pointer;
  font-family: var(--vscode-font-family, sans-serif); transition: background 0.15s;
}
.btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
.btn-primary:hover { background: var(--btn-hover); }
.btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: var(--btn-secondary-bg); color: var(--btn-secondary-fg); }
.btn-secondary:hover { background: var(--btn-secondary-hover); }
.status-msg {
  font-size: 12px; padding: 8px 12px; border-radius: 4px; margin-top: 8px; display: none;
}
.status-msg.show { display: block; }
.status-msg.success { color: var(--success-fg); background: rgba(78,201,176,0.1); border: 1px solid rgba(78,201,176,0.3); }
.status-msg.error { color: var(--error-fg); background: rgba(255,80,80,0.1); border: 1px solid rgba(255,80,80,0.3); }
.status-msg.loading { color: var(--desc-color); background: var(--input-bg); border: 1px solid var(--border); }
.note { font-size: 11px; color: var(--desc-color); margin-top: 4px; }
.flex-row { display: flex; align-items: center; gap: 8px; }
.spacer { flex: 1; }
</style>
</head>
<body>
<div class="container">
<div class="logo">${_('title')}</div>
<div class="subtitle">${_('subtitle')}</div>

<div class="steps">
  <div class="step-dot" id="dot0"></div>
  <div class="step-dot" id="dot1"></div>
  <div class="step-dot" id="dot2"></div>
  <div class="step-dot" id="dot3"></div>
</div>

<div class="step-content" id="stepContent"></div>
<div class="btn-row" id="btnRow"></div>
</div>

<script>
const vscode = acquireVsCodeApi();
let currentStep = 0;
const maxStep = 3;
let testing = false;

let wizardData = {
  language: 'zh',
  apiKey: '',
  modelId: 'tmv-deepseek-v4-pro',
  apiEndpoint: 'https://api.deepseek.com',
  trimcUrl: '',
  tricompanyEnabled: false,
};

// Inline i18n from server
const _i18n = JSON.parse('${JSON.stringify(language === 'zh' ? zh : en)}');
function _(k) { return _i18n[k] || k; }

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setStep(step) {
  currentStep = Math.max(0, Math.min(maxStep, step));
  renderStep();
  updateDots();
  updateButtons();
}

function updateDots() {
  for (let i = 0; i <= maxStep; i++) {
    var d = document.getElementById('dot'+i);
    d.classList.remove('active','done');
    if (i < currentStep) d.classList.add('done');
    if (i === currentStep) d.classList.add('active');
  }
}

function renderStep() {
  var el = document.getElementById('stepContent');
  if (currentStep === 0) el.innerHTML = step1Html();
  else if (currentStep === 1) el.innerHTML = step2Html();
  else if (currentStep === 2) el.innerHTML = step3Html();
  else el.innerHTML = step4Html();
  bindStepEvents();
}

function step1Html() {
  var sel = wizardData.language === 'en' ? 'en' : 'zh';
  return '<h2>'+_('step1Title')+'</h2>' +
    '<div class="desc-block">'+_('step1Desc')+'</div>' +
    '<div class="form-group">' +
      '<label for="langSelect">'+_('step1LangLabel')+'</label>' +
      '<select id="langSelect">' +
        '<option value="zh"'+(sel==='zh'?' selected':'')+'>中文</option>' +
        '<option value="en"'+(sel==='en'?' selected':'')+'>English</option>' +
      '</select>' +
    '</div>';
}

function step2Html() {
  return '<h2>'+_('step2Title')+'</h2>' +
    '<div class="form-group">' +
      '<label for="apiKeyInput">'+_('step2ApiKeyLabel')+'</label>' +
      '<input id="apiKeyInput" type="password" placeholder="'+_('step2ApiKeyPlaceholder')+'" value="'+esc(wizardData.apiKey)+'" />' +
      '<p class="note">'+_('step2Note')+'</p>' +
    '</div>' +
    '<div class="form-group">' +
      '<label for="modelIdInput">'+_('step2ModelIdLabel')+'</label>' +
      '<input id="modelIdInput" type="text" value="'+esc(wizardData.modelId)+'" />' +
    '</div>' +
    '<div class="form-group">' +
      '<label for="endpointInput">'+_('step2EndpointLabel')+'</label>' +
      '<input id="endpointInput" type="text" value="'+esc(wizardData.apiEndpoint)+'" />' +
    '</div>' +
    '<div class="flex-row">' +
      '<button class="btn btn-secondary" id="testConnBtn">'+_('testConnection')+'</button>' +
      '<span class="status-msg" id="testStatus"></span>' +
    '</div>';
}

function step3Html() {
  return '<h2>'+_('step3Title2')+'</h2>' +
    '<div class="desc-block">'+_('step3Desc')+'</div>' +
    '<div class="form-group">' +
      '<label for="trimcUrlInput">'+_('step3UrlLabel')+'</label>' +
      '<input id="trimcUrlInput" type="text" placeholder="'+_('step3UrlPlaceholder')+'" value="'+esc(wizardData.trimcUrl)+'" />' +
    '</div>' +
    '<div class="checkbox-row">' +
      '<input type="checkbox" id="trimcLaterCb" checked />' +
      '<label for="trimcLaterCb">'+_('step3LaterLabel')+'</label>' +
    '</div>';
}

function step4Html() {
  var checked = wizardData.tricompanyEnabled ? ' checked' : '';
  return '<h2>'+_('step4Title2')+'</h2>' +
    '<div class="desc-block">'+_('step4Desc')+'</div>' +
    '<div class="checkbox-row">' +
      '<input type="checkbox" id="tricompanyCb"'+checked+' />' +
      '<label for="tricompanyCb">'+_('step4EnableLabel')+'</label>' +
    '</div>' +
    '<div class="checkbox-row">' +
      '<input type="checkbox" id="tricompanyLaterCb" checked />' +
      '<label for="tricompanyLaterCb">'+_('step4LaterLabel')+'</label>' +
    '</div>';
}

function updateButtons() {
  var el = document.getElementById('btnRow');
  var h = '';
  if (currentStep > 0) {
    h += '<button class="btn btn-secondary" id="backBtn">'+_('back')+'</button>';
  }
  h += '<div class="spacer"></div>';
  if (currentStep < maxStep) {
    if (currentStep === 2) {
      h += '<button class="btn btn-secondary" id="skipBtn" style="margin-right:8px">'+_('skip')+'</button>';
    }
    h += '<button class="btn btn-primary" id="nextBtn">'+_('next')+'</button>';
  } else {
    h += '<button class="btn btn-primary" id="finishBtn">'+_('finish')+'</button>';
  }
  el.innerHTML = h;
  bindButtonEvents();
}

function bindButtonEvents() {
  var b = document.getElementById('backBtn');
  if (b) b.onclick = function(){ setStep(currentStep-1); };
  b = document.getElementById('nextBtn');
  if (b) b.onclick = function(){ collectAndNext(); };
  b = document.getElementById('skipBtn');
  if (b) b.onclick = function(){ setStep(currentStep+1); };
  b = document.getElementById('finishBtn');
  if (b) b.onclick = function(){ complete(); };
}

function bindStepEvents() {
  var s = document.getElementById('langSelect');
  if (s) s.onchange = function(){ wizardData.language = s.value; };
  s = document.getElementById('apiKeyInput');
  if (s) s.oninput = function(){ wizardData.apiKey = s.value; };
  s = document.getElementById('modelIdInput');
  if (s) s.oninput = function(){ wizardData.modelId = s.value; };
  s = document.getElementById('endpointInput');
  if (s) s.oninput = function(){ wizardData.apiEndpoint = s.value; };
  var btn = document.getElementById('testConnBtn');
  if (btn) btn.onclick = function(){ doTestConnection(); };
  s = document.getElementById('trimcUrlInput');
  if (s) s.oninput = function(){ wizardData.trimcUrl = s.value; };
  s = document.getElementById('tricompanyCb');
  if (s) s.onchange = function(){ wizardData.tricompanyEnabled = s.checked; };
}

function collectFields() {
  var el = document.getElementById('apiKeyInput');
  if (el) wizardData.apiKey = el.value;
  el = document.getElementById('modelIdInput');
  if (el) wizardData.modelId = el.value || 'tmv-deepseek-v4-pro';
  el = document.getElementById('endpointInput');
  if (el) wizardData.apiEndpoint = el.value || 'https://api.deepseek.com';
  el = document.getElementById('trimcUrlInput');
  if (el) wizardData.trimcUrl = el.value;
}

function collectAndNext() {
  collectFields();
  setStep(currentStep + 1);
}

function doTestConnection() {
  collectFields();
  testing = true;
  var btn = document.getElementById('testConnBtn');
  if (btn) { btn.textContent = _('testing'); btn.disabled = true; }
  var st = document.getElementById('testStatus');
  if (st) { st.className = 'status-msg show loading'; st.textContent = _('testing'); }
  vscode.postMessage({
    type: 'testConnection',
    apiKey: wizardData.apiKey,
    modelId: wizardData.modelId,
    apiEndpoint: wizardData.apiEndpoint,
  });
}

function complete() {
  var cb = document.getElementById('tricompanyCb');
  if (cb) wizardData.tricompanyEnabled = cb.checked;
  vscode.postMessage({ type: 'complete', result: wizardData });
}

window.addEventListener('message', function(e) {
  var msg = e.data;
  if (msg.type === 'testConnectionResult') {
    testing = false;
    var btn = document.getElementById('testConnBtn');
    if (btn) { btn.textContent = _('testConnection'); btn.disabled = false; }
    var st = document.getElementById('testStatus');
    if (st) {
      if (msg.ok) {
        st.className = 'status-msg show success';
        st.textContent = _('testSuccess');
      } else {
        st.className = 'status-msg show error';
        st.textContent = _('testFailed') + (msg.error ? ': ' + msg.error : '');
      }
    }
  }
  if (msg.type === 'wizardComplete') {
    if (msg.ok) {
      var btn = document.getElementById('finishBtn');
      if (btn) { btn.textContent = 'OK'; btn.disabled = true; }
      setTimeout(function(){ vscode.postMessage({ type: 'close' }); }, 600);
    } else {
      var el = document.getElementById('stepContent');
      el.innerHTML = '<h2>'+_('errorTitle')+'</h2>' +
        '<div class="desc-block" style="color:var(--error-fg)">'+esc(msg.error||'')+'</div>';
      var br = document.getElementById('btnRow');
      br.innerHTML = '<button class="btn btn-primary" id="closeErrBtn">'+_('errorClose')+'</button>';
      document.getElementById('closeErrBtn').onclick = function(){ vscode.postMessage({type:'close'}); };
    }
  }
});

setStep(0);
</script>
</body>
</html>`;
}

// -- TriLC /v1/models test helper --

function testTriLCConnection(
  apiKey: string,
  _modelId: string,
  apiEndpoint: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${apiEndpoint}/v1/models`;
  const timeoutMs = 10_000;

  return new Promise((resolve) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch (e) {
      resolve({ ok: false, error: `Invalid URL: ${apiEndpoint}` });
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }

    const req = transport.request(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'GET',
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(body);
              const hasModels =
                (parsed?.data && Array.isArray(parsed.data)) ||
                (parsed?.models && Array.isArray(parsed.models));
              if (hasModels) {
                resolve({ ok: true });
              } else {
                resolve({
                  ok: false,
                  error: 'Unexpected response format from API',
                });
              }
            } else if (res.statusCode === 401 || res.statusCode === 403) {
              resolve({
                ok: false,
                error: `Authentication failed (HTTP ${res.statusCode}). Check your API key.`,
              });
            } else {
              resolve({
                ok: false,
                error: `HTTP ${res.statusCode}: ${body.slice(0, 200)}`,
              });
            }
          } catch (e) {
            resolve({
              ok: false,
              error: `Failed to parse response: ${e instanceof Error ? e.message : String(e)}`,
            });
          }
        });
      },
    );

    req.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        resolve({ ok: false, error: 'Connection refused. Check the API endpoint URL.' });
      } else if (err.code === 'ENOTFOUND') {
        resolve({ ok: false, error: 'Host not found. Check the API endpoint URL.' });
      } else {
        resolve({ ok: false, error: err.message });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'Connection timed out. Check the API endpoint URL.' });
    });

    req.end();
  });
}

// -- Settings persistence --

async function persistWelcomeSettings(result: WelcomeSetupResult): Promise<void> {
  const tripilot = vscode.workspace.getConfiguration('tripilot');

  // Core chat provider config
  await tripilot.update('chatProvider', 'models-direct', vscode.ConfigurationTarget.Global);
  await tripilot.update('modelsDirect.baseUrl', 'http://127.0.0.1:8711', vscode.ConfigurationTarget.Global);
  await tripilot.update('modelsDirect.defaultModel', result.modelId, vscode.ConfigurationTarget.Global);
  await tripilot.update('triLC.autoStart', true, vscode.ConfigurationTarget.Global);

  // TriMC URL
  const trimcUrl = (result.trimcUrl ?? '').trim();
  await tripilot.update('trimc.url', trimcUrl, vscode.ConfigurationTarget.Global);

  // TriCompany
  await tripilot.update('tricompany.enabled', result.tricompanyEnabled, vscode.ConfigurationTarget.Global);

  // Language
  await tripilot.update('language', result.language, vscode.ConfigurationTarget.Global);

  // Mark setup completed
  await tripilot.update('setupCompleted', true, vscode.ConfigurationTarget.Global);

  // Persist to %APPDATA%/TriCade/trilc-config.json (human-readable reference config)
  try {
    const appData = process.env.APPDATA || process.env.HOME || '';
    if (appData) {
      const triCadeDir = path.join(appData, 'TriCade');
      if (!fs.existsSync(triCadeDir)) {
        fs.mkdirSync(triCadeDir, { recursive: true });
      }
      const configPath = path.join(triCadeDir, 'trilc-config.json');
      const config = {
        apiKey: result.apiKey,
        defaultModel: result.modelId,
        apiEndpoint: result.apiEndpoint,
        trimcUrl: trimcUrl || undefined,
        tricompanyEnabled: result.tricompanyEnabled,
        language: result.language,
        configuredAt: new Date().toISOString(),
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    }
  } catch (e) {
    // Non-critical: do not block setup on config file write failure
    console.error('[WelcomeSetup] Failed to write trilc-config.json:', e);
  }

  // w32-2 fix: Bridge wizard API config to TriLC's key-cache.
  // TriLC reads keys from %LOCALAPPDATA%/trilc/keys.json; without this,
  // the user-entered API key from the wizard never reaches TriLC.
  try {
    const localAppData = process.env.LOCALAPPDATA || process.env.HOME || '';
    if (localAppData) {
      const trilcDir = path.join(localAppData, 'trilc');
      if (!fs.existsSync(trilcDir)) {
        fs.mkdirSync(trilcDir, { recursive: true });
      }
      const keyCachePath = path.join(trilcDir, 'keys.json');
      const keyCache = {
        keys: {
          deepseek: {
            api_key: result.apiKey,
            base_url: result.apiEndpoint || 'https://api.deepseek.com',
          },
        },
        defaultModel: result.modelId,
        refreshIntervalS: 900,
        fetchedAt: Date.now(),
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      };
      fs.writeFileSync(keyCachePath, JSON.stringify(keyCache, null, 2), 'utf-8');
    }
  } catch (e) {
    console.error('[WelcomeSetup] Failed to write TriLC key-cache:', e);
  }
}

// -- Public entry point --

/**
 * Show the welcome/setup wizard if `tripilot.setupCompleted` is not set.
 * Does not block TriLC startup — call this as fire-and-forget during activation.
 */
export async function showWelcomeSetupWizard(context: vscode.ExtensionContext): Promise<void> {
  const tripilot = vscode.workspace.getConfiguration('tripilot');
  const setupCompleted = tripilot.get<boolean>('setupCompleted', false);
  if (setupCompleted) {
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    'tripilot.welcomeSetup',
    'TriCade Setup',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: false,
      localResourceRoots: [context.extensionUri],
    },
  );

  const language: 'zh' | 'en' = 'zh';
  panel.webview.html = getWizardHtml(panel.webview, language);

  let committed = false;

  panel.webview.onDidReceiveMessage(async (msg: any) => {
    switch (msg.type) {
      case 'webviewReady':
        break;

      case 'testConnection': {
        const result = await testTriLCConnection(msg.apiKey, msg.modelId, msg.apiEndpoint);
        panel.webview.postMessage({ type: 'testConnectionResult', ok: result.ok, error: result.error });
        break;
      }

      case 'complete': {
        if (committed) return;
        committed = true;
        try {
          await persistWelcomeSettings(msg.result as WelcomeSetupResult);
          panel.webview.postMessage({ type: 'wizardComplete', ok: true });
        } catch (e) {
          panel.webview.postMessage({
            type: 'wizardComplete',
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          });
        }
        break;
      }

      case 'close':
        panel.dispose();
        break;

      default:
        break;
    }
  });

  panel.onDidDispose(async () => {
    if (!committed) {
      // User dismissed without finishing — mark completed so wizard doesn't re-open
      try {
        await tripilot.update('setupCompleted', true, vscode.ConfigurationTarget.Global);
      } catch {
        // ignore
      }
    }
  });
}

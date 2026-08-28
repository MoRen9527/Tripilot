/**
 * trilc-auth — TriLC daemon X-Internal-Token 注入（LG-002 daemon 升级配套，2026-08-28）。
 *
 * TriLC p0fix3 全局安全门 fail-closed：除 /healthz 外一切路由要求 X-Internal-Token
 * （TriLC app.ts 文档化顺序契约：/healthz 精确豁免 → Host/Origin 白名单 → token → 路由）。
 *
 * TriPilot 侧单点适配，两个注入面：
 *  - installTrilcTokenFetch()：全局 fetch 包装（镜像 TriLC src/trimc-auth.ts 模式），
 *    凡请求 daemon host 的调用自动附加头——覆盖 init 族等全部 fetch 连接点及未来新增；
 *  - internalTokenHeaders()：node:http 直连点（TriLCClient / trilcDirect / CLI /
 *    init-events SSE）在各自请求构造处显式展开注入。
 *
 * token 每次调用读取 process.env.TRILC_INTERNAL_TOKEN（请求期读，不缓存启动快照，
 * 与 TriLC 服务端读取口径一致）；未配置时零行为变化（返回空头/不包装）。
 */

const INSTALLED_FLAG = Symbol.for('tripilot.trilcAuthInstalled');

/** 读取内部令牌：未配置返回 undefined（调用方零行为变化）。 */
export function getTrilcInternalToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env.TRILC_INTERNAL_TOKEN;
  return typeof token === 'string' && token.length > 0 ? token : undefined;
}

/** node:http 直连点注入头：无 token 时空对象，展开零影响。 */
export function internalTokenHeaders(): Record<string, string> {
  const token = getTrilcInternalToken();
  return token ? { 'x-internal-token': token } : {};
}

/** CLI 等多宿主注入点用：仅本地 daemon 目标附加，防 token 随请求外泄。 */
export function isLocalDaemonTarget(parsedUrl: URL): boolean {
  return parsedUrl.hostname === '127.0.0.1' || parsedUrl.hostname === 'localhost';
}

/**
 * 安装全局 fetch 包装（进程内一次）。凡请求 daemon host 的 fetch 自动附加
 * X-Internal-Token；已带头的请求不重复附加；token 未配置时零行为变化。
 * @param baseUrlOverride 显式 daemon base（扩展侧传 trilcDirect.baseUrl 配置）
 */
export function installTrilcTokenFetch(env: NodeJS.ProcessEnv = process.env, baseUrlOverride?: string): void {
  const g = globalThis as unknown as Record<symbol, boolean>;
  if (g[INSTALLED_FLAG]) return;
  g[INSTALLED_FLAG] = true;

  const base = (baseUrlOverride ?? env.TRILC_BASE_URL ?? 'http://127.0.0.1:8711').replace(/\/$/, '');
  let host = '';
  try {
    host = new URL(base).host;
  } catch {
    return; // base 非法则不包装
  }
  const original = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      const url = typeof input === 'string' ? new URL(input, base) : input instanceof URL ? input : new URL(input.url);
      if (
        url.host === host &&
        !(init?.headers && hasInternalToken(init.headers)) &&
        !(input instanceof Request && input.headers.has('x-internal-token'))
      ) {
        const token = getTrilcInternalToken(env);
        if (token) {
          const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
          headers.set('X-Internal-Token', token);
          return original(input, { ...init, headers });
        }
      }
    } catch {
      /* 解析失败按原样透传 */
    }
    return original(input, init);
  };
}

function hasInternalToken(headers: HeadersInit): boolean {
  if (headers instanceof Headers) return headers.has('x-internal-token');
  if (Array.isArray(headers)) return headers.some(([k]) => k.toLowerCase() === 'x-internal-token');
  return Object.keys(headers).some((k) => k.toLowerCase() === 'x-internal-token');
}

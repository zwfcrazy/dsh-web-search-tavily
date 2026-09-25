/* dsh-web-search-tavily — Tavily search provider（dsh-web 能力缝，P7c 2026-09-25）。
 *
 * 范式对齐 @deepseek-ai/dsh-web-search-deepseek（settings 段、凭据按次解析、
 * WebError 分类、abort 语义、请求观测 hook 全部同构）。
 *
 * 本包经 link: 挂进 profile、自身无 node_modules 安装链，运行时依赖装载采用
 * dsh-voice importCompactionBasic 的成熟模式：先 createRequire 解析出真实路径，
 * 再 import(pathToFileURL(...)) 按 URL 导入 —— 与宿主行同一 realpath、同一 ESM
 * 实例（WebError 的 instanceof 语义成立），且不依赖 require(esm) 在宿主进程
 * 的可用性（2026-09-25 boot 实测：schemastery(CJS) 经 require 可载，dsh-web
 * (ESM) 经 require 失败，import(URL) 两态皆通）。
 *
 * 国内网络适配（2026-09-25 实测，见 docs/research/网络搜索技能选型-2026-09-25.md）：
 * api.tavily.com 未被墙，故障点在本机 DNS（8.8.8.8 受干扰时通时断）。
 * 连接层用自定义 lookup：本地 dns.lookup 快路径 → 阿里 DoH(223.5.5.5，IP
 * 直连免解析) 兜底拿真实 A 记录 → 钉 IP 直连；结果缓存 5 分钟。
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import dns from 'node:dns'
import https from 'node:https'
import os from 'node:os'

//#region 运行时依赖解析（与宿主同实例）

const REQ_ANCHORS = [
  '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/index.js',
  os.homedir() + '/.dsh/profiles/node_modules/index.js',
  os.homedir() + '/.dsh/profiles/web/index.js',
]

/** 解析依赖的真实路径：包旁（常规 peer 安装）→ 部署 → profile 锚点。 */
function resolveDepsPath(spec) {
  const attempts = [createRequire(import.meta.url), ...REQ_ANCHORS.map(a => createRequire(a))]
  let last
  for (const req of attempts) {
    try { return req.resolve(spec) } catch (e) { last = e }
  }
  throw new Error(spec + ' 不可解析（包旁/部署/profile node_modules 均未命中）：' + String((last && last.message) || last))
}

/* schemastery 是 CJS，可同步 require（按绝对路径，避开裸名解析的环境差异）。 */
const schemastery = (() => {
  const mod = createRequire(import.meta.url)(resolveDepsPath('@deepseek-ai/schemastery'))
  return mod.default ?? mod
})()
const z = schemastery

/** ESM 依赖按 URL 异步导入（缓存；与宿主行同 realpath 即同实例）。 */
const esmCache = new Map()
async function loadEsm(spec) {
  if (esmCache.has(spec)) return esmCache.get(spec)
  const path = resolveDepsPath(spec)
  const mod = await import(pathToFileURL(path).href)
  esmCache.set(spec, mod)
  return mod
}

/** apply 时一次性装载的运行时依赖（之后所有引用走 RT.*）。 */
let RT = undefined
async function ensureRuntime() {
  if (RT !== undefined) return RT
  const [web, credentials, settings, launchEnv] = await Promise.all([
    loadEsm('@deepseek-ai/dsh-web'),
    loadEsm('@deepseek-ai/dsh-credentials'),
    loadEsm('@deepseek-ai/dsh-settings'),
    loadEsm('@deepseek-ai/dsh-launch-environment'),
  ])
  RT = {
    WebError: web.WebError,
    credentialRef: credentials.credentialRef,
    installSettingsSection: settings.installSettingsSection,
    settingsNamespace: settings.settingsNamespace,
    launchEnvironmentOf: launchEnv.launchEnvironmentOf,
  }
  return RT
}

//#endregion

//#region 常量与工具

/** Stable id this provider registers under. */
const TAVILY_PROVIDER_ID = 'tavily'
/** Default Tavily API endpoint. */
const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'
/** Default credential reference（DSH credentials refs 段 / 环境变量同名）。 */
const DEFAULT_API_KEY_ENV = 'TAVILY_API_KEY'
/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'dsh-web-search-tavily/0.1.0'
/** Settings namespace carrying this provider's endpoint 与 key 引用（设置界面可见）。 */
const WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE = 'web-search-tavily'
/** 单结果 snippet 上限（Tavily content 常为整段正文，截断防爆上下文）。 */
const SNIPPET_MAX_CHARS = 600
/** DoH 解析结果缓存 TTL。 */
const DNS_CACHE_TTL_MS = 5 * 60 * 1000

function throwIfSearchAborted(signal) {
  if (signal?.aborted === true) throw searchAborted(signal)
}
function searchAborted(signal, fallback) {
  return new RT.WebError('Tavily search aborted', 'WEB_ABORTED', { cause: signal?.aborted === true ? signal.reason : fallback })
}
/** Race an in-process promise against caller cancellation without leaving unhandled rejections. */
function abortable(operation, signal) {
  if (signal === void 0) return operation
  if (signal.aborted) return Promise.reject(searchAborted(signal))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(searchAborted(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(value => {
      signal.removeEventListener('abort', onAbort)
      resolve(value)
    }, error => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error(String(error).replace(/^Error: /u, ''), { cause: error }))
    })
  })
}

//#endregion

//#region 国内网络适配：lookup（本地 DNS → 阿里 DoH 兜底，缓存 5 分钟）

/** 经阿里 DoH（223.5.5.5，IP 直连自身免解析）查一条 A/AAAA 记录。 */
function dohResolve(hostname, family) {
  return new Promise((resolve, reject) => {
    const type = family === 6 ? 'AAAA' : 'A'
    const req = https.request({
      hostname: '223.5.5.5',
      path: '/resolve?name=' + encodeURIComponent(hostname) + '&type=' + type,
      method: 'GET',
      timeout: 4000,
      headers: { accept: 'application/json' },
    }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      res.on('end', () => {
        try {
          const answers = (JSON.parse(buf).Answer || []).filter(x => x.type === (family === 6 ? 28 : 1))
          const hit = answers.find(x => typeof x.data === 'string' && x.data.length > 0)
          if (hit) resolve({ address: hit.data, family: family === 6 ? 6 : 4 })
          else reject(new Error('DoH 无 ' + type + ' 记录: ' + hostname))
        } catch (e) { reject(e) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('DoH 超时')))
    req.on('error', reject)
    req.end()
  })
}

/**
 * 造一个 node:https 用的 lookup：dns.lookup 快路径（不带预算，connect 自身
 * 有 timeoutMs 兜底）→ 失败即 DoH；成功结果进缓存。返回数组形 callback。
 */
function makeChinaFriendlyLookup() {
  const cache = new Map()
  return (hostname, opts, cb) => {
    const family = opts && opts.family === 6 ? 6 : 4
    const key = hostname + '/' + family
    const hit = cache.get(key)
    if (hit && hit.until > Date.now()) { cb(null, [hit.entry]); return }
    let done = false
    const finish = (err, entry) => {
      if (done) return
      done = true
      if (err) cb(err)
      else {
        cache.set(key, { entry, until: Date.now() + DNS_CACHE_TTL_MS })
        cb(null, [entry])
      }
    }
    dns.lookup(hostname, { family: 0 }, (err, addr, fam) => {
      if (!err && typeof addr === 'string' && addr.length > 0) finish(null, { address: addr, family: fam || 4 })
      else dohResolve(hostname, family).then(entry => finish(null, entry), e => finish(e))
    })
  }
}

//#endregion

//#region HTTP（node:https，支持自定义 lookup 与 AbortSignal）

/** POST/GET JSON；resolve {status, json}；网络层错误 reject（Error）。 */
function httpsJson(url, method, headers, bodyObj, signal, timeoutMs, lookup) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = bodyObj === undefined ? undefined : JSON.stringify(bodyObj)
    const h = { ...headers }
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload)
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: h,
      timeout: timeoutMs,
      ...(lookup !== undefined ? { lookup } : {}),
    }, res => {
      let buf = ''
      res.setEncoding('utf8')
      res.on('data', c => { buf += c })
      res.on('end', () => {
        let json
        try { json = buf ? JSON.parse(buf) : undefined } catch { json = undefined }
        resolve({ status: res.statusCode, json })
      })
    })
    const onAbort = () => { try { req.destroy() } catch { /* 已结束 */ } }
    if (signal !== undefined) {
      if (signal.aborted) { reject(searchAborted(signal)); return }
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    req.on('timeout', () => req.destroy(new Error('request timeout (' + timeoutMs + 'ms)')))
    req.on('error', e => {
      if (signal !== undefined && signal.aborted) reject(searchAborted(signal))
      else reject(e)
    })
    if (payload !== undefined) req.write(payload)
    req.end()
  })
}

//#endregion

//#region 响应映射

/**
 * Tavily /search 响应 → WebSearchResult。answer（LLM 摘要，include_answer
 * 时有）映射为 content；results[] 映射 sources[]（content 截断作 snippet），
 * 按 url 去重。seam 侧负责 maxResults 截断，这里 truncated 恒 false。
 * @throws {WebError} 既无 sources 也无 answer 时。
 */
function mapTavilyResponse(data) {
  if (data === null || typeof data !== 'object' || !Array.isArray(data.results)) {
    throw new RT.WebError('Tavily returned no results array', 'WEB_PROVIDER_ERROR')
  }
  const seen = new Set()
  const sources = []
  for (const r of data.results) {
    if (r === null || typeof r !== 'object') continue
    if (typeof r.url !== 'string' || r.url.length === 0 || seen.has(r.url)) continue
    seen.add(r.url)
    sources.push({
      url: r.url,
      ...(typeof r.title === 'string' && r.title.length > 0 ? { title: r.title } : {}),
      ...(typeof r.content === 'string' && r.content.length > 0 ? { snippet: r.content.slice(0, SNIPPET_MAX_CHARS) } : {}),
    })
  }
  const answer = typeof data.answer === 'string' && data.answer.trim().length > 0 ? data.answer.trim() : undefined
  if (sources.length === 0 && answer === undefined) {
    throw new RT.WebError('Tavily returned neither results nor answer', 'WEB_PROVIDER_ERROR')
  }
  return {
    ...(answer !== undefined ? { content: answer } : {}),
    sources,
    truncated: false,
  }
}

//#endregion

//#region Provider

/** Tavily-backed search provider；每次 search 现取 options 快照与凭据。 */
class TavilySearchProvider {
  constructor(resolveOptions) {
    this.resolveOptions = resolveOptions
    this.id = TAVILY_PROVIDER_ID
    this.lookup = makeChinaFriendlyLookup()
  }

  available() {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && URL.canParse(options.baseURL)
  }

  async search(request, signal) {
    const options = this.resolveOptions()
    const apiKey = await this.apiKey(options, signal)
    throwIfSearchAborted(signal)
    const endpoint = options.baseURL.replace(/\/+$/, '') + '/search'
    const body = {
      query: request.query,
      max_results: Math.max(1, Math.min(request.maxResults ?? 5, 20)),
      search_depth: options.searchDepth,
      topic: options.topic,
      include_answer: options.includeAnswer,
    }
    options.recordRequest?.({ endpoint, body })
    throwIfSearchAborted(signal)
    let response
    try {
      response = await httpsJson(endpoint, 'POST', {
        authorization: 'Bearer ' + apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
      }, body, signal, options.timeoutMs, this.lookup)
    } catch (error) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      throw new RT.WebError('Tavily search request failed: ' + String((error && error.message) || error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (response.status !== 200) {
      let message = 'Tavily API error (HTTP ' + response.status + ')'
      const detail = response.json?.detail
      const d = detail !== null && typeof detail === 'object'
        ? (typeof detail.error === 'string' ? detail.error : detail.message)
        : detail
      if (typeof d === 'string' && d.length > 0) message = d
      else if (typeof response.json?.error === 'string' && response.json.error.length > 0) message = response.json.error
      throw new RT.WebError(message, 'WEB_PROVIDER_ERROR')
    }
    try {
      return mapTavilyResponse(response.json)
    } catch (error) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      if (error instanceof RT.WebError) throw error
      throw new RT.WebError('Tavily returned an unprocessable response body: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  /**
   * 按次解析凭据，不缓存在 provider 上（凭据轮换下一次 search 即生效）。
   * @throws {WebError} WEB_PROVIDER_CREDENTIAL_MISSING。
   */
  async apiKey(options, signal) {
    throwIfSearchAborted(signal)
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error) {
      if (signal?.aborted === true) throw searchAborted(signal, error)
      throw new RT.WebError('Tavily search credential resolution failed: ' + String(error), 'WEB_PROVIDER_ERROR', { cause: error })
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    throw new RT.WebError(
      'Tavily search has no API key for "' + (options.apiKeyEnv ?? DEFAULT_API_KEY_ENV) + '"; '
      + 'store it through the credentials service ($DSH_HOME/.credentials.yaml 的 refs 段或凭据界面), '
      + 'export it in the launching environment, or set a literal "apiKey" in the web-search-tavily config',
      'WEB_PROVIDER_CREDENTIAL_MISSING')
  }
}

//#endregion

//#region 插件

const name = 'web-search-tavily'
const inject = ['web']

const Config = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  searchDepth: z.string().default('basic'),
  topic: z.string().default('general'),
  includeAnswer: z.boolean().default(true),
  timeoutMs: z.number().step(1).min(1000).default(30000),
})

/** 把已解析 settings 段投影为下一次 search 的 options（含凭据/env 兜底）。 */
function resolveOptions(ctx, config) {
  const apiKeyEnv = RT.credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0 ? config.apiKey : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: async () => {
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
      const ambient = RT.launchEnvironmentOf(ctx).get(apiKeyEnv)
      return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
    },
    apiKeyEnv,
    baseURL: config.baseURL ?? TAVILY_DEFAULT_BASE_URL,
    searchDepth: config.searchDepth === 'advanced' ? 'advanced' : 'basic',
    topic: config.topic ?? 'general',
    includeAnswer: config.includeAnswer !== false,
    timeoutMs: config.timeoutMs ?? 30000,
    recordRequest: request => {
      ctx.get('agents')?.currentInitiator()?.session.append('web/tavily-search-request', request)
    },
  }
}

/** 注册 Tavily search provider 到 ctx.web，并装 settings 段（设置界面可配）。 */
async function apply(ctx, config) {
  await ensureRuntime()
  let current = () => config
  RT.installSettingsSection(ctx, RT.settingsNamespace(WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE), Config, config, {
    setSource: source => { current = source },
    onChange: () => {},
  })
  ctx.web.registerSearchProvider(new TavilySearchProvider(() => resolveOptions(ctx, current())))
}

//#endregion

export {
  Config,
  TAVILY_DEFAULT_BASE_URL,
  TAVILY_PROVIDER_ID,
  TavilySearchProvider,
  WEB_SEARCH_TAVILY_SETTINGS_NAMESPACE,
  apply,
  inject,
  name,
}

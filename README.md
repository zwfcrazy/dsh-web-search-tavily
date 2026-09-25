# dsh-web-search-tavily

Tavily search provider，挂接 DSH 的 **dsh-web 能力缝**（`ctx.web`）。
装好后所有走 `dsh-tool-web`（`web_search` 工具）的会话都由 Tavily 服务，
替代按次计费较贵的 DeepSeek 搜索后端；语音助手丁满的 `jarvis-voice` preset
经同一缝隙获得工具能力（P7c）。

## 要点

- **凭据**：DSH credentials 的 `TAVILY_API_KEY`（`$DSH_HOME/.credentials.yaml` refs 段 /
  凭据界面 / 启动环境），按次解析、轮换即时生效；也可在行配置里写 `apiKey`（secret role）
- **国内网络适配**：`api.tavily.com` 未被墙、故障在本机 DNS（8.8.8.8 受干扰）。连接层
  自定义 lookup：本地 `dns.lookup` 快路径 → 阿里 DoH（223.5.5.5，IP 直连免解析）兜底
  钉真实 IP → 直连；结果缓存 5 分钟。实测 3/3 通、约 3s 完成一次搜索
- **计费**：免费档 1,000 credits/月（basic 1 credit/次、advanced 2）；默认 basic +
  `include_answer`（Tavily 摘要映射为结果的 `content`，来源映射 `sources`）
- **设置界面**：自带浏览器半区卡片（设置 → 插件配置 → Tavily 网络搜索）：
  API Key 管理走凭据域（写入 DSH 凭据库、显示已配置徽章，明文永不进 settings）+
  baseURL/searchDepth/topic/includeAnswer/timeoutMs 表单（写用户层，可一键重置回
  组合层默认）。卡片经 `settings.plugin.item` 槽按 namespace `web-search-tavily` 注册
- **运行时依赖**：无构建链（lib/ 手写直提交）、无自带 node_modules；依赖经
  `createRequire` 解析真实路径 + `import(pathToFileURL)` 按 URL 装载（dsh-voice
  importCompactionBasic 模式），与宿主同 realpath 同实例（WebError 的 instanceof
  语义成立，已验证）。注意不要用 `require()` 直呼 `@deepseek-ai/*`——dsh web
  进程里 require(ESM) 不可用（2026-09-25 实测踩坑）

## 安装

```bash
dsh plugin --profile web add github:zwfcrazy/dsh-web-search-tavily
```

然后在 profile 的 `cordis.patch.yml` 里切换后端选择：

```yaml
- id: web
  config:
    searchProvider: tavily   # 回滚 = 改回 deepseek-official（该行仍挂载未选中）
```

重启 dsh web 生效。密钥两选一：DSH 凭据库 `TAVILY_API_KEY`（推荐，设置界面
卡片可直接录入），或环境变量同名。

开发模式：`dsh plugin --profile web add link:<本仓库路径>`（验证后务必切回
`github:`，否则 config 同步快照里存的是本机绝对路径，换机装不上）。

兼容性：Node >= 22 / DSH 0.1.1-rc.2（profile web）。License: MIT。

## 错误分类（WebError）

| code | 场景 |
|---|---|
| `WEB_PROVIDER_CREDENTIAL_MISSING` | TAVILY_API_KEY 各层均未解析到 |
| `WEB_PROVIDER_ERROR` | HTTP 非 200 / 响应不可解析 / 网络失败 |
| `WEB_ABORTED` | 调用方取消（AbortSignal） |

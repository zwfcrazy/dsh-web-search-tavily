/* dsh-web-search-tavily client：设置 → 插件 页的 Tavily 配置卡（0.2 形态）。
 * 手写 dsh client-module 包装格式（window.__ModuleLoader__.load，与官方包同构），
 * 无构建链、无原语包依赖（官方页是预打包内联原语；手写模块对其 require 能力
 * 不确定，故用 configForms scope 的 getSnapshot/subscribe/set 原始 API 自建迷你表单）。
 * 0.2 模式（镜像 dsh-client-ui-settings-web-search 官方页）：
 *   ctx.configForms.get('web-search-tavily') 取 scope；
 *   ctx.configForms.whileServed([ns], cb) 门控——host 侧本插件 entry（volatile
 *   Config）被服务时才挂卡；ctx.slots 'plugins.item' 槽位（Plugins 设置页）。
 *   密钥经 ctx.remote.credentials 域（describe/set + reference-updated 失效通知）。
 * 字段：apiKey(凭据)/baseURL/searchDepth(basic|advanced)/topic(general|news)/
 * timeoutMs。includeAnswer 为布尔，scope.set 类型严格且无对应控件，暂不经表单
 * （配置文件可改）。 */
window.__ModuleLoader__.load({
	id: "dsh-web-search-tavily",
	factory: function (require) {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		var NS = "web-search-tavily";
		var DEFAULT_REF = "TAVILY_API_KEY";
		var CTX = null;

		var S = {
			card: { border: "1px solid var(--border,#ddd)", borderRadius: 10, padding: "12px 14px", margin: "8px 0", fontSize: 13 },
			title: { fontSize: 14, fontWeight: 600, margin: "0 0 2px" },
			desc: { fontSize: 12, opacity: 0.65, margin: "0 0 10px", lineHeight: 1.5 },
			row: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap" },
			k: { minWidth: 110, opacity: 0.75 },
			input: { padding: "4px 8px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border,#ccc)", background: "transparent", color: "inherit", minWidth: 200 },
			badge: function (ok) { return { fontSize: 12, padding: "1px 8px", borderRadius: 99, background: ok ? "rgba(0,150,80,.12)" : "rgba(204,0,0,.10)", color: ok ? "#0a8a4a" : "#c00" }; },
			btn: function (primary) { return { padding: "4px 12px", fontSize: 13, cursor: "pointer", borderRadius: 6, border: "1px solid " + (primary ? "var(--accent,#08c)" : "var(--border,#ccc)"), background: primary ? "var(--accent,#08c)" : "transparent", color: primary ? "#fff" : "inherit" }; },
			hint: { fontSize: 12, opacity: 0.6, margin: "6px 0 0", lineHeight: 1.5 },
			msg: function (kind) { return { fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "#c00" : "#0a8a4a" }; }
		};

		/* ---- 迷你外部 store：snapshot + 本地草稿 ---- */
		var listeners = new Set();
		var state = { snap: {}, cred: { ref: "", configured: false, writable: true }, drafts: {}, busy: false, note: null };
		function set(patch) { state = Object.assign({}, state, patch); listeners.forEach(function (l) { return l(); }); }
		var store = {
			getSnapshot: function () { return state; },
			subscribe: function (l) { listeners.add(l); return function () { listeners.delete(l); }; },
			set: set
		};

		function refOf(snap) {
			var d = snap && snap.value && snap.value.apiKeyEnv;
			return d !== undefined && d.length > 0 ? d : DEFAULT_REF;
		}

		function syncDrafts() {
			var v = (state.snap.value) || {};
			set({ drafts: {
				baseURL: v.baseURL !== undefined ? String(v.baseURL) : "",
				searchDepth: v.searchDepth !== undefined ? String(v.searchDepth) : "basic",
				topic: v.topic !== undefined ? String(v.topic) : "general",
				timeoutMs: v.timeoutMs !== undefined ? String(v.timeoutMs) : "30000",
				apiKey: ""
			}, note: null });
		}

		function readCredential() {
			var ref = refOf(state.snap);
			return CTX.remote.credentials.describe([ref]).then(function (r) {
				if (!r || r.ok !== true || ref !== refOf(state.snap)) return;
				var view = (r.value || {})[ref];
				set({ cred: { ref: ref, configured: !!(view && view.configured), writable: view ? view.writable !== false : true } });
			}).catch(function () { /* 凭据域不可达时保持未知态 */ });
		}

		function saveDrafts() {
			var scope = CTX.configForms.get(NS);
			var d = state.drafts;
			var snapv = (state.snap.value) || {};
			set({ busy: true, note: null });
			var keys = ["baseURL", "searchDepth", "topic", "timeoutMs"];
			var chain = Promise.resolve();
			keys.forEach(function (k) {
				chain = chain.then(function () {
					var want = k === "timeoutMs" ? Number(d[k]) : d[k];
					var have = snapv[k] !== undefined ? snapv[k] : null;
					if (String(want) !== String(have)) {
						return scope.set(k, want).then(function (ok) {
							if (ok !== true) throw new Error("字段 " + k + " 保存失败");
						});
					}
				});
			});
			chain = chain.then(function () {
				if (d.apiKey !== undefined && d.apiKey.length > 0) {
					return CTX.remote.credentials.set(refOf(state.snap), d.apiKey).then(function () { return readCredential(); });
				}
			});
			return chain.then(function () {
				set({ busy: false, snap: scope.getSnapshot(), note: { kind: "ok", text: "已保存（volatile 热生效）" } });
				syncDrafts();
			}).catch(function (e) {
				set({ busy: false, note: { kind: "err", text: "保存失败：" + ((e && e.message) || e) } });
			});
		}

		/* ---- React 卡片组件（消费 useTavilyCard hook + 动作 props） ---- */
		function TavilyCard(props) {
			var state = props.useTavilyCard(function (s) { return s; });
			if (props.view === "summary") return "Tavily 搜索后端的端点与密钥配置（改动热生效）";
			var d = state.drafts || {};
			var cred = state.cred || {};
			function bind(field) {
				return { value: d[field] !== undefined ? d[field] : "", onChange: function (e) { var dd = Object.assign({}, state.drafts); dd[field] = e.target.value; set({ drafts: dd, note: null }); } };
			}
			return React.createElement("div", { style: S.card },
				React.createElement("div", { style: S.title }, "Tavily 搜索"),
				React.createElement("div", { style: S.desc }, "web_search 工具的后端（当前 web.searchProvider = tavily）。字段经 volatile 配置热生效，无需重启。"),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "API 密钥"),
					React.createElement("input", Object.assign({ style: Object.assign({}, S.input, { minWidth: 240 }), type: "password", placeholder: "留空 = 保持现状" }, bind("apiKey"))),
					React.createElement("span", { style: S.badge(cred.configured) }, cred.configured ? "已配置 " + (cred.ref || DEFAULT_REF) : "未配置（" + (cred.ref || DEFAULT_REF) + "）")),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "端点 baseURL"),
					React.createElement("input", Object.assign({ style: S.input, placeholder: "默认 https://api.tavily.com" }, bind("baseURL")))),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "搜索深度"),
					React.createElement("select", Object.assign({ style: S.input }, bind("searchDepth")),
						React.createElement("option", { value: "basic" }, "basic（快）"),
						React.createElement("option", { value: "advanced" }, "advanced（深）")),
					React.createElement("span", { style: S.k }, "主题"),
					React.createElement("select", Object.assign({ style: Object.assign({}, S.input, { minWidth: 120 }) }, bind("topic")),
						React.createElement("option", { value: "general" }, "general"),
						React.createElement("option", { value: "news" }, "news"))),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "超时（毫秒）"),
					React.createElement("input", Object.assign({ style: Object.assign({}, S.input, { minWidth: 100 }) }, bind("timeoutMs")))),
				React.createElement("div", { style: S.row },
					React.createElement("button", { style: S.btn(true), disabled: state.busy, onClick: props.save }, state.busy ? "保存中…" : "保存配置"),
					React.createElement("button", { style: S.btn(false), disabled: state.busy, onClick: props.discard }, "放弃修改")),
				state.note ? React.createElement("p", { style: S.msg(state.note.kind) }, state.note.text) : null,
				React.createElement("p", { style: S.hint }, "含 answer 摘要开关（includeAnswer）与 API key 引用名（apiKeyEnv）暂经配置文件调整；后端切换（web.searchProvider）属 host 组合配置。"));
		}

		exports.name = "dsh-web-search-tavily-client";
		exports.inject = ["slots", "remote", "remote.credentials", "configForms"];
		exports.apply = function (ctx) {
			CTX = ctx;
			var scope = ctx.configForms.get(NS);
			set({ snap: scope.getSnapshot() });
			syncDrafts();
			ctx.effect(function () {
				var un = scope.subscribe(function () {
					set({ snap: scope.getSnapshot() });
					readCredential();
				});
				var un2 = ctx.remote.$on("credentials/reference-updated", function (ref) {
					if (ref === (state.cred || {}).ref) readCredential();
				});
				return function () { try { un && un(); } catch (e) {} try { un2 && un2(); } catch (e) {} };
			}, "web-search-tavily: card subscriptions");
			readCredential();
			ctx.effect(function () {
				return ctx.configForms.whileServed([NS], function () {
					return ctx.slots.inject("plugins.item", function () {
						return ctx.slots.register({
							name: "plugins.item",
							id: "web-search-tavily",
							order: 41,
							label: function () { return "Tavily 搜索"; },
							inject: function () {
								return {
									hooks: { tavilyCard: store },
									save: function () { return saveDrafts(); },
									discard: function () { syncDrafts(); }
								};
							}
						}, TavilyCard);
					});
				});
			}, "web-search-tavily: plugins.item page");
		};
		return module.exports;
	}
});

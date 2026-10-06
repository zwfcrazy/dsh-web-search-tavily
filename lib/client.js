/* dsh-web-search-tavily client：设置页「Web 搜索 (Tavily)」配置页签（0.2 形态）。
 * 手写 dsh client-module 包装格式（window.__ModuleLoader__.load，与官方包同构），
 * 无构建链、无原语包依赖。
 *
 * 迭代记录（2026-10-06）：首版照官方 dsh-client-ui-settings-web-search 用
 * 'plugins.item' 槽 + whileServed 门控 + hooks 契约——实测在真实 GUI 不渲染
 * （settings/describe 已证命名空间 web-search-tavily 在 served 列表内，故非门控
 * 问题，而是 plugins.item 的 only:item.id 过滤/框架 hook 契约不匹配）。
 * 改用 settings.section 槽位（与 dsh-skills-inventory 同款，同环境截图验证可渲染）：
 * 纯字符串 label、组件 props 无私有契约、普通 React useState/useEffect 订阅。
 *
 * 数据层用官方 ConfigFormController（ctx.configForms.get(ns)）：getSnapshot/
 * subscribe/set(field, value)，底层走 remote.settings.mutate(ns, ops, revision)，
 * 自带 revision 排队与失败恢复；host 侧 entry Config 为 volatile → 保存即热生效。
 * 密钥经 remote.credentials 域（describe/set + reference-updated 失效通知）。 */
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
			card: { border: "1px solid var(--border,#ddd)", borderRadius: 10, padding: "14px 16px", margin: "8px 0", fontSize: 13, maxWidth: 720 },
			title: { fontSize: 16, fontWeight: 600, margin: "0 0 4px" },
			desc: { fontSize: 12, opacity: 0.65, margin: "0 0 12px", lineHeight: 1.5 },
			row: { display: "flex", alignItems: "center", gap: 8, padding: "5px 0", flexWrap: "wrap" },
			k: { minWidth: 110, opacity: 0.75 },
			input: { padding: "4px 8px", fontSize: 13, borderRadius: 6, border: "1px solid var(--border,#ccc)", background: "transparent", color: "inherit", minWidth: 220 },
			badge: function (ok, unknown) { return { fontSize: 12, padding: "1px 8px", borderRadius: 99, background: unknown ? "rgba(120,120,120,.12)" : (ok ? "rgba(0,150,80,.12)" : "rgba(204,0,0,.10)"), color: unknown ? "inherit" : (ok ? "#0a8a4a" : "#c00") }; },
			btn: function (primary) { return { padding: "4px 12px", fontSize: 13, cursor: "pointer", borderRadius: 6, border: "1px solid " + (primary ? "var(--accent,#08c)" : "var(--border,#ccc)"), background: primary ? "var(--accent,#08c)" : "transparent", color: primary ? "#fff" : "inherit" }; },
			hint: { fontSize: 12, opacity: 0.6, margin: "8px 0 0", lineHeight: 1.5 },
			msg: function (kind) { return { fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "#c00" : "#0a8a4a" }; }
		};

		/* ---- 外部 store：configForm 快照 + 凭据态 + 本地草稿 ---- */
		var listeners = new Set();
		var state = {
			snap: {}, cred: { ref: "", configured: false, writable: true, known: false },
			drafts: {}, busy: false, note: null
		};
		function set(patch) { state = Object.assign({}, state, patch); listeners.forEach(function (l) { return l(); }); }
		function subscribe(l) { listeners.add(l); return function () { listeners.delete(l); }; }
		function getSnapshot() { return state; }

		function values() {
			var v = state.snap && state.snap.value;
			return (v && typeof v === "object") ? v : {};
		}
		function refOf() {
			var v = values();
			return (typeof v.apiKeyEnv === "string" && v.apiKeyEnv.length > 0) ? v.apiKeyEnv : DEFAULT_REF;
		}
		function syncDrafts() {
			var v = values();
			set({ drafts: {
				baseURL: v.baseURL !== undefined ? String(v.baseURL) : "",
				searchDepth: typeof v.searchDepth === "string" ? v.searchDepth : "basic",
				topic: typeof v.topic === "string" ? v.topic : "general",
				timeoutMs: v.timeoutMs !== undefined ? String(v.timeoutMs) : "30000",
				apiKey: ""
			}, note: null });
		}

		function readCredential() {
			var ref = refOf();
			return CTX.remote.credentials.describe([ref]).then(function (r) {
				if (!r || r.ok !== true || ref !== refOf()) return;
				var view = (r.value || {})[ref];
				set({ cred: { ref: ref, configured: !!(view && view.configured), writable: view ? view.writable !== false : true, known: true } });
			}).catch(function () {
				set({ cred: { ref: ref, configured: false, writable: true, known: false } });
			});
		}

		function saveDrafts() {
			var ctrl = CTX.configForms.get(NS);
			var d = state.drafts;
			var v = values();
			var keys = ["baseURL", "searchDepth", "topic", "timeoutMs"];
			set({ busy: true, note: null });
			var chain = Promise.resolve();
			keys.forEach(function (k) {
				chain = chain.then(function () {
					var want = k === "timeoutMs" ? Number(d[k]) : d[k];
					var have = v[k] !== undefined ? v[k] : null;
					if (String(want) === String(have)) return;
					return ctrl.set(k, want).then(function (ok) {
						if (ok !== true) throw new Error("字段 " + k + " 保存失败（服务端拒绝或版本冲突）");
					});
				});
			});
			chain = chain.then(function () {
				if (d.apiKey !== undefined && d.apiKey.length > 0) {
					return CTX.remote.credentials.set(refOf(), d.apiKey).then(function () { return readCredential(); });
				}
			});
			return chain.then(function () {
				set({ busy: false, snap: ctrl.getSnapshot(), note: { kind: "ok", text: "已保存（volatile 热生效，下一次搜索即用新配置）" } });
				syncDrafts();
			}).catch(function (e) {
				set({ busy: false, note: { kind: "err", text: "保存失败：" + ((e && e.message) || e) } });
			});
		}

		/* ---- React 页签组件（普通 hooks，无框架私有契约） ---- */
		function TavilySection() {
			var st = React.useState(getSnapshot());
			var snap = st[0], setSnap = st[1];
			React.useEffect(function () {
				return subscribe(function () { setSnap(getSnapshot()); });
			}, []);
			var d = snap.drafts || {};
			var cred = snap.cred || {};
			function bind(field) {
				return { value: d[field] !== undefined ? d[field] : "", onChange: function (e) { var dd = Object.assign({}, snap.drafts); dd[field] = e.target.value; set({ drafts: dd, note: null }); } };
			}
			return React.createElement("div", { style: S.card },
				React.createElement("div", { style: S.title }, "Web 搜索（Tavily 后端）"),
				React.createElement("div", { style: S.desc }, "web_search 工具的后端 provider 配置（host 组合里 web.searchProvider = tavily）。字段为 volatile 配置，保存即热生效，无需重启。"),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "API 密钥"),
					React.createElement("input", Object.assign({ style: Object.assign({}, S.input, { minWidth: 260 }), type: "password", placeholder: "留空 = 保持现状", autoComplete: "off" }, bind("apiKey"))),
					React.createElement("span", { style: S.badge(cred.configured, !cred.known) }, !cred.known ? "凭据域不可达" : (cred.configured ? "已配置 " + (cred.ref || DEFAULT_REF) : "未配置（" + (cred.ref || DEFAULT_REF) + "）"))),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "端点 baseURL"),
					React.createElement("input", Object.assign({ style: S.input, placeholder: "留空 = 默认 https://api.tavily.com" }, bind("baseURL")))),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "搜索深度"),
					React.createElement("select", Object.assign({ style: Object.assign({}, S.input, { minWidth: 150 }) }, bind("searchDepth")),
						React.createElement("option", { value: "basic" }, "basic（快）"),
						React.createElement("option", { value: "advanced" }, "advanced（深）")),
					React.createElement("span", { style: S.k }, "主题"),
					React.createElement("select", Object.assign({ style: Object.assign({}, S.input, { minWidth: 130 }) }, bind("topic")),
						React.createElement("option", { value: "general" }, "general"),
						React.createElement("option", { value: "news" }, "news"))),
				React.createElement("div", { style: S.row },
					React.createElement("span", { style: S.k }, "超时（毫秒）"),
					React.createElement("input", Object.assign({ style: Object.assign({}, S.input, { minWidth: 110 }) }, bind("timeoutMs")))),
				React.createElement("div", { style: S.row },
					React.createElement("button", { style: S.btn(true), type: "button", disabled: snap.busy, onClick: function () { saveDrafts(); } }, snap.busy ? "保存中…" : "保存配置"),
					React.createElement("button", { style: S.btn(false), type: "button", disabled: snap.busy, onClick: function () { syncDrafts(); } }, "放弃修改")),
				snap.note ? React.createElement("p", { style: S.msg(snap.note.kind) }, snap.note.text) : null,
				React.createElement("p", { style: S.hint }, "includeAnswer（answer 摘要开关，布尔）与 apiKeyEnv（密钥引用名）暂经配置文件调整；后端选择（web.searchProvider，tavily / deepseek-official）属 host 组合配置。"));
		}

		exports.name = "dsh-web-search-tavily-client";
		exports.inject = ["slots", "remote", "remote.credentials", "configForms"];
		exports.apply = function (ctx) {
			CTX = ctx;
			var ctrl = ctx.configForms.get(NS);
			set({ snap: ctrl.getSnapshot() });
			syncDrafts();
			ctx.effect(function () {
				var un = ctrl.subscribe(function () {
					set({ snap: ctrl.getSnapshot() });
					if (!state.busy) syncDrafts();
					readCredential();
				});
				var un2 = ctx.remote.$on("credentials/reference-updated", function (ref) {
					if (ref === (state.cred || {}).ref) readCredential();
				});
				return function () { try { un && un(); } catch (e) {} try { un2 && un2(); } catch (e) {} };
			}, "web-search-tavily: form subscription");
			readCredential();
			ctx.slots.inject("settings.section", function () {
				return ctx.slots.register({
					name: "settings.section",
					id: "web-search-tavily",
					order: 15,
					label: "Web 搜索 (Tavily)"
				}, function () { return React.createElement(TavilySection, null); });
			});
			console.log("dsh-web-search-tavily: 设置页签已注册（settings.section）");
		};
		return module.exports;
	}
});

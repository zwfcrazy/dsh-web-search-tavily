/* dsh-web-search-tavily client：设置 → 插件配置 的 Tavily 卡片。
 * 手写 dsh client-module 包装格式（window.__ModuleLoader__.load，与官方包
 * 同构，参考 dsh-voice scripts/wrap-client.mjs 的产出形态），免构建链。
 * 卡片能力：API key 管理（走凭据域 credentials.set/unset/describe，明文
 * 永不进 settings）+ 常用配置（baseURL/searchDepth/topic/includeAnswer/
 * timeoutMs，settings.mutate 写用户层，可一键重置回组合层默认）。
 */
window.__ModuleLoader__.load({
	id: "dsh-web-search-tavily",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		var React = require("react");

		var NS = "web-search-tavily";
		var DEFAULT_REF = "TAVILY_API_KEY";
		var CTX = null; /* apply 时注入，模块单例（页面只加载一次） */

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
			msg: function (kind) { return { fontSize: 12, margin: "8px 0 0", color: kind === "err" ? "#c00" : "#0a8a4a" }; },
			sep: { borderTop: "1px solid var(--border,#eee)", margin: "10px 0" },
		};

		function currentRef(snap) {
			return (snap && snap.value && snap.value.apiKeyEnv) || DEFAULT_REF;
		}

		function TavilyCard() {
			var st = React.useState(undefined); var snap = st[0], setSnap = st[1];
			var cd = React.useState({ ref: DEFAULT_REF, configured: false, writable: true }); var cred = cd[0], setCred = cd[1];
			var df = React.useState(null); var drafts = df[0], setDrafts = df[1];
			var kd = React.useState(""); var keyDraft = kd[0], setKeyDraft = kd[1];
			var bs = React.useState(false); var busy = bs[0], setBusy = bs[1];
			var nt = React.useState(null); var note = nt[0], setNote = nt[1];

			React.useEffect(function () {
				if (!CTX) return;
				var api = CTX.connection.api;
				var bound = CTX.settingsScope.bind({ namespace: NS });
				var pull = function () { setSnap(bound.getSnapshot()); };
				pull();
				var off = bound.subscribe(pull);
				var ref = currentRef(bound.getSnapshot());
				api.credentials.describe({ refs: [ref] }).then(function (r) {
					if (!r || !r.result || !r.result.ok) return;
					var v = r.result.value.credentials[ref];
					setCred({ ref: ref, configured: !!(v && v.configured), writable: v ? v.writable !== false : true });
				}).catch(function () {});
				return function () { try { off(); } catch (e) {} };
			}, []);

			/* 草稿跟随快照（仅未手改时初始化一次） */
			React.useEffect(function () {
				if (!snap || !snap.value || drafts) return;
				var v = snap.value;
				setDrafts({
					baseURL: v.baseURL || "",
					searchDepth: v.searchDepth || "basic",
					topic: v.topic || "general",
					includeAnswer: v.includeAnswer !== false,
					timeoutMs: String(v.timeoutMs == null ? 30000 : v.timeoutMs),
				});
			}, [snap, drafts]);

			function say(text, kind) { setNote({ text: text, kind: kind || "ok" }); }
			function refreshCred() {
				var api = CTX.connection.api;
				var ref = currentRef(snap);
				api.credentials.describe({ refs: [ref] }).then(function (r) {
					if (!r || !r.result || !r.result.ok) return;
					var v = r.result.value.credentials[ref];
					setCred({ ref: ref, configured: !!(v && v.configured), writable: v ? v.writable !== false : true });
				}).catch(function () {});
			}

			function saveKey() {
				var api = CTX.connection.api;
				if (!keyDraft.trim()) { say("请先填入 key", "err"); return; }
				setBusy(true);
				api.credentials.set({ ref: currentRef(snap), value: keyDraft.trim() }).then(function () {
					setKeyDraft("");
					say("key 已写入凭据库（引用 " + currentRef(snap) + "），下次搜索即生效");
					refreshCred();
				}).catch(function (e) { say("写入失败：" + ((e && e.message) || e), "err"); }).finally(function () { setBusy(false); });
			}
			function clearKey() {
				var api = CTX.connection.api;
				setBusy(true);
				api.credentials.unset({ ref: currentRef(snap) }).then(function () {
					say("key 已清除");
					refreshCred();
				}).catch(function (e) { say("清除失败：" + ((e && e.message) || e), "err"); }).finally(function () { setBusy(false); });
			}
			function saveConfig() {
				var api = CTX.connection.api;
				if (!drafts) return;
				var t = parseInt(drafts.timeoutMs, 10);
				if (!(t >= 1000)) { say("超时需为 ≥1000 的整数（毫秒）", "err"); return; }
				setBusy(true);
				api.settings.mutate({ ns: NS, ops: [
					{ op: "set", path: ["baseURL"], value: drafts.baseURL.trim() },
					{ op: "set", path: ["searchDepth"], value: drafts.searchDepth === "advanced" ? "advanced" : "basic" },
					{ op: "set", path: ["topic"], value: drafts.topic.trim() || "general" },
					{ op: "set", path: ["includeAnswer"], value: drafts.includeAnswer },
					{ op: "set", path: ["timeoutMs"], value: t },
				] }).then(function (r) {
					if (r && r.result && !r.result.ok) say("保存被拒：" + ((r.result.error && r.result.error.message) || "未知原因"), "err");
					else say("配置已保存，即时生效");
				}).catch(function (e) { say("保存失败：" + ((e && e.message) || e), "err"); }).finally(function () { setBusy(false); });
			}
			function resetConfig() {
				var api = CTX.connection.api;
				if (!snap || !snap.user || Object.keys(snap.user).length === 0) { say("没有用户层覆盖可重置", "err"); return; }
				setBusy(true);
				var ops = Object.keys(snap.user).map(function (k) { return { op: "unset", path: [k] }; });
				api.settings.mutate({ ns: NS, ops: ops }).then(function (r) {
					if (r && r.result && !r.result.ok) say("重置被拒：" + ((r.result.error && r.result.error.message) || "未知原因"), "err");
					else { setDrafts(null); say("已重置为组合层默认"); }
				}).catch(function (e) { say("重置失败：" + ((e && e.message) || e), "err"); }).finally(function () { setBusy(false); });
			}

			var loading = !snap || snap.status === "loading";
			var v = (snap && snap.value) || {};
			var userKeys = snap && snap.user ? Object.keys(snap.user) : [];
			return React.createElement("div", { style: S.card },
				React.createElement("h3", { style: S.title }, "Tavily 网络搜索"),
				React.createElement("p", { style: S.desc },
					"web_search 工具的后端 provider（所有会话共用，含丁满语音）。免费档 1,000 credits/月；basic 1 credit/次，advanced 2。"),
				loading ? React.createElement("p", { style: S.hint }, "配置读取中…") : React.createElement("div", null,
					React.createElement("div", { style: S.row },
						React.createElement("span", { style: S.k }, "API Key"),
						React.createElement("span", { style: S.badge(cred.configured) }, cred.configured ? "已配置" : "未配置"),
						React.createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, "（引用 " + currentRef(snap) + "，存于 DSH 凭据库）")),
					React.createElement("div", { style: S.row },
						React.createElement("input", { style: S.input, type: "password", placeholder: cred.configured ? "留空保持不变，填写则覆盖" : "tvly-…", value: keyDraft, onChange: function (e) { setKeyDraft(e.target.value); } }),
						React.createElement("button", { style: S.btn(true), disabled: busy, onClick: saveKey }, "保存 Key"),
						cred.configured ? React.createElement("button", { style: S.btn(false), disabled: busy, onClick: clearKey }, "清除") : null),
					React.createElement("div", { style: S.sep }),
					drafts ? React.createElement("div", null,
						React.createElement("div", { style: S.row },
							React.createElement("span", { style: S.k }, "API 端点"),
							React.createElement("input", { style: S.input, value: drafts.baseURL, onChange: function (e) { setDrafts(Object.assign({}, drafts, { baseURL: e.target.value })); } })),
						React.createElement("div", { style: S.row },
							React.createElement("span", { style: S.k }, "搜索深度"),
							React.createElement("select", { style: S.input, value: drafts.searchDepth, onChange: function (e) { setDrafts(Object.assign({}, drafts, { searchDepth: e.target.value })); } },
								React.createElement("option", { value: "basic" }, "basic（1 credit）"),
								React.createElement("option", { value: "advanced" }, "advanced（2 credits，更慢更深）"))),
						React.createElement("div", { style: S.row },
							React.createElement("span", { style: S.k }, "主题"),
							React.createElement("input", { style: S.input, value: drafts.topic, onChange: function (e) { setDrafts(Object.assign({}, drafts, { topic: e.target.value })); } })),
						React.createElement("div", { style: S.row },
							React.createElement("span", { style: S.k }, "附带摘要"),
							React.createElement("input", { type: "checkbox", checked: drafts.includeAnswer, onChange: function (e) { setDrafts(Object.assign({}, drafts, { includeAnswer: e.target.checked })); } }),
							React.createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, "include_answer：Tavily 的合成答案随结果返回")),
						React.createElement("div", { style: S.row },
							React.createElement("span", { style: S.k }, "超时（毫秒）"),
							React.createElement("input", { style: Object.assign({}, S.input, { minWidth: 100 }), value: drafts.timeoutMs, onChange: function (e) { setDrafts(Object.assign({}, drafts, { timeoutMs: e.target.value })); } })),
						React.createElement("div", { style: S.row },
							React.createElement("button", { style: S.btn(true), disabled: busy || snap.writable === false, onClick: saveConfig }, "保存配置"),
							userKeys.length > 0 ? React.createElement("button", { style: S.btn(false), disabled: busy, onClick: resetConfig }, "重置默认") : null,
							userKeys.length > 0 ? React.createElement("span", { style: { fontSize: 12, opacity: 0.6 } }, "已覆盖：" + userKeys.join("、")) : null)
					) : null,
					note ? React.createElement("p", { style: S.msg(note.kind) }, note.text) : null,
					React.createElement("p", { style: S.hint },
						"后端选择（web.searchProvider）属 host 组合配置，当前为 tavily；切回 DeepSeek 请编辑 ~/.dsh/profiles/web/cordis.patch.yml 后重启。"))
			);
		}

		exports.name = "dsh-web-search-tavily-client";
		/* 0.2（2026-10-06）：settingsScope 服务在 0.2 客户端运行时已移除（全包 grep 零命中），
		 * 且 0.2 自带官方设置页 dsh-client-ui-settings-web-search（Web 搜索配置被官方收编）。
		 * 硬声明该 inject 会让模块永远 pending（"waiting for service: settingsScope"，
		 * 实测于 0.2.0-rc.2 真实 host）。改为能力探测：服务在（0.1）→ 照常挂卡；
		 * 不在（0.2）→ 跳过卡片，搜索功能不受影响。 */
		exports.inject = ["connection", "slots"];
		exports.apply = function (ctx) {
			CTX = ctx;
			/* 0.2（2026-10-06）：settingsScope 服务已移除。注意 cordis 语义：服务未声明时
			 * 访问 ctx 属性是抛异常（"cannot get property X without inject"）而非返回
			 * undefined——能力探测必须 try/catch 包裹（首版 if(!ctx.settingsScope) 实测
			 * 在 0.2 浏览器端炸掉 apply → 插件页"未能完成同步"报错）。 */
			var hasSettingsScope = false;
			try { ctx.settingsScope; hasSettingsScope = true; } catch (e) { /* 0.2：服务已移除 */ }
			if (!hasSettingsScope) {
				console.log("dsh-web-search-tavily: OK（dsh 0.2 模式，搜索功能完整；配置请用系统设置 → Web 搜索页）");
				return;
			}
			try {
				ctx.slots.inject("settings.plugin.item", function () {
					return ctx.slots.register({ name: "settings.plugin.item", key: NS }, TavilyCard);
				});
			} catch (e) {
				/* 0.2（2026-10-06）：设置卡锚点体系随 host 导出消失而重work，slot 缺失时
				 * 降级跳过——卡片仅是配置入口，provider 功能不受影响。 */
				console.log("dsh-web-search-tavily: settings.plugin.item slot 不可用，设置卡降级跳过", e && e.message);
			}
		};
		return module.exports;
	}
});

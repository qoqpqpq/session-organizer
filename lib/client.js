/**
 * session-organizer — client half
 *
 * Injects a "会话整理" button in the sidebar footer actions and a floating
 * panel overlay, both through the shared `slots` service (the client kernel
 * gives every bundle row the same root Context, so `ctx.get('slots')` works
 * exactly as it does for dynamic session plugins). Talks to the host half over
 * the fenced POST /session-organizer/api/<method> JSON API.
 *
 * Only `react` from the shell's static module map; all visuals use the app's
 * theme variables via CSS custom properties.
 */
window.__ModuleLoader__.load({
	id: "session-organizer",
	factory: (require) => {
		const React = require("react");
		const { useState, useEffect } = React;
		const h = React.createElement;

		// ------------------------------------------------------------ api

		async function call(method, payload) {
			const response = await fetch(`/session-organizer/api/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload ?? {}),
			});
			const parsed = await response.json().catch(() => null);
			if (!response.ok || parsed === null || parsed.ok !== true) {
				throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`);
			}
			return parsed.value;
		}

		// ------------------------------------------------------------ store

		const store = { open: false, report: null, busy: false, error: "", msg: "", targets: [], targetId: "" };
		const listeners = new Set();
		function setStore(patch) {
			Object.assign(store, patch);
			for (const fn of listeners) {
				try { fn(); } catch (e) {}
			}
		}
		function useStore() {
			const [, force] = useState(0);
			useEffect(() => {
				const fn = () => force((x) => x + 1);
				listeners.add(fn);
				return () => listeners.delete(fn);
			}, []);
			return store;
		}

		// ------------------------------------------------------------ actions

		async function scan(opts) {
			// A post-action refresh must NOT wipe the success/error message the
			// action just set — that was the "no feedback" bug: archive() set
			// msg then called scan(), which reset msg:"" in the same tick, so
			// the user never saw "已归档 N 个会话".
			const keepMsg = !!(opts && opts.keepMsg);
			setStore({ busy: true, error: keepMsg ? store.error : "", msg: keepMsg ? store.msg : "" });
			try {
				const res = await call("scan");
				setStore({ report: res.report, busy: false, error: keepMsg ? store.error : "", msg: keepMsg ? store.msg : "" });
				await loadTargets();
			} catch (e) {
				setStore({ busy: false, error: String((e && e.message) || e) });
			}
		}

		async function archiveIds(ids) {
			if (!ids || !ids.length) return;
			setStore({ busy: true, error: "", msg: "" });
			try {
				const res = await call("archive", { sessionIds: ids });
				setStore({ busy: false, msg: "已归档 " + ((res && res.done) ? res.done.length : 0) + " 个会话" });
			} catch (e) {
				setStore({ busy: false, error: String((e && e.message) || e) });
			}
			await scan({ keepMsg: true });
		}

		async function loadTargets() {
			try {
				const res = await call("targets");
				setStore({ targets: (res && res.targets) || [] });
			} catch (e) {}
		}

		async function mergeIds(ids, archiveSource) {
			if (!ids || !ids.length) return;
			const targetId = store.targetId || undefined;
			setStore({ busy: true, error: "", msg: "" });
			try {
				const res = await call("merge", { sessionIds: ids, archiveSource: !!archiveSource, targetId });
				setStore({ busy: false, msg: "已合并为会话 " + (res && res.mergedId) });
			} catch (e) {
				setStore({ busy: false, error: String((e && e.message) || e) });
			}
			await scan({ keepMsg: true });
			await loadTargets();
		}

		// ------------------------------------------------------------ format

		function fmt(ts) {
			if (!ts) return "";
			const d = new Date(ts);
			return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
		}

		// ------------------------------------------------------------ styles

		const btnStyle = { background: "rgba(120,120,140,0.18)", border: "1px solid rgba(120,120,140,0.4)", borderRadius: "6px", padding: "4px 10px", cursor: "pointer", color: "inherit", font: "inherit" };
		const panelStyle = { position: "fixed", right: "16px", bottom: "56px", width: "460px", maxWidth: "calc(100vw - 32px)", maxHeight: "70vh", overflow: "auto", background: "var(--bg, #1b1b22)", color: "var(--fg, #e6e6ea)", border: "1px solid rgba(140,140,160,0.35)", borderRadius: "10px", boxShadow: "0 8px 30px rgba(0,0,0,0.4)", zIndex: 9999, padding: "12px" };
		const headStyle = { fontWeight: 600, marginBottom: "8px" };
		const secStyle = { marginBottom: "10px", padding: "8px", background: "rgba(255,255,255,0.04)", borderRadius: "8px" };
		const rowStyle = { display: "flex", alignItems: "center", gap: "6px", padding: "4px 0", fontSize: "12px" };
		const mutedStyle = { color: "var(--muted, #9a9aa5)", fontSize: "11px" };
		const flexSpan = { flex: 1 };
		const btnRowStyle = { display: "flex", gap: "6px", marginTop: "4px" };
		const clusterStyle = { marginBottom: "8px" };
		const clusterLabelStyle = { fontWeight: 600, fontSize: "12px" };
		const panelHeaderStyle = { display: "flex", justifyContent: "space-between", alignItems: "center" };

		// ------------------------------------------------------------ bits

		function btn(onClick, label) {
			return h("button", { style: btnStyle, onClick: onClick }, label);
		}
		function text(children, style) {
			return h("span", { style: style }, children);
		}
		function row(children) {
			return h("div", { style: rowStyle }, children);
		}
		// "归档" badge — marks sessions hidden from the sidebar so the count
		// discrepancy (plugin shows 66, sidebar shows fewer) is understandable.
		function archBadge(m) {
			if (!m || !m.archived) return null;
			return text("归档", { color: "#d9a24a", fontSize: "10px", border: "1px solid rgba(217,162,74,0.5)", borderRadius: "4px", padding: "1px 4px", marginRight: "4px", flexShrink: 0 });
		}

		function renderStale(list) {
			const inner = (list || []).map(function (m) {
				return row([
					archBadge(m),
					text(m.title || m.id, flexSpan),
					text("最近 " + fmt(m.lastActive), mutedStyle),
					btn(function () { archiveIds([m.id]); }, "归档"),
				]);
			});
			const body = (list || []).length === 0 ? text("无", mutedStyle) : inner;
			return h("div", { style: secStyle }, [
				h("div", { style: headStyle }, "⚠ 长期未用（" + ((list || []).length) + "）"),
				body,
			]);
		}

		function renderMeaningless(list) {
			const inner = (list || []).map(function (m) {
				return row([
					archBadge(m),
					text((m.title || m.id) + "（消息 " + m.counts.user + "/回复 " + m.counts.assistant + "）", flexSpan),
					btn(function () { archiveIds([m.id]); }, "归档"),
				]);
			});
			const body = (list || []).length === 0 ? text("无", mutedStyle) : inner;
			return h("div", { style: secStyle }, [
				h("div", { style: headStyle }, "⚫ 无实质内容（" + ((list || []).length) + "）"),
				body,
			]);
		}

		function renderCluster(c) {
			const members = c.members.map(function (m) {
				return row([
					archBadge(m),
					text(m.title || m.id, flexSpan),
					text(fmt(m.lastActive), mutedStyle),
				]);
			});
			const buttons = h("div", { style: btnRowStyle }, [
				btn(function () { mergeIds(c.members.map(function (m) { return m.id; }), false); }, "合并"),
				btn(function () { mergeIds(c.members.map(function (m) { return m.id; }), true); }, "合并并归档原会话"),
				btn(function () { archiveIds(c.members.map(function (m) { return m.id; })); }, "全部归档"),
			]);
			return h("div", { style: clusterStyle }, [
				h("div", { style: clusterLabelStyle }, c.label + "（" + c.members.length + "）"),
				members,
				buttons,
			]);
		}

		function renderClusters(list) {
			const inner = (list || []).map(renderCluster);
			const body = (list || []).length === 0 ? text("无", mutedStyle) : inner;
			return h("div", { style: secStyle }, [
				h("div", { style: headStyle }, "📁 同主题分组（" + ((list || []).length) + "）"),
				body,
			]);
		}

		function s_busy() {
			return store.busy ? h("div", { style: mutedStyle }, "处理中…") : null;
		}
		function s_error() {
			return store.error ? h("div", { style: { color: "#e06c6c" } }, store.error) : null;
		}
		function s_msg() {
			return store.msg ? h("div", { style: { color: "#7fc06c" } }, store.msg) : null;
		}

		function renderTargetSelect() {
			const selStyle = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(120,120,140,0.4)", borderRadius: "6px", padding: "4px 6px", color: "inherit", font: "inherit", maxWidth: "100%" };
			const opts = [h("option", { key: "__new__", value: "" }, "（新建合并会话）")].concat(
				(store.targets || []).map(function (t) { return h("option", { key: t.id, value: t.id }, t.title); })
			);
			return h("div", { style: secStyle }, [
				h("div", { style: headStyle }, "合并目标会话"),
				h("div", { style: rowStyle }, [
					h("select", {
						style: selStyle,
						value: store.targetId || "",
						onChange: function (e) { setStore({ targetId: e.target.value }); },
					}, opts),
				]),
				h("div", { style: mutedStyle }, "选择后，合并的内容会追加到该会话；留空则新建一个合并会话。"),
			]);
		}

		function renderPanel(rep) {
			return h("div", { style: panelStyle }, [
				h("div", { style: panelHeaderStyle }, [
					h("span", { style: headStyle }, "会话整理"),
					btn(function () { scan(); }, "刷新"),
					btn(function () { setStore({ open: false }); }, "关闭"),
				]),
				s_busy(),
				s_error(),
				s_msg(),
				rep ? h("div", null, [
					text("共 " + rep.total + " 个会话 · 扫描于 " + fmt(rep.scannedAt), mutedStyle),
					(rep.archivedCount ? h("div", { style: mutedStyle }, "其中 " + rep.archivedCount + " 个已归档（侧栏不显示，仅插件可见）") : null),
					renderTargetSelect(),
					renderStale(rep.stale),
					renderMeaningless(rep.meaningless),
					renderClusters(rep.clusters),
				]) : null,
			]);
		}

		// ------------------------------------------------------------ apply

		// Declare `slots` as a hard dependency: the boot loader activates every
		// bundle entry in parallel, and without this the fiber would run `apply`
		// before dsh-client-runtime has provided the `slots` service, so the
		// button would never register. Declaring it parks the fiber until the
		// service appears (same pattern as dsh-client-ui-sidebar / ui-cordis).
		const inject = ["slots"];

		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;

			slots.inject("sidebar.footer.action", function () {
				return slots.register(
					{ name: "sidebar.footer.action", id: "session-organizer-entry", order: 4, label: "会话整理" },
					function () {
						const s = useStore();
						return h("button", {
							style: btnStyle,
							onClick: function () {
								const n = !s.open;
								setStore({ open: n });
								if (n) scan();
							},
						}, "会话整理");
					}
				);
			});

			slots.inject("shell.overlay", function () {
				return slots.register(
					{ name: "shell.overlay", id: "session-organizer-panel", order: 200 },
					function () {
						const s = useStore();
						if (!s.open) return null;
						return renderPanel(s.report);
					}
				);
			});
		}

		return { apply, inject };
	},
});

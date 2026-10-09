// dsh-session-delete — browser half.
//
// Adds, on top of the shipped Archive feature:
//   1. A dedicated session-management main panel (sidebar icon → page):
//      every workspace's sessions with multi-select, batch delete from disk,
//      batch archive / unarchive, and the sidebar's own three archive
//      filters (hide-archived / show-all / archived-only, same semantics).
//   2. A "delete session" row in each session's "..." menu, right after the
//      built-in archive / rename / fork items, with a confirm dialog.
//
// Data sources: the same client projections the sidebar reads —
// ctx.workspaces.list (workspaces + archived/pinned sets, live via the
// workspace follow stream) and ctx.sessions.list (titles, timestamps,
// running/open flags). Archive/unarchive go through ctx.uiWorkspace so the
// sidebar refreshes through the exact same code path as its own buttons.
// Only DELETION talks to this plugin's Host bridge (/api/dsh-session-delete),
// because the shipped Host services intentionally have no such API.
//
// Safety: rows that are running or currently open cannot be deleted (the
// Host refuses live sessions again); every delete requires an explicit
// confirm; the Host re-verifies path guards before rm -rf.
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let client_store = require("@deepseek-ai/dsh-client-store");

		const PANEL_ID = "session-delete";
		const NS = "sessionDelete";
		const API_PREFIX = "/api/dsh-session-delete";

		//#region css
		const css = [
			".dshsd-page{height:100%;overflow:auto;display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}",
			".dshsd-head{display:flex;align-items:center;gap:12px;padding:18px 24px 6px;flex-wrap:wrap}",
			".dshsd-headIcon{color:var(--dsw-alias-label-secondary);flex:none;display:flex}",
			".dshsd-title{font-size:18px;font-weight:600;margin:0}",
			".dshsd-headRight{margin-left:auto;display:flex;align-items:center;gap:8px}",
			".dshsd-desc{padding:0 24px;margin:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12.5px;line-height:1.6}",
			".dshsd-toolbar{display:flex;align-items:center;gap:10px;padding:10px 24px;flex-wrap:wrap}",
			".dshsd-counts{color:var(--dsw-alias-label-secondary);font-size:12.5px;white-space:nowrap}",
			".dshsd-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:9px;overflow:hidden}",
			".dshsd-segBtn{appearance:none;font:inherit;font-size:12.5px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:5px 12px;cursor:pointer;transition:background .15s,color .15s}",
			".dshsd-segBtn:hover{background:var(--dsw-alias-bg-layer-1)}",
			".dshsd-segBtnOn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}",
			".dshsd-btn{appearance:none;font:inherit;font-size:12.5px;font-weight:500;cursor:pointer;border-radius:8px;padding:5px 12px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-primary);display:inline-flex;align-items:center;gap:6px;transition:background .15s,border-color .15s,opacity .15s}",
			".dshsd-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-1)}",
			".dshsd-btn:disabled{opacity:.45;cursor:default}",
			".dshsd-btnDanger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".dshsd-btnDanger:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-base))}",
			".dshsd-batch{display:flex;align-items:center;gap:8px;margin:0 24px;padding:8px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);flex-wrap:wrap}",
			".dshsd-batchInfo{font-size:12.5px;color:var(--dsw-alias-label-secondary)}",
			".dshsd-batchSp{flex:1}",
			".dshsd-list{flex:1;padding:4px 24px 28px;display:flex;flex-direction:column;gap:16px}",
			".dshsd-group{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}",
			".dshsd-groupHead{display:flex;align-items:center;gap:10px;padding:9px 14px;background:var(--dsw-alias-bg-layer-2);border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dshsd-groupTitle{font-size:13px;font-weight:600}",
			".dshsd-groupPath{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dshsd-groupCount{font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
			".dshsd-check{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;cursor:pointer;flex:none}",
			".dshsd-rows{display:flex;flex-direction:column}",
			".dshsd-row{display:flex;align-items:center;gap:10px;padding:8px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}",
			".dshsd-row:last-child{border-bottom:0}",
			".dshsd-row:hover{background:var(--dsw-alias-bg-layer-2)}",
			".dshsd-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}",
			".dshsd-rowTitle{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshsd-rowSub{font-size:11.5px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));display:flex;gap:8px;align-items:center;white-space:nowrap;overflow:hidden}",
			".dshsd-badge{font-size:10.5px;font-weight:600;border-radius:999px;padding:1px 7px;flex:none}",
			".dshsd-badgeArchived{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1)}",
			".dshsd-badgePinned{color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary)}",
			".dshsd-badgeRunning{color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary)}",
			".dshsd-badgeOpen{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-brand-primary)}",
			".dshsd-rowActions{display:flex;gap:6px;flex:none}",
			".dshsd-iconBtn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;width:26px;height:26px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:color .15s,border-color .15s,background .15s}",
			".dshsd-iconBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}",
			".dshsd-iconBtn:disabled{opacity:.4;cursor:default}",
			".dshsd-iconBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
			".dshsd-empty{padding:48px 24px;text-align:center;color:var(--dsw-alias-label-secondary)}",
			".dshsd-emptyTitle{font-size:14px;font-weight:600;margin-bottom:6px}",
			".dshsd-result{margin:0 24px;padding:6px 14px;border-radius:8px;font-size:12.5px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary)}",
			".dshsd-resultErr{color:var(--dsw-alias-state-error-primary)}",
			".dshsd-confirmList{max-height:180px;overflow:auto;font-size:12.5px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 12px;margin:0 0 4px;display:flex;flex-direction:column;gap:4px}",
			".dshsd-confirmRow{flex:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dshsd-foot{display:flex;justify-content:flex-end;gap:8px;padding-top:8px}"
		].join("");
		const tagId = "dsh-session-delete/page.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=\"" + tagId + "\"]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-delete";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region i18n
		const zh = {
			panel: "会话管理",
			pageTitle: "会话管理",
			pageDesc: "比归档更进一步：归档只是隐藏，删除会把会话记录从硬盘上永久移除。运行中或已打开的会话不能删除。",
			filterLabel: "筛选",
			filterHide: "隐藏已归档",
			filterShow: "全部显示",
			filterOnly: "仅显示已归档",
			counts: "{n} 个会话 · 已归档 {m} · 占用 {size}",
			countsNoArchived: "{n} 个会话 · 占用 {size}",
			refresh: "刷新",
			refreshing: "刷新中…",
			loading: "正在加载…",
			selectAll: "全选",
			clearSelection: "清除选择",
			selected: "已选 {n} 个会话 · 共 {size}",
			selectedNoSize: "已选 {n} 个会话",
			batchArchive: "归档",
			batchUnarchive: "取消归档",
			batchDelete: "删除…",
			batchEmptyDisabled: "运行中/已打开的会话不可删除",
			archive: "归档",
			unarchive: "取消归档",
			deleteOne: "删除",
			badgeArchived: "已归档",
			badgePinned: "置顶",
			badgeRunning: "运行中",
			badgeOpen: "已打开",
			unknownWorkspace: "未分组会话",
			emptyTitle: "没有符合条件的会话",
			emptyHint: "切换上方筛选，或先去侧栏归档一些会话。",
			resultOk: "{n} 个成功",
			resultFail: "{n} 个失败",
			confirmTitleOne: "删除这个会话？",
			confirmTitleMany: "删除这 {n} 个会话？",
			confirmDesc: "将从硬盘上永久删除所选会话的记录文件，此操作不可撤销。归档状态与置顶会一并清除。",
			confirmSize: "合计占用 {size}",
			confirmButton: "永久删除",
			confirmButtonMany: "永久删除 {n} 个",
			cancel: "取消",
			close: "关闭",
			menuDelete: "删除会话…",
			menuDeleteTitle: "删除“{title}”？",
			errorLive: "会话正在运行或已打开，请先关闭。",
			errorGeneric: "删除失败：",
		};
		const en = {
			panel: "Sessions",
			pageTitle: "Session Manager",
			pageDesc: "One step beyond Archive: archiving only hides, deleting permanently removes the session log from disk. Running or open sessions cannot be deleted.",
			filterLabel: "Filter",
			filterHide: "Hide archived",
			filterShow: "Show all",
			filterOnly: "Archived only",
			counts: "{n} sessions · {m} archived · {size}",
			countsNoArchived: "{n} sessions · {size}",
			refresh: "Refresh",
			refreshing: "Refreshing…",
			loading: "Loading…",
			selectAll: "Select all",
			clearSelection: "Clear",
			selected: "{n} selected · {size}",
			selectedNoSize: "{n} selected",
			batchArchive: "Archive",
			batchUnarchive: "Unarchive",
			batchDelete: "Delete…",
			batchEmptyDisabled: "Running/open sessions cannot be deleted",
			archive: "Archive",
			unarchive: "Unarchive",
			deleteOne: "Delete",
			badgeArchived: "Archived",
			badgePinned: "Pinned",
			badgeRunning: "Running",
			badgeOpen: "Open",
			unknownWorkspace: "Ungrouped sessions",
			emptyTitle: "No sessions match this filter",
			emptyHint: "Try another filter, or archive some sessions from the sidebar first.",
			resultOk: "{n} succeeded",
			resultFail: "{n} failed",
			confirmTitleOne: "Delete this session?",
			confirmTitleMany: "Delete these {n} sessions?",
			confirmDesc: "The selected session logs will be permanently removed from disk. This cannot be undone; archive and pin state is cleared too.",
			confirmSize: "Total size {size}",
			confirmButton: "Delete permanently",
			confirmButtonMany: "Delete {n} permanently",
			cancel: "Cancel",
			close: "Close",
			menuDelete: "Delete session…",
			menuDeleteTitle: "Delete “{title}”?",
			errorLive: "The session is running or open — close it first.",
			errorGeneric: "Delete failed: ",
		};
		//#endregion

		//#region helpers
		function formatBytes(bytes) {
			if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
			if (bytes < 1024) return bytes + " B";
			const units = ["KB", "MB", "GB", "TB"];
			let value = bytes;
			let unit = "B";
			for (const next of units) {
				if (value < 1024) break;
				value /= 1024;
				unit = next;
			}
			return (value >= 100 ? Math.round(value) : value.toFixed(1)) + " " + unit;
		}

		function relativeTime(timestamp, now) {
			const ms = typeof timestamp === "number" ? timestamp : typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
			if (!Number.isFinite(ms)) return "";
			const diff = Math.max(0, now - ms);
			const minute = 60 * 1000;
			if (diff < minute) return "<1m";
			if (diff < 60 * minute) return Math.floor(diff / minute) + "m";
			if (diff < 24 * 60 * minute) return Math.floor(diff / (60 * minute)) + "h";
			if (diff < 30 * 24 * 60 * minute) return Math.floor(diff / (24 * 60 * minute)) + "d";
			if (diff < 365 * 24 * 60 * minute) return Math.floor(diff / (30 * 24 * 60 * minute)) + "mo";
			return Math.floor(diff / (365 * 24 * 60 * minute)) + "y";
		}

		/** A ticking Date.now() so relative labels stay fresh without leaking timers. */
		function useNow(intervalMs = 30000) {
			const [now, setNow] = react.useState(() => Date.now());
			react.useEffect(() => {
				const timer = setInterval(() => setNow(Date.now()), intervalMs);
				return () => clearInterval(timer);
			}, [intervalMs]);
			return now;
		}

		async function apiList() {
			const response = await fetch(API_PREFIX + "/list", { method: "GET" });
			return await response.json();
		}

		async function apiDelete(sessionIds) {
			const response = await fetch(API_PREFIX + "/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ sessionIds }),
			});
			return await response.json();
		}
		//#endregion

		//#region shared row model
		/**
		 * The sidebar's exact visibility semantics (ui-workspace sessionVisible):
		 * subagent children never list, the blank "new session" placeholder only
		 * when it is the current view, then the three-way archived filter.
		 */
		function sessionVisible(summary, currentSessionId, archivedSet, filter) {
			if (summary === undefined) return false;
			if (summary.origin === "subagent") return false;
			if (summary.blank === true && summary.id !== currentSessionId) return false;
			if (filter === "default") return !archivedSet.has(summary.id);
			if (filter === "show") return true;
			if (filter === "only") return archivedSet.has(summary.id);
			return !archivedSet.has(summary.id);
		}

		function isOpen(summary) {
			return summary !== undefined && ((summary.retainedBy?.mainView ?? 0) > 0);
		}

		function deleteBlocked(summary) {
			// Record-less stale entries (archive-set ghosts) stay deletable so
			// they can be cleaned up; the Host still refuses sessions that are
			// genuinely live. Visible rows with a record keep the strict rule.
			if (summary === undefined) return false;
			return summary.running === true || isOpen(summary);
		}
		//#endregion

		//#region components
		function PanelIcon({ size }) {
			return react_jsx_runtime.jsx(primitives.IconArchiveOutlineRegular, { size });
		}

		function RowBadges({ summary, archived, pinned, t }) {
			return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
				children: [
					archived ? react_jsx_runtime.jsx("span", { className: "dshsd-badge dshsd-badgeArchived", children: t("badgeArchived") }) : null,
					pinned ? react_jsx_runtime.jsx("span", { className: "dshsd-badge dshsd-badgePinned", children: t("badgePinned") }) : null,
					summary?.running === true ? react_jsx_runtime.jsx("span", { className: "dshsd-badge dshsd-badgeRunning", children: t("badgeRunning") }) : null,
					isOpen(summary) ? react_jsx_runtime.jsx("span", { className: "dshsd-badge dshsd-badgeOpen", children: t("badgeOpen") }) : null,
				],
			});
		}

		function SessionRow({ row, selected, onToggle, onArchive, onUnarchive, onRequestDelete, t, now }) {
			const { summary } = row;
			const title = summary?.displayTitle ?? row.id;
			const archived = row.archived;
			return react_jsx_runtime.jsxs("div", {
				className: "dshsd-row",
				children: [
					react_jsx_runtime.jsx("input", {
						type: "checkbox",
						className: "dshsd-check",
						"aria-label": title,
						checked: selected,
						onChange: () => onToggle(row.id),
					}),
					react_jsx_runtime.jsxs("div", {
						className: "dshsd-rowMain",
						children: [
							react_jsx_runtime.jsxs("div", { className: "dshsd-rowTitle", children: [title] }),
							react_jsx_runtime.jsxs("div", { className: "dshsd-rowSub", children: [
								relativeTime(summary?.updatedAt, now),
								row.size !== undefined ? react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [" · ", formatBytes(row.size)] }) : null,
								react_jsx_runtime.jsx(RowBadges, { summary, archived, pinned: row.pinned, t }),
							] }),
						],
					}),
					react_jsx_runtime.jsxs("div", { className: "dshsd-rowActions", children: [
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dshsd-iconBtn",
							title: archived ? t("unarchive") : t("archive"),
							"aria-label": archived ? t("unarchive") : t("archive"),
							disabled: !archived && summary?.running === true,
							onClick: () => (archived ? onUnarchive : onArchive)(row.id),
							children: archived
								? react_jsx_runtime.jsx(primitives.IconUnarchiveOutlineRegular, { size: 14 })
								: react_jsx_runtime.jsx(primitives.IconArchiveOutlineRegular, { size: 14 }),
						}),
						react_jsx_runtime.jsx("button", {
							type: "button",
							className: "dshsd-iconBtn dshsd-iconBtnDanger",
							title: deleteBlocked(summary) ? t("batchEmptyDisabled") : t("deleteOne"),
							"aria-label": t("deleteOne"),
							disabled: deleteBlocked(summary),
							onClick: () => onRequestDelete([row.id]),
							children: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
						}),
					] }),
				],
			});
		}

		function ConfirmDialog({ open, title, description, items, totalSize, confirmLabel, onCancel, onConfirm, busy, error, t }) {
			if (!open) return null;
			return react_jsx_runtime.jsx(primitives.Modal, {
				open: true,
				onClose: busy ? undefined : onCancel,
				closeLabel: t("close"),
				title,
				description,
				footer: react_jsx_runtime.jsxs("div", { className: "dshsd-foot", children: [
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: onCancel, disabled: busy, children: t("cancel") }),
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn dshsd-btnDanger", onClick: onConfirm, disabled: busy, children: busy ? "…" : confirmLabel }),
				] }),
				children: react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, { children: [
					totalSize > 0 ? react_jsx_runtime.jsx("p", { style: { margin: "0 0 6px", fontSize: "12.5px", color: "var(--dsw-alias-label-secondary)" }, children: t("confirmSize", { size: formatBytes(totalSize) }) }) : null,
					react_jsx_runtime.jsx("div", { className: "dshsd-confirmList", children: items.map((item) => react_jsx_runtime.jsx("div", { className: "dshsd-confirmRow", children: item }, item)) }),
					error ? react_jsx_runtime.jsx("p", { className: "dshsd-resultErr", style: { fontSize: "12.5px", margin: "6px 0 0" }, children: error }) : null,
				] }),
			});
		}

		/**
		 * The main-panel management page. Receives reactive hooks from the slot
		 * framework (hooks.workspaces → useWorkspaces, hooks.sessions →
		 * useSessions) plus plain action callbacks from the inject factory.
		 */
		function SessionManagerPage(props) {
			const { useWorkspaces, useSessions, archiveSession, unarchiveSession, t } = props;
			const workspaceSnapshot = useWorkspaces((snapshot) => snapshot);
			const sessionsSnapshot = useSessions((snapshot) => snapshot);
			const now = useNow();
			const [filter, setFilter] = react.useState("default");
			const [selected, setSelected] = react.useState(() => []);
			const [sizes, setSizes] = react.useState(() => ({}));
			const [sizesLoading, setSizesLoading] = react.useState(true);
			const [result, setResult] = react.useState(null);
			const [confirm, setConfirm] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [confirmError, setConfirmError] = react.useState("");

			const refreshSizes = react.useCallback(() => {
				setSizesLoading(true);
				apiList().then((data) => {
					if (data && data.ok) setSizes(data.sizes ?? {});
				}).catch(() => {}).finally(() => setSizesLoading(false));
			}, []);
			react.useEffect(() => {
				refreshSizes();
			}, [refreshSizes]);

			const byId = sessionsSnapshot?.byId ?? {};
			const archivedSet = react.useMemo(() => new Set(workspaceSnapshot?.archivedSessionIds ?? []), [workspaceSnapshot]);
			const pinnedSet = react.useMemo(() => new Set(workspaceSnapshot?.pinnedSessionIds ?? []), [workspaceSnapshot]);
			const currentSessionId = react.useMemo(() => {
				for (const session of Object.values(byId)) {
					if (isOpen(session)) return session.id;
				}
				return undefined;
			}, [byId]);

			// Groups: one per workspace, then a stray group for unaccounted ids
			// (mirrors the sidebar's flat tail group).
			const groups = react.useMemo(() => {
				const items = workspaceSnapshot?.items ?? [];
				const accounted = new Set();
				const out = [];
				for (const workspace of items) {
					const rows = [];
					for (const id of workspace.sessionIds) {
						accounted.add(id);
						const summary = byId[id];
						if (!sessionVisible(summary, currentSessionId, archivedSet, filter)) continue;
						rows.push({ id, summary, archived: archivedSet.has(id), pinned: pinnedSet.has(id), size: sizes[id] });
					}
					rows.sort((left, right) => (right.summary?.updatedAt ?? 0) - (left.summary?.updatedAt ?? 0));
					out.push({ key: workspace.workspaceId, title: workspace.title || workspace.path, path: workspace.path, rows });
				}
				const strays = [];
				for (const id of sessionsSnapshot?.ids ?? []) {
					if (accounted.has(id)) continue;
					const summary = byId[id];
					if (!sessionVisible(summary, currentSessionId, archivedSet, filter)) continue;
					strays.push({ id, summary, archived: archivedSet.has(id), pinned: pinnedSet.has(id), size: sizes[id] });
				}
				// Stale archive-set entries with no client session record left
				// (e.g. a partially-failed delete). Entries that still HAVE a
				// record were already filtered by the stray loop above — adding
				// them here would bypass the archived filter. Record-less entries
				// surface only under show/only, never under hide-archived.
				for (const id of workspaceSnapshot?.archivedSessionIds ?? []) {
					if (accounted.has(id) || byId[id] !== undefined) continue;
					if (filter === "default") continue;
					strays.push({ id, summary: undefined, archived: true, pinned: pinnedSet.has(id), size: sizes[id] });
				}
				strays.sort((left, right) => (right.summary?.updatedAt ?? 0) - (left.summary?.updatedAt ?? 0));
				if (strays.length > 0) out.push({ key: "", title: t("unknownWorkspace"), path: "", rows: strays });
				return out.filter((group) => group.rows.length > 0);
			}, [workspaceSnapshot, sessionsSnapshot, byId, archivedSet, pinnedSet, filter, sizes, currentSessionId, t]);

			const allRows = react.useMemo(() => groups.flatMap((group) => group.rows), [groups]);
			// Total = every unique session that would appear under "show all"
			// (workspace-accounted + strays, sidebar visibility rules) plus
			// record-less stale archive entries, so the header number matches
			// what the list can actually show.
			const totalCount = react.useMemo(() => {
				const seen = new Set();
				const consider = (id) => {
					if (seen.has(id)) return;
					const summary = byId[id];
					if (summary === undefined) return;
					if (summary.origin === "subagent") return;
					if (summary.blank === true && summary.id !== currentSessionId) return;
					seen.add(id);
				};
				for (const workspace of workspaceSnapshot?.items ?? []) for (const id of workspace.sessionIds) consider(id);
				for (const id of sessionsSnapshot?.ids ?? []) consider(id);
				let count = seen.size;
				for (const id of workspaceSnapshot?.archivedSessionIds ?? []) {
					if (!seen.has(id) && byId[id] === undefined) count += 1;
				}
				return count;
			}, [workspaceSnapshot, sessionsSnapshot, byId, currentSessionId]);
			const archivedCount = workspaceSnapshot?.archivedSessionIds?.length ?? 0;
			const totalSize = react.useMemo(() => Object.values(sizes).reduce((sum, value) => sum + (typeof value === "number" ? value : 0), 0), [sizes]);

			const selectedIds = selected;
			const selectedSize = react.useMemo(
				() => selectedIds.reduce((sum, id) => sum + (typeof sizes[id] === "number" ? sizes[id] : 0), 0),
				[selectedIds, sizes],
			);
			const selectableIds = react.useMemo(() => allRows.filter((row) => !deleteBlocked(row.summary)).map((row) => row.id), [allRows]);
			const allSelectableSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.includes(id));

			const toggleRow = react.useCallback((id) => {
				setSelected((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]));
			}, []);
			const toggleAll = react.useCallback(() => {
				setSelected((current) => (allSelectableSelected ? [] : selectableIds));
			}, [allSelectableSelected, selectableIds]);

			const runArchive = react.useCallback(async (ids) => {
				let ok = 0;
				let fail = 0;
				for (const id of ids) {
					try {
						await archiveSession(id);
						ok += 1;
					} catch {
						fail += 1;
					}
				}
				setResult({ ok, fail });
			}, [archiveSession]);
			const runUnarchive = react.useCallback(async (ids) => {
				let ok = 0;
				let fail = 0;
				for (const id of ids) {
					try {
						await unarchiveSession(id);
						ok += 1;
					} catch {
						fail += 1;
					}
				}
				setResult({ ok, fail });
			}, [unarchiveSession]);

			const requestDelete = react.useCallback((ids) => {
				const usable = ids.filter((id) => !deleteBlocked(byId[id]));
				if (usable.length === 0) return;
				setConfirmError("");
				setConfirm(usable);
			}, [byId]);

			const confirmDelete = react.useCallback(async () => {
				if (confirm === null) return;
				setBusy(true);
				setConfirmError("");
				try {
					const data = await apiDelete(confirm);
					if (!data || !data.ok) {
						setConfirmError((data && data.message) || t("errorGeneric"));
						return;
					}
					const results = data.results ?? [];
					const failed = results.filter((entry) => !entry.ok);
					setResult({
						ok: results.length - failed.length,
						fail: failed.length,
						// Host messages are exact (e.g. 会话有正在进行的工作（agent）) —
						// surface the first real reason instead of a blanket hint.
						message: failed[0]?.message,
					});
					setConfirm(null);
					setSelected((current) => current.filter((id) => !results.some((entry) => entry.id === id && entry.ok)));
					refreshSizes();
				} catch (error) {
					setConfirmError(t("errorGeneric") + (error instanceof Error ? error.message : String(error)));
				} finally {
					setBusy(false);
				}
			}, [confirm, refreshSizes, t]);

			const loading = (workspaceSnapshot?.state ?? "ready") === "loading";

			return react_jsx_runtime.jsxs("div", { className: "dshsd-page", children: [
				react_jsx_runtime.jsxs("div", { className: "dshsd-head", children: [
					react_jsx_runtime.jsx("span", { className: "dshsd-headIcon", children: react_jsx_runtime.jsx(primitives.IconArchiveOutlineRegular, { size: 20 }) }),
					react_jsx_runtime.jsx("h1", { className: "dshsd-title", children: t("pageTitle") }),
					react_jsx_runtime.jsxs("div", { className: "dshsd-headRight", children: [
						react_jsx_runtime.jsx("span", { className: "dshsd-counts", children: sizesLoading
							? t("refreshing")
							: archivedCount > 0
								? t("counts", { n: totalCount, m: archivedCount, size: formatBytes(totalSize) })
								: t("countsNoArchived", { n: totalCount, size: formatBytes(totalSize) }) }),
						react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: refreshSizes, children: t("refresh") }),
					] }),
				] }),
				react_jsx_runtime.jsx("p", { className: "dshsd-desc", children: t("pageDesc") }),
				react_jsx_runtime.jsxs("div", { className: "dshsd-toolbar", children: [
					react_jsx_runtime.jsxs("div", { className: "dshsd-seg", role: "tablist", "aria-label": t("filterLabel"), children: [
						react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-segBtn" + (filter === "default" ? " dshsd-segBtnOn" : ""), onClick: () => setFilter("default"), children: t("filterHide") }),
						react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-segBtn" + (filter === "show" ? " dshsd-segBtnOn" : ""), onClick: () => setFilter("show"), children: t("filterShow") }),
						react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-segBtn" + (filter === "only" ? " dshsd-segBtnOn" : ""), onClick: () => setFilter("only"), children: t("filterOnly") }),
					] }),
				] }),
				result ? react_jsx_runtime.jsxs("div", { className: "dshsd-result", children: [
					result.message ? result.message + " · " : "",
					t("resultOk", { n: result.ok }),
					result.fail > 0 ? " · " + t("resultFail", { n: result.fail }) : "",
				] }) : null,
				selectedIds.length > 0 ? react_jsx_runtime.jsxs("div", { className: "dshsd-batch", children: [
					react_jsx_runtime.jsx("span", { className: "dshsd-batchInfo", children: selectedSize > 0
						? t("selected", { n: selectedIds.length, size: formatBytes(selectedSize) })
						: t("selectedNoSize", { n: selectedIds.length }) }),
					react_jsx_runtime.jsx("span", { className: "dshsd-batchSp" }),
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: () => { setResult(null); void runArchive(selectedIds.filter((id) => !archivedSet.has(id))); }, children: t("batchArchive") }),
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: () => { setResult(null); void runUnarchive(selectedIds.filter((id) => archivedSet.has(id))); }, children: t("batchUnarchive") }),
					react_jsx_runtime.jsx("button", {
						type: "button",
						className: "dshsd-btn dshsd-btnDanger",
						disabled: !selectedIds.some((id) => !deleteBlocked(byId[id])),
						title: t("batchEmptyDisabled"),
						onClick: () => requestDelete(selectedIds),
						children: t("batchDelete"),
					}),
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: () => setSelected([]), children: t("clearSelection") }),
				] }) : null,
				loading ? react_jsx_runtime.jsx("div", { className: "dshsd-empty", children: t("loading") }) : null,
				!loading && groups.length === 0 ? react_jsx_runtime.jsxs("div", { className: "dshsd-empty", children: [
					react_jsx_runtime.jsx("div", { className: "dshsd-emptyTitle", children: t("emptyTitle") }),
					react_jsx_runtime.jsx("div", { children: t("emptyHint") }),
				] }) : null,
				!loading ? react_jsx_runtime.jsx("div", { className: "dshsd-list", children: groups.map((group) => {
					const groupSelectable = group.rows.filter((row) => !deleteBlocked(row.summary)).map((row) => row.id);
					const groupAllSelected = groupSelectable.length > 0 && groupSelectable.every((id) => selectedIds.includes(id));
					return react_jsx_runtime.jsxs("div", { className: "dshsd-group", children: [
						react_jsx_runtime.jsxs("div", { className: "dshsd-groupHead", children: [
							react_jsx_runtime.jsx("input", {
								type: "checkbox",
								className: "dshsd-check",
								checked: groupAllSelected,
								onChange: () => {
									setSelected((current) => groupAllSelected
										? current.filter((id) => !groupSelectable.includes(id))
										: [...new Set([...current, ...groupSelectable])]);
								},
								"aria-label": t("selectAll"),
							}),
							react_jsx_runtime.jsx("span", { className: "dshsd-groupTitle", children: group.title }),
							group.path ? react_jsx_runtime.jsx("span", { className: "dshsd-groupPath", children: group.path }) : null,
							react_jsx_runtime.jsx("span", { className: "dshsd-batchSp" }),
							react_jsx_runtime.jsx("span", { className: "dshsd-groupCount", children: group.rows.length }),
						] }),
						react_jsx_runtime.jsx("div", { className: "dshsd-rows", children: group.rows.map((row) => react_jsx_runtime.jsx(SessionRow, {
							row,
							selected: selectedIds.includes(row.id),
							onToggle: toggleRow,
							onArchive: (id) => { setResult(null); void runArchive([id]); },
							onUnarchive: (id) => { setResult(null); void runUnarchive([id]); },
							onRequestDelete: requestDelete,
							t,
							now,
						}, row.id)) }),
					] }, group.key);
				}) }) : null,
				react_jsx_runtime.jsx(ConfirmDialog, {
					open: confirm !== null,
					title: confirm !== null && confirm.length > 1 ? t("confirmTitleMany", { n: confirm.length }) : t("confirmTitleOne"),
					description: t("confirmDesc"),
					items: (confirm ?? []).map((id) => byId[id]?.displayTitle ?? id),
					totalSize: confirm !== null ? confirm.reduce((sum, id) => sum + (typeof sizes[id] === "number" ? sizes[id] : 0), 0) : 0,
					confirmLabel: confirm !== null && confirm.length > 1 ? t("confirmButtonMany", { n: confirm.length }) : t("confirmButton"),
					onCancel: () => setConfirm(null),
					onConfirm: () => void confirmDelete(),
					busy,
					error: confirmError,
					t,
				}),
			] });
		}

		/** The "..." menu entry rendered by the sidebar's session menu slot. */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useSessions, useMenuOpenState, requestSessionDelete, t }) {
			// Same gate as the management page: a session that is running or
			// currently open cannot be deleted (the Host re-checks activity).
			const blocked = useSessions((snapshot) => {
				const summary = snapshot?.byId?.[sessionId];
				return summary !== undefined && (summary.running === true || (summary.retainedBy?.mainView ?? 0) > 0);
			});
			// The slot owner (ui-workspace) declares menuOpenState for every menu
			// entry; close the menu on select exactly like the built-in items do.
			const setMenuOpen = useMenuOpenState ? useMenuOpenState()[1] : undefined;
			return react_jsx_runtime.jsx(primitives.MenuItemButton, {
				danger: true,
				disabled: blocked,
				separatorBefore: true,
				icon: react_jsx_runtime.jsx(primitives.IconTrashOutlineRegular, { size: 14 }),
				onSelect: () => {
					setMenuOpen?.(false);
					requestSessionDelete(sessionId, displayTitle ?? sessionId);
				},
				children: t("menuDelete"),
			});
		}

		/** The shell overlay that confirms a delete requested from the menu. */
		function DeleteConfirmOverlay({ useConfirm, settleSessionDelete, deleteSessions, t }) {
			const request = useConfirm((snapshot) => snapshot);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			if (request === null) return null;
			const confirm = async () => {
				setBusy(true);
				setError("");
				try {
					const data = await deleteSessions([request.sessionId]);
					const entry = data && data.ok ? (data.results ?? [])[0] : { ok: false, message: data?.message };
					if (!entry || !entry.ok) {
						setError((entry && entry.message) || t("errorGeneric"));
						return;
					}
					settleSessionDelete();
				} catch (caught) {
					setError(t("errorGeneric") + (caught instanceof Error ? caught.message : String(caught)));
				} finally {
					setBusy(false);
				}
			};
			return react_jsx_runtime.jsx(primitives.Modal, {
				open: true,
				onClose: busy ? undefined : settleSessionDelete,
				closeLabel: t("close"),
				title: t("menuDeleteTitle", { title: request.displayTitle }),
				description: t("confirmDesc"),
				footer: react_jsx_runtime.jsxs("div", { className: "dshsd-foot", children: [
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn", onClick: settleSessionDelete, disabled: busy, children: t("cancel") }),
					react_jsx_runtime.jsx("button", { type: "button", className: "dshsd-btn dshsd-btnDanger", onClick: () => void confirm(), disabled: busy, children: busy ? "…" : t("confirmButton") }),
				] }),
				children: error ? react_jsx_runtime.jsx("p", { className: "dshsd-resultErr", style: { fontSize: "12.5px", margin: 0 }, children: error }) : null,
			});
		}
		//#endregion

		//#region apply
		const inject = ["slots", "sessions", "workspaces", "uiWorkspace", "locale"];

		function apply(ctx) {
			// dsh.client.inject edges are informational — apply order across
			// client modules is NOT guaranteed (same caveat the shipped
			// ui-workspace documents). Every service is therefore resolved
			// lazily inside the slot inject factories, which run at assembly /
			// render time, long after every module has been applied.
			ctx.effect(() => ctx.locale.register(NS, "zh", zh), "session-delete: dictionary zh");
			ctx.effect(() => ctx.locale.register(NS, "en", en), "session-delete: dictionary en");
			const t = ctx.locale.bind(NS);
			const confirmStore = client_store.createSnapshotStore(null);
			const requireService = (name) => {
				const service = ctx.get(name);
				if (service === undefined) throw new Error("dsh-session-delete: client service '" + name + "' is unavailable");
				return service;
			};

			// Main management page, opened through the sidebar panel icon.
			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					hooks: {
						workspaces: requireService("workspaces").list,
						sessions: requireService("sessions").list,
					},
					archiveSession: (id) => requireService("uiWorkspace").archiveSession(id),
					unarchiveSession: (id) => requireService("uiWorkspace").unarchiveSession(id),
				}),
			}, SessionManagerPage));
			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				locale: NS,
				label: () => t("panel"),
			}, PanelIcon));

			// Per-session "..." menu row, after the built-in archive item (400).
			ctx.slots.inject("sidebar.workspaces.session.menu.item", () => ctx.slots.register({
				name: "sidebar.workspaces.session.menu.item",
				id: "session-delete",
				order: 500,
				locale: NS,
				inject: () => ({
					hooks: {
						workspaces: requireService("workspaces").list,
						sessions: requireService("sessions").list,
					},
					requestSessionDelete: (sessionId, displayTitle) => {
						confirmStore.set({ sessionId, displayTitle });
					},
				}),
			}, DeleteSessionMenuItem));

			// The shared confirm dialog for menu-initiated deletes.
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "session-delete-confirm",
				locale: NS,
				inject: () => ({
					hooks: { confirm: confirmStore },
					settleSessionDelete: () => confirmStore.set(null),
					deleteSessions: (ids) => apiDelete(ids),
				}),
			}, DeleteConfirmOverlay));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

// dsh-session-delete Client 半部冒烟测试：
//   1. 模拟 window.__ModuleLoader__ 与 require（react / primitives / client-store 桩）
//   2. 加载 lib/client.js，验证导出形状
//   3. 用假 ctx 跑 apply()，触发各 slot 工厂，验证注册项与懒解析注入
// 运行：node .tmp/test-client.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const assert = (condition, message) => {
	if (!condition) {
		console.error("❌ " + message);
		process.exitCode = 1;
	} else {
		console.log("✅ " + message);
	}
};

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, "../lib/client.js"), "utf8");

//#region 浏览器环境桩
const injectedStyles = [];
const registrations = [];   // {slot, options, component}
const slotInjects = [];     // {slot, factory}
const localeRegisters = []; // {ns, locale, dict}

globalThis.window = {
	location: { origin: "http://127.0.0.1:1" },
	__ModuleLoader__: {
		load(definition) {
			globalThis.__loaded__ = definition;
		},
	},
};
globalThis.document = {
	querySelector: () => null,
	createElement: () => ({ get dataset() { return {}; }, set textContent(v) { injectedStyles.push(v); }, style: {} }),
	head: { appendChild() {} },
};

const reactStub = {
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useEffect: () => {},
	useCallback: (fn) => fn,
	useMemo: (fn) => fn(),
	useRef: (v) => ({ current: v }),
};
const storeInstance = { snapshot: null, set(v) { this.snapshot = v; }, getSnapshot: () => this.snapshot, subscribe: () => () => {} };

const requireStub = (id) => {
	if (id === "react") return reactStub;
	// 函数组件立即求值：让字符串收集器能看到子组件（SessionRow 等）的渲染结果
	const renderNode = (type, props) => (typeof type === "function" ? type(props) : { type, props });
	if (id === "react/jsx-runtime") return { jsx: renderNode, jsxs: renderNode, Fragment: "Fragment" };
	if (id === "@deepseek-ai/dsh-client-ui-primitives") {
		return new Proxy({}, { get: (target, prop) => (prop.startsWith("Icon") || prop === "Modal" || prop === "MenuItemButton" ? (props) => ({ primitive: prop, props }) : undefined) });
	}
	if (id === "@deepseek-ai/dsh-client-store") {
		return { createSnapshotStore: (init) => { const s = { snapshot: init, set(v) { s.snapshot = v; }, getSnapshot: () => s.snapshot, subscribe: () => () => {} }; return s; } };
	}
	throw new Error("unexpected require: " + id);
};
//#endregion

// 执行模块（ModuleLoader.load 捕获 factory）
new Function("window", source)(globalThis.window);
const definition = globalThis.__loaded__;
assert(typeof definition?.id === "string" && typeof definition?.factory === "function", "ModuleLoader.load 收到插件定义");

const exports = definition.factory(requireStub);
assert(typeof exports?.apply === "function", "导出 apply");
assert(Array.isArray(exports?.inject) && exports.inject.includes("slots"), "导出 inject 依赖表");
assert(injectedStyles.length === 1 && injectedStyles[0].includes(".dshsd-page"), "CSS 已注入");

//#region 假 ctx：服务在工厂调用时才可用（模拟 apply 顺序不确定性）
const services = new Map();
const effects = [];
const fakeCtx = {
	get: (name) => services.get(name),
	locale: {
		register: (ns, locale, dict) => { localeRegisters.push({ ns, locale, dict }); return () => {}; },
		bind: (ns) => (key, params) => {
			let template = localeRegisters.find((entry) => entry.ns === ns && entry.locale === "zh")?.dict?.[key];
			if (template === undefined) return key;
			if (params) template = template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
			return template;
		},
	},
	effect: (setup, name) => {
		const dispose = setup();
		effects.push({ name, dispose });
	},
	slots: {
		inject: (slot, factory) => { slotInjects.push({ slot, factory }); },
		register: (options, component) => {
			registrations.push({ slot: options.name, options, component });
			return { options, component };
		},
	},
};
//#endregion

exports.apply(fakeCtx);
assert(localeRegisters.length === 2 && localeRegisters.every((entry) => entry.ns === "sessionDelete"), "中英字典已注册");
assert(slotInjects.length === 4, "四个 slot 注入已排队（main/panellist/menu.item/overlay）");

const slotNames = slotInjects.map((entry) => entry.slot).sort();
assert(JSON.stringify(slotNames) === JSON.stringify(["main", "shell.overlay", "sidebar.panellist", "sidebar.workspaces.session.menu.item"]), "slot 名称全部正确");

// 逐个触发工厂 → 得到注册项；再触发 inject 工厂（此时服务才可用）
for (const { factory } of slotInjects) factory();
assert(registrations.length === 4, "四个注册项生成");

const main = registrations.find((entry) => entry.slot === "main");
assert(main?.options?.key === "session-delete" && typeof main?.component === "function", "main 面板注册（key=session-delete）");
const panellist = registrations.find((entry) => entry.slot === "sidebar.panellist");
assert(panellist?.options?.id === "session-delete", "侧栏图标注册");
const menuItem = registrations.find((entry) => entry.slot === "sidebar.workspaces.session.menu.item");
assert(menuItem?.options?.id === "session-delete" && menuItem.options.order === 500, "会话菜单项注册（order 500）");
const overlay = registrations.find((entry) => entry.slot === "shell.overlay");
assert(overlay?.options?.id === "session-delete-confirm", "确认浮层注册");

// main 的 inject 工厂在服务可用后运行 → hooks/action 全部解析
services.set("workspaces", { list: { getSnapshot: () => ({ items: [] }), subscribe: () => () => {} } });
services.set("sessions", { list: { getSnapshot: () => ({ ids: [], byId: {} }), subscribe: () => () => {} } });
services.set("uiWorkspace", { archiveSession: async () => {}, unarchiveSession: async () => {} });
const mainProps = main.options.inject();
assert(typeof mainProps.hooks.workspaces.getSnapshot === "function" && typeof mainProps.archiveSession === "function", "main 注入在服务就绪后成功解析");

// 菜单项注入
const menuProps = menuItem.options.inject();
assert(typeof menuProps.hooks.workspaces === "object" && typeof menuProps.requestSessionDelete === "function", "菜单项注入解析成功");
menuProps.requestSessionDelete("session-x", "标题");
assert(overlay.options.inject !== undefined, "overlay 注入工厂可用");

// t() 插值走 {placeholder}
const title = fakeCtx.locale.bind("sessionDelete");
assert(title("confirmTitleMany", { n: 3 }) === "删除这 3 个会话？", "字典插值正确");
assert(title("menuDelete") === "删除会话…", "纯文本键正确");

//#region 渲染冒烟：用真实形状的快照渲染主页面
const ARCHIVED_ID = "session-aaaa";
const RUNNING_ID = "session-bbbb";
const NORMAL_ID = "session-cccc";
const STRAY_ID = "session-dddd";
const workspaceSnapshot = {
	state: "ready",
	items: [{ workspaceId: "ws-1", path: "/tmp/proj", title: "proj", sessionIds: [ARCHIVED_ID, RUNNING_ID, NORMAL_ID] }],
	archivedSessionIds: [ARCHIVED_ID],
	pinnedSessionIds: [NORMAL_ID],
};
const sessionsSnapshot = {
	ids: [ARCHIVED_ID, RUNNING_ID, NORMAL_ID, STRAY_ID],
	byId: {
		[ARCHIVED_ID]: { id: ARCHIVED_ID, displayTitle: "已归档会话", updatedAt: Date.now() - 3600e3 },
		[RUNNING_ID]: { id: RUNNING_ID, displayTitle: "运行中会话", updatedAt: Date.now() - 60e3, running: true },
		[NORMAL_ID]: { id: NORMAL_ID, displayTitle: "普通会话", updatedAt: Date.now(), retainedBy: { mainView: 1 } },
		[STRAY_ID]: { id: STRAY_ID, displayTitle: "游离会话", updatedAt: Date.now() - 7200e3, origin: "subagent" },
	},
};
// 渲染器 materializeStandardBinding 的等价转换：hooks.workspaces → useWorkspaces
const materialize = (injectFactory, ws, ss) => {
	const props = injectFactory();
	if (props.hooks?.workspaces) props.useWorkspaces = (selector) => selector(ws);
	if (props.hooks?.sessions) props.useSessions = (selector) => selector(ss);
	delete props.hooks;
	return props;
};
const mainProps2 = materialize(main.options.inject, workspaceSnapshot, sessionsSnapshot);
// default 筛选：归档行隐藏、subagent 行隐藏
const page1 = main.component({ ...mainProps2, t: title });
assert(page1 !== undefined, "页面组件可渲染（default 筛选）");
// only 筛选：仅显示已归档
reactStub.useState = (init) => [typeof init === "function" ? init() : (init === "default" ? "only" : init), () => {}];
const page2 = main.component({ ...mainProps2, t: title });
assert(page2 !== undefined, "页面组件可渲染（only 筛选）");
// 菜单项组件
const menuItemNode = menuItem.component({
	sessionId: NORMAL_ID,
	displayTitle: "普通会话",
	useSessions: (selector) => selector(sessionsSnapshot),
	requestSessionDelete: () => {},
	t: title,
});
assert(menuItemNode !== undefined, "菜单项组件可渲染");
const menuItemNodeBlocked = menuItem.component({
	sessionId: NORMAL_ID,
	displayTitle: "普通会话",
	useSessions: (selector) => selector(sessionsSnapshot),
	requestSessionDelete: () => {},
	t: title,
});
assert(menuItemNodeBlocked.props.disabled === true, "菜单回归：已打开会话的删除项被禁用");
// 浮层组件（有待确认请求）
const overlayInject = overlay.options.inject();
const confirmStore2 = overlayInject.hooks.confirm;
confirmStore2.set({ sessionId: NORMAL_ID, displayTitle: "普通会话" });
const overlayNode = overlay.component({
	useConfirm: (selector) => selector(confirmStore2.getSnapshot()),
	settleSessionDelete: () => {},
	deleteSessions: async () => ({ ok: true, results: [{ id: NORMAL_ID, ok: true }] }),
	t: title,
});
assert(overlayNode !== undefined, "确认浮层组件可渲染");
//#endregion

//#region 回归：未分组（游离）归档会话必须服从三档筛选
// 复现线上 bug 场景：
//   - 组内归档会话   → default 隐藏（原本就正确）
//   - 游离归档会话   → default 必须隐藏（bug：曾被无条件塞回未分组）
//   - 游离未归档会话 → default 显示
//   - 陈旧归档条目   → 归档集里有、sessions.list 里已无记录：default 隐藏，show/only 显示
const collectStrings = (node, out = []) => {
	if (typeof node === "string") out.push(node);
	else if (Array.isArray(node)) for (const child of node) collectStrings(child, out);
	else if (node && typeof node === "object" && node.props) {
		for (const value of Object.values(node.props)) collectStrings(value, out);
	}
	return out;
};
let forcedFilter = null;
reactStub.useState = (init) => {
	let value = typeof init === "function" ? init() : init;
	if (value === "default" && forcedFilter !== null) value = forcedFilter;
	if (value === true) value = false; // sizesLoading → 让头部统计行直接渲染（sizes 桩为空）
	return [value, () => {}];
};
const WS_ARCHIVED_ID = "session-f1";
const NORMAL_ID2 = "session-f2";
const ARCHIVED_STRAY_ID = "session-f3";
const NONARCHIVED_STRAY_ID = "session-f4";
const STALE_ARCHIVED_ID = "session-stale-archived";
const fixture = {
	workspaces: {
		state: "ready",
		items: [{ workspaceId: "ws-1", path: "/tmp/proj", title: "proj", sessionIds: [NORMAL_ID2, WS_ARCHIVED_ID] }],
		archivedSessionIds: [WS_ARCHIVED_ID, ARCHIVED_STRAY_ID, STALE_ARCHIVED_ID],
		pinnedSessionIds: [],
	},
	sessions: {
		ids: [NORMAL_ID2, WS_ARCHIVED_ID, ARCHIVED_STRAY_ID, NONARCHIVED_STRAY_ID],
		byId: {
			[NORMAL_ID2]: { id: NORMAL_ID2, displayTitle: "普通会话", updatedAt: Date.now() },
			[WS_ARCHIVED_ID]: { id: WS_ARCHIVED_ID, displayTitle: "组内归档", updatedAt: Date.now() - 3600e3 },
			[ARCHIVED_STRAY_ID]: { id: ARCHIVED_STRAY_ID, displayTitle: "游离归档", updatedAt: Date.now() - 7200e3 },
			[NONARCHIVED_STRAY_ID]: { id: NONARCHIVED_STRAY_ID, displayTitle: "游离未归档", updatedAt: Date.now() - 90e3 },
		},
	},
};
const renderTitles = (filter) => {
	forcedFilter = filter === "default" ? null : filter;
	const props = materialize(main.options.inject, fixture.workspaces, fixture.sessions);
	const tree = main.component({ ...props, t: title });
	forcedFilter = null;
	return collectStrings(tree);
};
const hidden = renderTitles("default");
assert(!hidden.includes("游离归档"), "回归 bug：default 下游离归档会话被隐藏");
assert(!hidden.includes(STALE_ARCHIVED_ID), "回归：default 下陈旧归档条目被隐藏");
assert(!hidden.includes("组内归档"), "回归：default 下组内归档会话被隐藏");
assert(hidden.includes("普通会话") && hidden.includes("游离未归档"), "回归：default 下未归档会话正常显示");
const only = renderTitles("only");
assert(only.includes("游离归档") && only.includes("组内归档"), "回归：only 下归档会话显示");
assert(only.includes(STALE_ARCHIVED_ID), "回归：only 下陈旧归档条目可见（可清理）");
assert(!only.includes("普通会话") && !only.includes("游离未归档"), "回归：only 下未归档会话隐藏");
const show = renderTitles("show");
assert(show.includes("游离归档") && show.includes("组内归档") && show.includes("普通会话") && show.includes("游离未归档"), "回归：show 下全部显示");
assert(show.includes(STALE_ARCHIVED_ID), "回归：show 下陈旧归档条目可见");
// 头部总数：唯一会话数（含游离）+ 陈旧归档条目 = 4 + 1 = 5
const countsLine = show.find((value) => typeof value === "string" && /^\d+ 个会话/.test(value));
assert(countsLine !== undefined && countsLine.startsWith("5 个会话"), `回归：头部总数统计游离会话（实际：${countsLine}）`);
//#endregion

//#region 回归：黑屏 bug —— 有磁盘占用时打开删除确认框必须不崩溃
// 根因：t("confirmSize", totalSize) 把数字传给翻译函数，官方 translate 的
// `name in params` 对数字抛 TypeError → 面板整树卸载 → 黑屏。
// 测试桩的 t 与官方一致（非对象 params 会在 `in` 处原生抛错），因此该回归
// 在旧代码下会直接失败。
let hookStore = null;
let hookIndex = 0;
reactStub.useState = (init) => {
	if (hookStore === null) hookStore = [];
	const i = hookIndex++;
	if (hookStore[i] === undefined) {
		let initial = typeof init === "function" ? init() : init;
		if (initial === "default" && forcedFilter !== null) initial = forcedFilter;
		hookStore[i] = initial;
	}
	const set = (value) => { hookStore[i] = typeof value === "function" ? value(hookStore[i]) : value; };
	return [hookStore[i], set];
};
reactStub.useEffect = (fn) => {
	const dispose = fn ? fn() : undefined;
	if (typeof dispose === "function") dispose(); // 立即清理（如 useNow 的定时器），避免测试进程挂起
};
globalThis.fetch = async () => ({ json: async () => ({ ok: true, workspaces: [], archivedSessionIds: [], pinnedSessionIds: [], sizes: { [NORMAL_ID2]: 1260 } }) });

const collectInteractive = (node, out = []) => {
	if (Array.isArray(node)) { for (const child of node) collectInteractive(child, out); return out; }
	if (!node || typeof node !== "object" || !node.props) return out;
	if (node.props.className === "dshsd-row") {
		out.push({ titles: [], checkbox: null, buttons: [] });
	}
	const row = out[out.length - 1];
	if (row) {
		if (typeof node.props.children === "string") row.titles.push(node.props.children);
		if (node.props.type === "checkbox") row.checkbox = node;
		if (typeof node.props.className === "string" && node.props.className.includes("dshsd-iconBtnDanger")) row.buttons.push(node);
	}
	const children = node.props.children;
	if (Array.isArray(children)) {
		for (const child of children) {
			if (typeof child === "string" && row) row.titles.push(child);
			else collectInteractive(child, out);
		}
	} else if (children && typeof children === "object") {
		collectInteractive(children, out);
	}
	return out;
};
const findBatchButton = (node) => {
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findBatchButton(child);
			if (found !== undefined) return found;
		}
		return undefined;
	}
	if (!node || typeof node !== "object" || !node.props) return undefined;
	if (typeof node.props.className === "string" && node.props.className.includes("dshsd-btnDanger") && typeof node.props.onClick === "function") return node;
	const children = node.props.children;
	if (Array.isArray(children)) {
		for (const child of children) {
			const found = findBatchButton(child);
			if (found !== undefined) return found;
		}
	} else if (children && typeof children === "object") {
		return findBatchButton(children);
	}
	return undefined;
};

// 场景 A：普通会话（磁盘占用 1260B）→ 点行内删除 → 确认框渲染"合计占用"且不崩
hookStore = null; hookIndex = 0; forcedFilter = null;
const crashProps = materialize(main.options.inject, fixture.workspaces, fixture.sessions);
main.component({ ...crashProps, t: title });
await new Promise((resolve) => setTimeout(resolve, 5)); // 等 refreshSizes 的 fetch 桩落盘
const crashProps2 = materialize(main.options.inject, fixture.workspaces, fixture.sessions);
hookIndex = 0; // 同一 hookStore 上的再渲染：槽位从头对齐
const treeA1 = main.component({ ...crashProps2, t: title });
const rowsA = collectInteractive(treeA1);
const normalRow = rowsA.find((row) => row.titles.includes("普通会话"));
assert(normalRow !== undefined && normalRow.buttons.length === 1 && normalRow.buttons[0].props.disabled === false, "黑屏回归：普通会话行删除按钮可用");
normalRow.buttons[0].props.onClick();
hookIndex = 0;
const treeA2 = main.component({ ...crashProps2, t: title }); // 不重置 hookStore —— 模拟 setState 后的再渲染
const stringsA2 = collectStrings(treeA2);
assert(stringsA2.includes("删除这个会话？"), "黑屏回归：确认框已打开");
assert(stringsA2.some((value) => typeof value === "string" && value.startsWith("合计占用 1.2 KB")), "黑屏回归：确认框渲染合计占用（旧代码在此抛 TypeError 黑屏）");

// 场景 B：陈旧条目（无会话记录）→ 可勾选、批量删除可用
hookStore = null; hookIndex = 0; forcedFilter = "only";
const staleProps = materialize(main.options.inject, fixture.workspaces, fixture.sessions);
const treeB1 = main.component({ ...staleProps, t: title });
const rowsB = collectInteractive(treeB1);
const staleRow = rowsB.find((row) => row.titles.includes(STALE_ARCHIVED_ID));
assert(staleRow !== undefined, "陈旧回归：only 筛选下陈旧条目有行");
assert(staleRow.checkbox !== null && staleRow.buttons[0]?.props.disabled === false, "陈旧回归：陈旧条目可勾选且删除按钮可用");
staleRow.checkbox.props.onChange();
hookIndex = 0;
const treeB2 = main.component({ ...staleProps, t: title });
const stringsB2 = collectStrings(treeB2);
assert(stringsB2.some((value) => typeof value === "string" && value.startsWith("已选 1 个会话")), "陈旧回归：批量栏显示已选");
const batchButton = findBatchButton(treeB2);
assert(batchButton !== undefined && batchButton.props.disabled === false, "陈旧回归：仅选陈旧条目时批量删除可用");
batchButton.props.onClick();
hookIndex = 0;
const stringsB3 = collectStrings(main.component({ ...staleProps, t: title }));
assert(stringsB3.includes("永久删除"), "陈旧回归：陈旧条目可进入删除确认");
//#endregion

console.log(process.exitCode ? "\n存在失败用例" : "\n全部通过");

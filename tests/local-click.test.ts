import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, visibleWidth, type Component, type TuiMouseEvent as MouseEvent, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

initTheme("dark", false);
let nextId = 0;
const ui = { requestRender() {} } as unknown as TUI;
const plain = (component: Component, width = 100) => component.render(width).map(stripTerminalSequences);
const thought = () => new AssistantMessageComponent({ content: [{ type: "thinking", thinking: "THOUGHT_DETAIL_A\nTHOUGHT_DETAIL_B\nTHOUGHT_PREVIEW" }] } as ConstructorParameters<typeof AssistantMessageComponent>[0], true);
function tool(name: string, path = "example.txt") {
	const c = new ToolExecutionComponent(name, `click-${nextId++}`, { path }, {}, undefined, ui, process.cwd());
	c.updateResult({ content: [{ type: "text", text: `TOOL_DETAIL_${path}\nsecond line` }], isError: false }, false);
	return c;
}
function click(component: Component, needle: string | ((line: string) => boolean), event: Partial<MouseEvent> = {}) {
	const root = new Container();
	root.addChild(component);
	const rows = root.render(100);
	const matches = typeof needle === "string" ? (line: string) => line.includes(needle) : needle;
	const y = rows.findIndex(line => matches(stripTerminalSequences(line)));
	assert.ok(y >= 0, `click target ${needle} is rendered`);
	return root.handleMouse({ type: "click", button: "left", x: 3, y, screenX: 3, screenY: y, width: 100, height: rows.length, shift: false, alt: false, ctrl: false, ...event } as MouseEvent);
}
function harness(t: TestContext) {
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: Function }>();
	const appended: unknown[] = [];
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (name: string, command: { handler: Function }) => commands.set(name, command),
		registerEntryRenderer() {}, appendEntry(...args: unknown[]) { appended.push(args); },
	} as unknown as ExtensionAPI);
	const ctx = { ui: { theme: { fg: (_color: string, s: string) => s, bold: (s: string) => s, italic: (s: string) => s } as Theme, setStatus() {}, setWorkingMessage() {}, notify() {} } } as unknown as ExtensionContext;
	handlers.get("agent_start")!({}, ctx);
	// A visible assistant turn ends any burst from a preceding test.
	new AssistantMessageComponent({ content: [{ type: "text", text: "new turn" }] } as ConstructorParameters<typeof AssistantMessageComponent>[0], true);
	t.after(() => handlers.get("session_shutdown")!({}, ctx));
	return { handlers, commands, ctx, appended };
}

test("stock routes local tool and thinking clicks through real Containers", () => {
	const a = tool("read");
	assert.ok(click(a, "read")?.handled);
	assert.ok(plain(a).some(line => line.includes("TOOL_DETAIL")));
	const b = thought();
	assert.ok(!plain(b).some(line => line.includes("THOUGHT_DETAIL_A")));
	assert.ok(click(b, "Thinking")?.handled);
	assert.ok(plain(b).some(line => line.includes("THOUGHT_DETAIL_A")));
});

test("compact tool click opens only the selected inline result and closes it again", t => {
	harness(t);
	const a = tool("read"), b = tool("grep");
	assert.equal(plain(a).length, 1);
	assert.ok(click(a, "read")?.handled, "compact tool row must route the click");
	assert.ok(plain(a).some(line => line.includes("TOOL_DETAIL")));
	assert.equal(plain(b).length, 1, "neighbor remains collapsed");
	assert.ok(click(a, "read")?.handled);
	assert.equal(plain(a).length, 1);
});

test("compact thinking click opens that run without changing global thinking visibility", t => {
	harness(t);
	const a = thought(), b = thought();
	assert.ok(click(a, "THOUGHT_PREVIEW")?.handled, "compact thinking row must route the click");
	assert.ok(plain(a).some(line => line.includes("THOUGHT_DETAIL_A")));
	assert.ok(!plain(b).some(line => line.includes("THOUGHT_DETAIL_A")));
	assert.ok(click(a, "THOUGHT_DETAIL_A")?.handled);
	assert.ok(!plain(a).some(line => line.includes("THOUGHT_DETAIL_A")));
});

test("a grouped row opens an inline list below itself, not merely the last result", t => {
	harness(t);
	const a = tool("read", "FIRST.txt"), b = tool("read", "SECOND.txt"), c = tool("read", "THIRD.txt");
	const root = new Container();
	for (const component of [a, b, c]) root.addChild(component);
	assert.equal(plain(root).filter(line => line.includes("read")).length, 1);
	assert.ok(click(root, "3×")?.handled, "group header must open the choice of individual calls");
	let rows = plain(root);
	assert.ok(rows[0].includes("3×"), "the group header stays in the same row");
	for (const name of ["FIRST.txt", "SECOND.txt", "THIRD.txt"]) assert.ok(rows.some(line => line.includes(name)));
	assert.ok(!rows.some(line => line.includes("TOOL_DETAIL")), "listing calls does not expand their outputs");
	assert.ok(click(root, "FIRST.txt")?.handled);
	rows = plain(root);
	assert.ok(rows.some(line => line.includes("TOOL_DETAIL_FIRST.txt")));
	assert.ok(!rows.some(line => line.includes("TOOL_DETAIL_SECOND.txt")));
	assert.ok(!rows.some(line => line.includes("TOOL_DETAIL_THIRD.txt")));
	assert.ok(click(root, "3×")?.handled);
	assert.equal(plain(root).filter(line => line.includes("read")).length, 1);
});

test("a historical group's membership survives the next agent turn", t => {
	const { handlers, ctx } = harness(t);
	const a = tool("read", "HISTORY_FIRST.txt"), b = tool("read", "HISTORY_LAST.txt");
	handlers.get("agent_start")!({}, ctx);
	const current = tool("grep", "CURRENT.txt");
	const root = new Container(); for (const c of [a, b, current]) root.addChild(c);
	assert.ok(click(root, "2×")?.handled);
	const rows = plain(root);
	assert.ok(rows.some(line => line.includes("HISTORY_FIRST.txt")), "a historical group still offers every original call, not only its last call");
	assert.ok(!rows.some(line => line.includes("TOOL_DETAIL")), "opening a historical group lists headers, not an arbitrary full result");
	click(root, "HISTORY_FIRST.txt");
	assert.ok(plain(root).some(line => line.includes("TOOL_DETAIL_HISTORY_FIRST.txt")));
	assert.ok(!plain(root).some(line => line.includes("TOOL_DETAIL_CURRENT.txt")));
});

test("real global Ctrl+O traversal resets a local inspection and restores the collapsed group", async t => {
	harness(t);
	const { InteractiveMode } = await import(pathToFileURL(resolve(process.env.PI_ROOT!, "dist/modes/interactive/interactive-mode.js")).href);
	const members = [tool("read", "GLOBAL_FIRST.txt"), tool("read", "GLOBAL_LAST.txt")];
	const root = new Container();
	for (const member of members) root.addChild(member);
	const before = plain(root);
	click(root, "2×");
	click(root, "GLOBAL_FIRST.txt");
	const mode = { toolOutputExpanded: false, builtInHeader: {}, loadedResourcesContainer: { children: [] }, chatContainer: root, showStatus() {}, setToolsExpanded: InteractiveMode.prototype.setToolsExpanded };
	InteractiveMode.prototype.toggleToolOutputExpansion.call(mode);
	for (const path of ["GLOBAL_FIRST.txt", "GLOBAL_LAST.txt"]) assert.ok(plain(root).some(line => line.includes(`TOOL_DETAIL_${path}`)));
	InteractiveMode.prototype.toggleToolOutputExpansion.call(mode);
	assert.deepEqual(plain(root), before, "global collapse must restore the compact group rather than duplicate its calls");
});

test("thinking runs keep independent overrides, survive streaming, and reset with global Ctrl+T state", t => {
	harness(t);
	const message = { content: [
		{ type: "thinking", thinking: " " }, { type: "text", text: "ANSWER_0" },
		{ type: "thinking", thinking: "DETAIL_ONE\nPREVIEW_ONE" }, { type: "text", text: "ANSWER_1" },
		{ type: "thinking", thinking: "DETAIL_TWO\nPREVIEW_TWO" },
	] } as ConstructorParameters<typeof AssistantMessageComponent>[0];
	const a = new AssistantMessageComponent(message, true);
	const before = structuredClone(message);
	click(a, "PREVIEW_TWO");
	assert.ok(plain(a).some(line => line.includes("DETAIL_TWO")));
	assert.ok(!plain(a).some(line => line.includes("DETAIL_ONE")));
	Reflect.get(a, "updateContent").call(a, message, true);
	assert.ok(plain(a).some(line => line.includes("DETAIL_TWO")), "a streaming update preserves the local run override");
	a.setHideThinkingBlock(false);
	assert.ok(plain(a).some(line => line.includes("DETAIL_ONE")));
	click(a, "DETAIL_ONE");
	assert.ok(!plain(a).some(line => line.includes("DETAIL_ONE")));
	assert.ok(plain(a).some(line => line.includes("PREVIEW_ONE")), "local collapse retains a meaningful compact preview");
	a.setHideThinkingBlock(true);
	assert.ok(!plain(a).some(line => /DETAIL_ONE|DETAIL_TWO/.test(line)));
	assert.deepEqual(message, before);
});

test("unrelated mouse events never toggle compact tool/thinking content", t => {
	harness(t);
	const a = tool("read"), b = thought();
	for (const event of [{ type: "move" }, { type: "down" }, { type: "up" }, { button: "right" }]) {
		click(a, "read", event as Partial<MouseEvent>);
		click(b, "THOUGHT_PREVIEW", event as Partial<MouseEvent>);
		assert.equal(plain(a).length, 1);
		assert.ok(!plain(b).some(line => line.includes("THOUGHT_DETAIL_A")));
	}
});

test("native tool details keep updating, errors remain visible, and gestures append no session content", t => {
	const { appended } = harness(t);
	const a = tool("read", "UPDATING.txt"), b = tool("read", "OTHER.txt");
	const root = new Container(); root.addChild(a); root.addChild(b);
	const argsBefore = structuredClone(Reflect.get(a, "args"));
	click(root, "2×"); click(root, "UPDATING.txt");
	a.updateResult({ content: [{ type: "text", text: "UPDATED_DETAIL" }], isError: false }, false);
	assert.ok(plain(root).some(line => line.includes("UPDATED_DETAIL")));
	assert.ok(!plain(root).some(line => line.includes("TOOL_DETAIL_OTHER.txt")));
	a.updateResult({ content: [{ type: "text", text: "FAILED_DETAIL" }], isError: true }, false);
	assert.ok(plain(root).some(line => line.includes("UPDATING.txt")), "an inspected member's later failure cannot be hidden by its group");
	click(root, "UPDATING.txt");
	assert.ok(plain(root).some(line => line.includes("FAILED_DETAIL")));
	assert.deepEqual(Reflect.get(a, "args"), argsBefore);
	assert.deepEqual(appended, [], "view gestures must not write session/model entries");
});

test("existing local views tolerate repeated extension loads and compact on/off", async t => {
	const { commands, ctx } = harness(t);
	const a = tool("read", "RELOAD.txt");
	click(a, "read");
	assert.ok(plain(a).some(line => line.includes("TOOL_DETAIL")));
	compactTranscript({ on() {}, registerCommand() {}, registerEntryRenderer() {} } as unknown as ExtensionAPI);
	click(a, "read");
	assert.equal(plain(a).length, 1, "reinstallation does not layer mouse wrappers");
	await commands.get("compact-transcript")!.handler("off", ctx);
	assert.ok(plain(a).some(line => line.includes("TOOL_DETAIL")), "disabled compaction delegates to the native collapsed preview");
	await commands.get("compact-transcript")!.handler("on", ctx);
	assert.equal(plain(a).length, 1);
	click(a, "read");
	assert.ok(plain(a).some(line => line.includes("TOOL_DETAIL")));
});

for (const selected of ["GROW_A.txt", "GROW_B.txt"]) test(`a growing live burst does not resurrect the previous host when ${selected} is selected`, t => {
	harness(t);
	const a = tool("read", "GROW_A.txt"), b = tool("read", "GROW_B.txt");
	const root = new Container(); root.addChild(a); root.addChild(b);
	click(root, "2×"); click(root, line => line.startsWith("  ") && line.includes(selected));
	assert.ok(plain(root).some(line => line.includes(`TOOL_DETAIL_${selected}`)), "the individual member, not the shared group header, must be open");
	const c = tool("read", "GROW_C.txt"); root.addChild(c);
	let rows = plain(root);
	assert.equal(rows.length, 1, "only the new 3× group may remain, not the old 2× inspection host");
	assert.ok(rows[0].includes("3×"));
	click(root, "3×");
	for (const path of ["GROW_A.txt", "GROW_B.txt", "GROW_C.txt"]) assert.ok(plain(root).some(line => line.includes(path)));
	click(root, "GROW_B.txt");
	assert.ok(plain(root).some(line => line.includes("TOOL_DETAIL_GROW_B.txt")));
	click(root, "3×");
	assert.equal(plain(root).length, 1, "closing the replacement host must not resurrect old members");
});

for (const selected of ["TOGGLE_A.txt", "TOGGLE_B.txt"]) test(`compact off/on reconciles selected ${selected} without moving it above the group`, async t => {
	const { commands, ctx } = harness(t);
	const root = new Container(); root.addChild(tool("read", "TOGGLE_A.txt")); root.addChild(tool("read", "TOGGLE_B.txt"));
	const before = plain(root);
	click(root, "2×"); click(root, line => line.startsWith("  ") && line.includes(selected));
	assert.ok(plain(root).some(line => line.includes(`TOOL_DETAIL_${selected}`)));
	await commands.get("compact-transcript")!.handler("off", ctx);
	await commands.get("compact-transcript")!.handler("on", ctx);
	assert.deepEqual(plain(root), before, "re-enabling compact restores the group, not expanded orphan output above it");
	click(root, "2×"); click(root, line => line.startsWith("  ") && line.includes(selected));
	assert.ok(plain(root).some(line => line.includes(`TOOL_DETAIL_${selected}`)));
});

test("inline groups and native details respect width and recover on resize", t => {
	harness(t);
	const a = tool("read", "界🙂-FIRST.txt"), b = tool("read", "SECOND.txt");
	const root = new Container(); root.addChild(a); root.addChild(b);
	click(root, "2×"); click(root, "FIRST.txt");
	for (const width of [40, 80, 120, 40]) {
		const rows = root.render(width);
		assert.ok(rows.every(line => visibleWidth(line) <= width), `inline render fits ${width} columns`);
		assert.ok(rows.map(stripTerminalSequences).some(line => line.includes("TOOL_DETAIL")));
	}
});

import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

type Scope = { run<T>(operation: () => T): T; dispose(): void };
const KEY = Symbol.for("pi-compact-transcript.scope-factory");

test("optional viewer scopes isolate same-ID tools, restore nested/failed runs and follow config across reload", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
	const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value };
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {}, notify() {} } } as unknown as ExtensionContext;
	const api = { on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand: (name: string, command: any) => commands.set(name, command), registerEntryRenderer() {}, appendEntry() {} } as unknown as ExtensionAPI;
	compactTranscript(api);
	handlers.get("agent_start")?.({}, ctx);
	const factory = (globalThis as typeof globalThis & { [KEY]: () => Scope })[KEY];
	const a = factory(), b = factory();
	const text = (component: ToolExecutionComponent) => component.render(120).map(stripTerminalSequences).join("\n");
	const make = (label: string) => {
		const component = new ToolExecutionComponent("read", "same-id", { path: `${label}_FILE` }, {}, undefined, { requestRender() {} } as unknown as TUI, process.cwd());
		component.updateResult({ content: [{ type: "text", text: `${label}_PREVIEW\n${label}_DETAIL` }], details: {}, isError: false });
		return component;
	};
	try {
		const parent = make("PARENT");
		const original = text(parent);
		const first = a.run(() => make("FIRST"));
		const second = b.run(() => make("SECOND"));
		assert.match(a.run(() => text(first)), /FIRST_FILE/);
		assert.match(b.run(() => text(second)), /SECOND_FILE/);
		a.run(() => first.setExpanded(true));
		assert.match(a.run(() => text(first)), /FIRST_DETAIL/);
		assert.doesNotMatch(b.run(() => text(second)), /SECOND_DETAIL/);
		assert.equal(text(parent), original);
		assert.throws(() => a.run(() => b.run(() => { throw new Error("SCOPED_FAILURE"); })), /SCOPED_FAILURE/);
		assert.equal(text(parent), original, "both nested active slots restore even after an exception");
		a.run(() => first.setExpanded(false));
		await commands.get("compact-transcript")!.handler("off", ctx);
		assert.match(a.run(() => text(first)), /FIRST_DETAIL/, "existing viewer updates when shared compact config changes");
		await commands.get("compact-transcript")!.handler("on", ctx);
		assert.doesNotMatch(a.run(() => text(first)), /FIRST_DETAIL/);
		compactTranscript(api);
		assert.match(a.run(() => text(first)), /FIRST_FILE/, "old scopes remain valid after repeated extension registration");
		a.run(() => first.updateResult({ content: [{ type: "text", text: "UPDATED_FIRST\nMORE\nLATEST" }], details: {}, isError: false }));
		assert.equal(text(parent), original);
		assert.match(b.run(() => text(second)), /SECOND_FILE/);
	} finally {
		a.dispose(); b.dispose();
		await handlers.get("session_shutdown")?.({}, ctx);
	}
});

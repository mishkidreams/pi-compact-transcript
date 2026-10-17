import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { cachedLine } from "../extensions/cached-line.ts";
import compactTranscript from "../extensions/compact-transcript.ts";

test("a fixed line formats once until width changes or explicit invalidation", () => {
	const widths: number[] = [];
	const line = cachedLine(width => { widths.push(width); return `line at ${width}`; });
	assert.deepEqual(line.render(40), ["line at 40"]);
	for (let i = 0; i < 20; i++) assert.deepEqual(line.render(40), ["line at 40"]);
	assert.deepEqual(widths, [40], "streaming a different component must not reformat an unchanged row");
	assert.deepEqual(line.render(12), ["line at 12"]);
	assert.deepEqual(line.render(40), ["line at 40"]);
	line.invalidate();
	assert.deepEqual(line.render(40), ["line at 40"]);
	assert.deepEqual(widths, [40, 12, 40, 40]);
});

test("returned arrays cannot corrupt the cache; negative widths share the zero-width entry", () => {
	let calls = 0;
	const line = cachedLine(width => { calls++; return `width=${width}`; });
	line.render(0)[0] = "changed by a parent";
	assert.deepEqual(line.render(-10), ["width=0"]);
	assert.equal(calls, 1);
});

test("failed formatting does not publish an incomplete cache entry", () => {
	let attempts = 0;
	const line = cachedLine(() => { if (++attempts === 1) throw new Error("fixture"); return "recovered"; });
	assert.throws(() => line.render(10), /fixture/);
	assert.deepEqual(line.render(10), ["recovered"]);
	assert.deepEqual(line.render(10), ["recovered"]);
	assert.equal(attempts, 2);
});

test("actual compact tool rows skip repeated truncation while updates, resize and inline expansion stay live", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	let ellipses = 0;
	const theme = {
		fg: (color: string, text: string) => { if (color === "dim" && text === "…") ellipses++; return `\x1b[36m${text}\x1b[39m`; },
		bold: (text: string) => text,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({ on: (name: string, handler: Function) => handlers.set(name, handler), registerCommand() {}, registerEntryRenderer() {} } as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)?.(event, ctx);
	emit("agent_start");
	try {
		const args = { command: "echo " + "Проверка 界🙂é ".repeat(20) };
		emit("tool_execution_start", { toolCallId: "cache-test", toolName: "bash", args });
		const tool = new ToolExecutionComponent("bash", "cache-test", args, {}, undefined, { requestRender() {} } as unknown as TUI, process.cwd());
		tool.updateResult({ content: [{ type: "text", text: "FIRST_LINE\nDETAIL_TWO" }], details: {}, isError: false });
		const first = tool.render(32);
		const before = ellipses;
		for (let i = 0; i < 20; i++) assert.deepEqual(tool.render(32), first);
		assert.equal(ellipses, before, "unchanged tool rows must reuse their width-formatted line");
		const wide = tool.render(600);
		assert.ok(stripTerminalSequences(wide[0]).includes("Проверка"));
		assert.deepEqual(tool.render(32), first, "resize must recover exactly the previous narrow output");
		tool.updateArgs({ command: "echo UPDATED" });
		assert.match(stripTerminalSequences(tool.render(120)[0]), /UPDATED/);
		const previousResult = tool.render(120);
		tool.updateResult({ content: [{ type: "text", text: "NEW_RESULT\nDETAIL_TWO\nTHIRD_LINE" }], details: {}, isError: false });
		const changedResult = tool.render(120);
		assert.notDeepEqual(changedResult, previousResult, "new results must replace a warmed summary, not reuse old text");
		const afterUpdate = ellipses;
		assert.deepEqual(tool.render(120), changedResult);
		assert.equal(ellipses, afterUpdate, "the replacement summary is cached too");
		tool.invalidate();
		assert.deepEqual(tool.render(120), changedResult, "native invalidation preserves the latest output");
		assert.ok(ellipses > afterUpdate, "native invalidation must rebuild the formatted line");
		tool.setExpanded(true);
		assert.ok(tool.render(120).some(line => stripTerminalSequences(line).includes("DETAIL_TWO")), "native details must not be replaced by a cached summary");
		tool.setExpanded(false);
		assert.equal(tool.render(32).length, 1);
	} finally {
		await emit("session_shutdown");
	}
});

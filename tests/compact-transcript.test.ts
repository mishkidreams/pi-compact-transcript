import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { AssistantMessageComponent, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

test("compact tool and thought rows use render width and recover on resize", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const command = `echo ${"界🙂é ".repeat(35)}END_OF_COMMAND`;
		const args = { command };
		emit("tool_execution_start", { toolCallId: "width-test", toolName: "bash", args });
		const component = new ToolExecutionComponent("bash", "width-test", args, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		const expected = `◆ $ ${command} {running}`;
		const checkTool = (width: number) => {
			const lines = component.render(width);
			assert.equal(lines.length, 1);
			assert.equal(stripTerminalSequences(lines[0]), stripTerminalSequences(truncateToWidth(expected, width, "…")));
			assert.ok(visibleWidth(lines[0]) <= width);
			assert.ok(lines[0].includes("\x1b["), "theme styling is preserved");
		};
		checkTool(220); // Beyond the old 104-cell preview cap.
		checkTool(24);
		checkTool(600); // No invalidate/update between widths: recover the full line.

		const heading = `Considering ${"界🙂é ".repeat(35)}END_OF_THOUGHT`;
		emit("message_update", {
			assistantMessageEvent: { type: "thinking_delta" },
			message: { content: [{ type: "thinking", thinking: heading }] },
		});
		for (const width of [220, 24, 600]) {
			const lines = component.render(width);
			assert.equal(lines.length, 1, "the under-tool ticker stays off once thinking has its own row");
			assert.equal(stripTerminalSequences(lines[0]), stripTerminalSequences(truncateToWidth(expected, width, "…")));
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
		}
	} finally {
		await emit("session_shutdown");
	}
});

test("hidden thinking is one line and recovers when the column grows", async () => {
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const heading = `Considering ${"界🙂é ".repeat(35)}END_OF_THOUGHT`;
		const component = new AssistantMessageComponent(
			{ content: [{ type: "thinking", thinking: heading }] },
			true,
			undefined,
			"Thinking...",
			1,
			[],
		);
		const check = (width: number) => {
			const lines = component.render(width);
			assert.equal(lines.length, 2, "one thought line, then one blank separator");
			const room = Math.max(0, width - 1);
			assert.equal(stripTerminalSequences(lines[0]), ` ${stripTerminalSequences(truncateToWidth(heading, room, "…"))}`);
			assert.equal(stripTerminalSequences(lines[1]).trim(), "");
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.ok(lines[0].includes("\x1b[3m"), "the thought stays italic");
		};
		check(220);
		check(24);
		check(600);

		const empty = new AssistantMessageComponent({ content: [{ type: "thinking", thinking: "  \n" }] }, true);
		assert.deepEqual(empty.render(80), []);

		const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line));
		const thoughtThenAnswer = new AssistantMessageComponent({
			content: [
				{ type: "thinking", thinking: "Look" },
				{ type: "text", text: "Answer" },
			],
		}, true);
		const paired = plain(thoughtThenAnswer.render(80));
		assert.equal(paired[0], " Look");
		assert.equal(paired[1].trim(), "", "the separator is under the thought");
		assert.equal(paired[2]?.trim() === "", false, "the answer does not get a second blank in the same slot");
		assert.ok(paired.some((line) => line.includes("Answer")));

		const textOnly = new AssistantMessageComponent({ content: [{ type: "text", text: "Answer" }] }, true);
		assert.equal(plain(textOnly.render(80))[0].trim(), "", "a text-only answer keeps Pi's leading separator");

		const emptyThenText = new AssistantMessageComponent({
			content: [
				{ type: "thinking", thinking: "  \n" },
				{ type: "text", text: "Answer" },
			],
		}, true);
		assert.equal(plain(emptyThenText.render(80))[0].trim(), "", "an empty thought does not eat the text separator");
	} finally {
		await emit("session_shutdown");
	}
});

test("collapsing tool output clears image sources together with image components", async () => {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const theme = {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as Theme;
	const ctx = { ui: { theme, setStatus() {}, setWorkingMessage() {} } } as unknown as ExtensionContext;
	compactTranscript({
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand() {},
		registerEntryRenderer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event = {}) => handlers.get(name)!(event, ctx);
	emit("agent_start");
	try {
		const component = new ToolExecutionComponent("read", "image-test", { path: "image.png" }, {}, undefined,
			{ requestRender() {} } as unknown as TUI, process.cwd());
		component.setExpanded(true);
		// Seed the private image cache as if expanded output had rendered an image.
		// A stale source lets pi reuse an undefined component on the next expansion.
		Reflect.set(component, "imageComponents", [{ render: () => ["image"], invalidate() {} }]);
		Reflect.set(component, "imageSources", [{ data: "image", mimeType: "image/png", widthCells: 80 }]);
		component.setExpanded(false);
		assert.deepEqual(Reflect.get(component, "imageComponents"), []);
		assert.deepEqual(Reflect.get(component, "imageSources"), []);
		assert.doesNotThrow(() => {
			component.setExpanded(true);
			component.render(80);
		});
	} finally {
		await emit("session_shutdown");
	}
});

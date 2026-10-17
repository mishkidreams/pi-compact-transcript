import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import compactTranscript from "../extensions/compact-transcript.ts";

const notification = () => ({
	role: "custom" as const,
	customType: "pi-background-task-notification",
	content: "Background task updates.\nFull model-facing output stays here.",
	display: true,
	timestamp: 0,
	details: {
		tasks: [{
			eventId: "pwsh:ps_test:terminal",
			taskKey: "pwsh:ps_test",
			source: "pwsh",
			taskId: "ps_test",
			event: "terminal",
			status: "completed",
			durationMs: 20_900,
			summary: "Write-Output 'C01_TEST'; Start-Sleep -Seconds 20",
			output: Array.from({ length: 12 }, (_, i) => `C01_TEST: line ${i + 1}`).join("\n"),
			ok: true,
		}],
	},
});

// Same collapsed layout as the task coordinator: header, command, last three
// output lines. Keep the extension independent of any task provider dependency.
const taskRenderer: MessageRenderer = (message, { expanded }, theme) => {
	const { tasks } = message.details as ReturnType<typeof notification>["details"];
	return new Text(tasks.flatMap((task) => [
		theme.fg("success", `● ${task.source} ${task.taskId} ${task.status} · 20.9s`),
		`  ${task.summary}`,
		...(expanded ? task.output.split("\n") : ["  … 9 earlier lines", ...task.output.split("\n").slice(-3)]),
	]).join("\n"), 0, 0);
};

type CompactCommand = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

async function harness(t: TestContext) {
	initTheme("dark", false);
	const handlers = new Map<string, Function>();
	const commands = new Map<string, CompactCommand>();
	const entries: unknown[] = [];
	const theme = {
		fg: (color: string, text: string) => `\x1b[${color === "error" ? 31 : color === "warning" ? 33 : 36}m${text}\x1b[39m`,
		bold: (text: string) => text,
	} as Theme;
	const ctx = {
		ui: { theme, setStatus() {}, setWorkingMessage() {}, notify() {} },
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: Function) => handlers.set(event, handler),
		registerCommand: (name: string, command: CompactCommand) => commands.set(name, command),
		registerEntryRenderer() {},
		appendEntry: (...args: unknown[]) => entries.push(args),
	} as unknown as ExtensionAPI;
	compactTranscript(pi);
	const toggle = (enabled: boolean) => commands.get("compact-transcript")!.handler(enabled ? "on" : "off", ctx);
	await toggle(true);
	handlers.get("agent_start")!({}, ctx);
	t.after(async () => {
		await toggle(true);
		await handlers.get("session_shutdown")!({}, ctx);
	});
	return { pi, ctx, handlers, toggle, entries };
}

test("late background task completion is one line; expansion preserves the original output", async (t) => {
	const { handlers, ctx, entries } = await harness(t);
	// A completion may arrive while idle, after its initiating agent run ended.
	handlers.get("agent_end")!({}, ctx);
	const message = notification();
	const unchanged = structuredClone(message);
	const entryCount = entries.length;
	const component = new CustomMessageComponent(message, taskRenderer, undefined, 0);
	const lines = component.render(120);
	assert.equal(lines.length, 1, "completion must follow the same one-line compact mode as the tool call");
	const preview = stripTerminalSequences(lines[0]);
	assert.match(preview, /pwsh/);
	assert.match(preview, /ps_test/);
	assert.match(preview, /completed/);
	assert.match(preview, /21s/);
	assert.doesNotMatch(preview, /C01_TEST/);

	component.setExpanded(true);
	const original = new CustomMessageComponent({ ...message, customType: "control" }, taskRenderer, undefined, 0);
	original.setExpanded(true);
	assert.deepEqual(component.render(120), original.render(120), "expanded output is exactly the provider's renderer");
	const expanded = component.render(120).map(stripTerminalSequences).join("\n");
	for (let i = 1; i <= 12; i++) assert.ok(expanded.includes(`C01_TEST: line ${i}`));
	component.setExpanded(false);
	assert.deepEqual(component.render(120), lines, "Ctrl+O can collapse the same message again");
	assert.deepEqual(message, unchanged, "rendering must not change model content or task details");
	assert.equal(entries.length, entryCount, "rendering never appends or rewrites session entries");
});

test("background rows respect terminal width, Unicode and resizing without losing the full label", async (t) => {
	await harness(t);
	const message = notification();
	message.details.tasks[0].taskId = `\x1b[31mps_${"界🙂é".repeat(20)}END_TASK\x1b[0m`;
	const component = new CustomMessageComponent(message, taskRenderer, undefined, 3);
	for (const width of [0, 1, 5, 24, 120, 600]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
		assert.ok(!lines[0].includes("\n"));
	}
	assert.match(stripTerminalSequences(component.render(600)[0]), /END_TASK/);
});

test("batched updates stay one line and do not hide failed or ready tasks behind the first completion", async (t) => {
	await harness(t);
	const message = notification();
	const first = message.details.tasks[0];
	message.details.tasks.push(
		{ ...first, source: "python", taskId: "py_test", status: "failed", ok: false },
		{ ...first, taskId: "ps_cancel", status: "cancelled" },
		{ ...first, source: "subagent", taskId: "agent_test", event: "ready", status: "running" },
	);
	const component = new CustomMessageComponent(message, taskRenderer, undefined, 0);
	for (const width of [40, 60, 120]) {
		const lines = component.render(width);
		assert.equal(lines.length, 1);
		assert.ok(visibleWidth(lines[0]) <= width);
		assert.match(lines[0], /\x1b\[31m◆/, "a failure anywhere in the batch keeps the marker red");
		const preview = stripTerminalSequences(lines[0]);
		assert.match(preview, /4 background tasks/);
		assert.match(preview, /1 ready/, "readiness must not be truncated behind terminal status counts");
		if (width === 120) {
			assert.match(preview, /1 completed/);
			assert.match(preview, /1 failed/);
			assert.match(preview, /1 cancelled/);
		}
	}
});

test("ready and cancelled task updates keep their status and cancellation is not shown as success", async (t) => {
	await harness(t);
	for (const state of [
		{ event: "ready", status: "running", expected: "ready" },
		{ event: "terminal", status: "cancelled", expected: "cancelled" },
	]) {
		const message = notification();
		Object.assign(message.details.tasks[0], state);
		const component = new CustomMessageComponent(message, taskRenderer, undefined, 0);
		const lines = component.render(120);
		assert.equal(lines.length, 1);
		assert.ok(stripTerminalSequences(lines[0]).includes(state.expected));
		if (state.status === "cancelled") assert.match(lines[0], /\x1b\[33m◆/);
	}
});

test("on/off toggles and repeated extension loads preserve the original renderer for existing messages", async (t) => {
	const { pi, toggle } = await harness(t);
	const message = notification();
	const component = new CustomMessageComponent(message, taskRenderer, undefined, 0);
	const original = new CustomMessageComponent({ ...message, customType: "control" }, taskRenderer, undefined, 0);
	for (let i = 0; i < 3; i++) {
		compactTranscript(pi);
		assert.equal(component.render(120).length, 1);
		await toggle(false);
		assert.deepEqual(component.render(120), original.render(120));
		await toggle(true);
		assert.equal(component.render(120).length, 1);
	}
});

test("other custom messages and unknown task payloads fall back without losing content", async (t) => {
	const { toggle } = await harness(t);
	for (const message of [
		{ ...notification(), customType: "another-extension" },
		{ ...notification(), details: undefined },
		{ ...notification(), details: { tasks: [] } },
		{ ...notification(), details: { tasks: [null] } },
		{ ...notification(), details: { tasks: [{ source: "pwsh", status: "failed" }] } },
		{ ...notification(), details: { tasks: [notification().details.tasks[0], null] } },
	]) {
		const unchanged = structuredClone(message);
		await toggle(false);
		const component = new CustomMessageComponent(message, taskRenderer, undefined, 0);
		const original = component.render(120);
		await toggle(true);
		assert.deepEqual(component.render(120), original);
		assert.deepEqual(message, unchanged);
	}
});

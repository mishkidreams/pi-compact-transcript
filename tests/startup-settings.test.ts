import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { getAgentDir, initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";

function snapshot(root: string): Record<string, Buffer> {
	const files: Record<string, Buffer> = {};
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else files[relative(root, path)] = readFileSync(path);
		}
	};
	visit(root);
	return files;
}

test("session startup never prompts for or rewrites recommended settings", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-compact-startup-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const settings = { hideThinkingBlock: false, outputPad: 1, unrelated: "keep this setting" };
	const fixtures = [
		{ name: "no dismissal file", settings, config: undefined, project: undefined, trusted: false, enabled: true },
		{ name: "legacy false flag", settings, config: { settingsNagDismissed: false }, project: undefined, trusted: false, enabled: true },
		{ name: "legacy true flag", settings, config: { settingsNagDismissed: true }, project: undefined, trusted: false, enabled: true },
		{ name: "no settings or config", settings: undefined, config: undefined, project: undefined, trusted: false, enabled: true },
		{ name: "optional user configuration", settings, config: { enabled: false, summaryStyle: "quote", highlightToolActions: true }, project: undefined, trusted: false, enabled: false },
		{ name: "trusted project configuration", settings, config: { enabled: true }, project: { enabled: false }, trusted: true, enabled: false },
		{ name: "untrusted project ignored", settings, config: { enabled: true }, project: { enabled: false }, trusted: false, enabled: true },
	];
	try {
		initTheme("dark", false);
		for (const mode of ["tui", "rpc", "print", "json"] as const) {
			for (const fixture of fixtures) {
				await t.test(`${mode}: ${fixture.name}`, async () => {
					// A fresh module also catches a once-per-process nag that would
					// otherwise be masked by the first TUI scenario.
					const { default: compactTranscript } = await import(new URL(
						`../extensions/compact-transcript.ts?startup=${mode}-${fixtures.indexOf(fixture)}`,
						import.meta.url,
					).href);
					const directory = join(root, `${mode}-${fixtures.indexOf(fixture)}`);
					const agent = join(directory, "agent");
					const project = join(directory, "project");
					mkdirSync(agent, { recursive: true });
					mkdirSync(join(project, ".pi"), { recursive: true });
					process.env.PI_CODING_AGENT_DIR = agent;
					assert.equal(getAgentDir(), agent, "never inspect or write the real user settings");
					if (fixture.settings !== undefined) writeFileSync(join(agent, "settings.json"), JSON.stringify(fixture.settings, null, 2) + "\n");
					if (fixture.config !== undefined) writeFileSync(join(agent, "compact-transcript.json"), JSON.stringify(fixture.config, null, 2) + "\n");
					if (fixture.project !== undefined) writeFileSync(join(project, ".pi", "compact-transcript.json"), JSON.stringify(fixture.project, null, 2) + "\n");
					writeFileSync(join(project, "untouched.txt"), "unrelated fixture\n");
					const before = snapshot(directory);
					const handlers = new Map<string, Function>();
					const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
					const dialogs: unknown[][] = [];
					const notifications: unknown[][] = [];
					const entries: unknown[][] = [];
					let workingMessageCalls = 0;
					const statuses: unknown[][] = [];
					const ctx = {
						cwd: project,
						mode,
						hasUI: mode === "tui" || mode === "rpc",
						isProjectTrusted: () => fixture.trusted,
						sessionManager: { getBranch: () => [] },
						ui: {
							theme: { fg: (_color: string, value: string) => value, bold: (value: string) => value },
							setWorkingMessage() { workingMessageCalls++; },
							setStatus(...args: unknown[]) { statuses.push(args); },
							confirm: async (...args: unknown[]) => { dialogs.push(args); return false; },
							notify(...args: unknown[]) { notifications.push(args); },
						},
					} as unknown as ExtensionContext;
					const api = {
						on: (name: string, handler: Function) => handlers.set(name, handler),
						registerCommand: (name: string, command: any) => commands.set(name, command),
						registerEntryRenderer() {},
						appendEntry(...args: unknown[]) { entries.push(args); },
					} as unknown as ExtensionAPI;
					try {
						for (const reason of ["startup", "reload", "new", "resume", "fork"]) {
							compactTranscript(api);
							await handlers.get("session_start")!({ reason }, ctx);
						}
						assert.deepEqual(dialogs, [], "startup must not ask to apply settings");
						assert.deepEqual(notifications, [], "noninteractive modes must not emit a replacement nag");
						assert.deepEqual(entries, [], "startup must not add configuration entries");
						assert.equal(workingMessageCalls, 5, "unrelated startup initialization is retained");
						assert.deepEqual(statuses, Array.from({ length: 5 }, () => ["compact-transcript", undefined]));
						assert.deepEqual(snapshot(directory), before, "no settings writes or dismissal-file creation");
						assert.ok(commands.has("compact-transcript"), "the useful compact command remains available");
						await commands.get("compact-transcript")!.handler("status", ctx);
						assert.deepEqual(notifications, [[`Compact transcript: ${fixture.enabled ? "on" : "off"}`, "info"]]);
					} finally {
						await handlers.get("session_shutdown")?.({}, ctx);
					}
				});
			}
		}
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(root, { recursive: true, force: true });
	}
});

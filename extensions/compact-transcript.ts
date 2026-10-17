import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	CONFIG_DIR_NAME,
	CustomMessageComponent,
	getAgentDir,
	getMarkdownTheme,
	ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { type Component, Markdown, MouseRegion, Spacer, Text, stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { createInlineToolInspection } from "./inline-tool-inspection.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Older versions of this extension wrote a footer status under this key; it is
// kept only to clear that status once per session for users upgrading in place.
const STATUS_KEY = "compact-transcript";
const CONFIG_ENTRY_TYPE = "compact-transcript-config";
const SUMMARY_ENTRY_TYPE = "compact-transcript-summary";

const BLINK_INTERVAL_MS = 400;
const COMMENTARY_RAIL_WIDTH = 2;

type SummaryStyle = "plain" | "quote";

type CompactTranscriptConfig = {
	enabled: boolean;
	summaryStyle: SummaryStyle;
	highlightToolActions: boolean;
};

type ToolInfo = {
	id: string;
	name: string;
	args: any;
	preview: string;
	writeLines?: number;
	hidden?: boolean;
	running?: boolean;
	burstCount?: number;
	burstIds?: string[];
	burstOwnerId?: string;
	startedAt?: number;
	durationMs?: number;
	burstDurationMs?: number;
	diffStats?: DiffStats;
	result?: string;
	isError?: boolean;
	invalidate?: () => void;
};

type RunStats = {
	startedAt: number;
	toolCount: number;
	readFiles: Set<string>;
	editFiles: Set<string>;
	commandCount: number;
	otherCount: number;
	failedCount: number;
};

type DiffStats = {
	additions: number;
	deletions: number;
};

type SummaryData = {
	reads: number;
	edits: number;
	commands: number;
	others: number;
	failed: number;
	durationMs: number;
};

type InlineInspection = {
	component: Component;
	members: any[];
	setExpanded: (this: any, expanded: boolean) => void;
};

type RuntimeState = {
	config: CompactTranscriptConfig;
	toolsById: Map<string, ToolInfo>;
	currentBurst: ToolInfo[];
	hiddenToolIds: Set<string>;
	runningToolIds: Set<string>;
	agentActive: boolean;
	blinkOn: boolean;
	blinkTimer?: ReturnType<typeof setInterval>;
	runStats: RunStats;
	// Live transcript components, so toggling can re-render existing rows.
	toolComponents: Set<any>;
	assistantComponents: Set<any>;
	componentToolInfos: WeakMap<object, ToolInfo>;
	inlineInspections: WeakMap<object, InlineInspection>;
	inlineOwners: WeakMap<object, any>;
	inlineMouseDepth: number;
	currentTheme?: Theme;
	thinkingHidden: boolean;
	currentThoughtHeading?: string;
	thoughtAnchorId?: string;
};

const DEFAULT_CONFIG: CompactTranscriptConfig = {
	enabled: true,
	summaryStyle: "plain",
	highlightToolActions: false,
};

const STATE_KEY = Symbol.for("pi-compact-transcript.state");
const TOOL_PATCH_KEY = Symbol.for("pi-compact-transcript.tool-patch");
const ASSISTANT_PATCH_KEY = Symbol.for("pi-compact-transcript.assistant-patch");
const BACKGROUND_PATCH_KEY = Symbol.for("pi-compact-transcript.background-patch");

// Persisted dismissal flag so users who decline are never asked again.
const NAG_DISMISSED_KEY = "settingsNagDismissed";

// Only show the startup settings tip once per pi process lifetime.
let startupSettingsNagShown = false;

function newRunStats(): RunStats {
	return {
		startedAt: Date.now(),
		toolCount: 0,
		readFiles: new Set(),
		editFiles: new Set(),
		commandCount: 0,
		otherCount: 0,
		failedCount: 0,
	};
}

function normalizeConfig(input: unknown, fallback = DEFAULT_CONFIG): CompactTranscriptConfig {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	let enabled = fallback.enabled;
	if (typeof source.enabled === "boolean") {
		enabled = source.enabled;
	} else if (typeof source.mode === "string") {
		// Pre-0.5 config persisted a mode string instead of an enabled flag.
		enabled = source.mode !== "disabled" && source.mode !== "off";
	}
	const summaryStyle = source.summaryStyle === "plain" || source.summaryStyle === "quote"
		? source.summaryStyle
		: fallback.summaryStyle;
	const highlightToolActions = typeof source.highlightToolActions === "boolean"
		? source.highlightToolActions
		: fallback.highlightToolActions;
	return { enabled, summaryStyle, highlightToolActions };
}

function readConfigFile(path: string, fallback: CompactTranscriptConfig): CompactTranscriptConfig | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
		return normalizeConfig(parsed, fallback);
	} catch {
		// Missing, unreadable, or malformed config files use the next fallback.
		return undefined;
	}
}

function loadConfigFromFiles(ctx: ExtensionContext): CompactTranscriptConfig {
	let nextConfig = { ...DEFAULT_CONFIG };
	const userConfig = readConfigFile(join(getAgentDir(), "compact-transcript.json"), nextConfig);
	if (userConfig) nextConfig = userConfig;

	// Project-local configuration is only meaningful after Pi has trusted the
	// project. Never inspect this path for an untrusted project.
	if (ctx.isProjectTrusted()) {
		const projectConfig = readConfigFile(
			join(ctx.cwd, CONFIG_DIR_NAME, "compact-transcript.json"),
			nextConfig,
		);
		if (projectConfig) nextConfig = projectConfig;
	}

	return nextConfig;
}

function getState(): RuntimeState {
	const globalWithState = globalThis as typeof globalThis & { [STATE_KEY]?: RuntimeState };
	globalWithState[STATE_KEY] ??= {
		config: { ...DEFAULT_CONFIG },
		toolsById: new Map(),
		currentBurst: [],
		hiddenToolIds: new Set(),
		runningToolIds: new Set(),
		agentActive: false,
		blinkOn: true,
		runStats: newRunStats(),
		toolComponents: new Set(),
		assistantComponents: new Set(),
		componentToolInfos: new WeakMap(),
		inlineInspections: new WeakMap(),
		inlineOwners: new WeakMap(),
		inlineMouseDepth: 0,
		thinkingHidden: true,
	};
	const runtimeState = globalWithState[STATE_KEY]!;
	// /reload keeps the global object alive; initialize fields added by newer
	// versions when an older extension instance created the state object.
	runtimeState.config = normalizeConfig(runtimeState.config);
	runtimeState.thinkingHidden ??= true;
	runtimeState.componentToolInfos ??= new WeakMap();
	runtimeState.inlineInspections ??= new WeakMap();
	runtimeState.inlineOwners ??= new WeakMap();
	runtimeState.inlineMouseDepth ??= 0;
	return runtimeState;
}

const state = getState();

function isEnabled(): boolean {
	return state.config.enabled;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function shortenPath(path: unknown): string {
	if (typeof path !== "string" || !path) return "";
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

function oneLine(value: unknown): string {
	return String(value ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function quote(s: string): string {
	return JSON.stringify(s);
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value ?? {});
	} catch {
		return String(value);
	}
}

// Sub-second durations render as "" so fast tools stay clutter-free.
function formatDuration(ms: number): string {
	if (!Number.isFinite(ms) || ms < 1000) return "";
	const totalSeconds = Math.round(ms / 1000);
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds ? `${minutes}m${seconds}s` : `${minutes}m`;
}

// Checked in order; earlier keys are more likely to be the argument a human
// would recognize the call by.
const PREFERRED_ARG_KEYS = [
	"command",
	"code",
	"query",
	"pattern",
	"path",
	"file_path",
	"filePath",
	"file",
	"url",
	"prompt",
	"text",
	"description",
	"name",
];
const PATH_ARG_KEYS = new Set(["path", "file_path", "filePath", "file"]);

function previewFor(name: string, args: any): string {
	switch (name) {
		case "bash":
			return `$ ${oneLine(args?.command || "...")}`;
		case "read": {
			let out = `read ${shortenPath(args?.path) || "..."}`;
			if (args?.offset !== undefined || args?.limit !== undefined) {
				const start = args.offset ?? 1;
				const end = args.limit !== undefined ? start + args.limit - 1 : "";
				out += `:${start}${end ? `-${end}` : ""}`;
			}
			return out;
		}
		case "write":
			return `write ${shortenPath(args?.path) || "..."}`;
		case "edit": {
			const edits = Array.isArray(args?.edits) ? args.edits.length : 0;
			return `edit ${shortenPath(args?.path) || "..."}${edits > 1 ? ` (${edits} edits)` : ""}`;
		}
		case "grep": {
			const pattern = args?.pattern ? quote(String(args.pattern)) : "...";
			const path = shortenPath(args?.path) || ".";
			return `grep ${pattern} ${path}${args?.glob ? ` (${args.glob})` : ""}`;
		}
		case "find":
			return `find ${args?.pattern ? quote(String(args.pattern)) : "..."} ${shortenPath(args?.path) || "."}`;
		case "ls":
			return `ls ${shortenPath(args?.path) || "."}`;
		default: {
			// Unknown tools: show the most meaningful string argument instead of
			// dumping the whole args object as JSON.
			if (args && typeof args === "object") {
				for (const key of PREFERRED_ARG_KEYS) {
					const value = (args as Record<string, unknown>)[key];
					if (isNonEmptyString(value)) {
						const rendered = PATH_ARG_KEYS.has(key) ? shortenPath(value) : oneLine(value);
						return `${name} ${rendered}`;
					}
				}
				const firstString = Object.values(args).find(isNonEmptyString);
				if (firstString) return `${name} ${oneLine(firstString)}`;
			}
			return `${name} ${safeJson(args ?? {})}`;
		}
	}
}

function lineCount(text: string): number {
	if (!text) return 0;
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

function diffStatsFromArgs(args: any): DiffStats | undefined {
	if (!Array.isArray(args?.edits)) return undefined;
	let additions = 0;
	let deletions = 0;
	for (const edit of args.edits) {
		if (typeof edit?.oldText !== "string" || typeof edit?.newText !== "string") return undefined;
		deletions += lineCount(edit.oldText);
		additions += lineCount(edit.newText);
	}
	return additions || deletions ? { additions, deletions } : undefined;
}

function diffStatsFromResult(result: any): DiffStats | undefined {
	const diff = typeof result?.details?.diff === "string"
		? result.details.diff
		: typeof result?.details?.patch === "string"
			? result.details.patch
			: "";
	if (!diff) return undefined;

	let additions = 0;
	let deletions = 0;
	for (const line of diff.split(/\r?\n/)) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions++;
		else if (line.startsWith("-")) deletions++;
	}
	return additions || deletions ? { additions, deletions } : undefined;
}

function formatDiffStats(stats: DiffStats | undefined): string {
	return stats ? `+${stats.additions}/-${stats.deletions}` : "";
}

function colorDiffStats(theme: Theme, stats: string): string {
	const match = /^\+(\d+)\/(?:-)(\d+)$/.exec(stats);
	if (!match) return theme.fg("toolDiffContext", `{${stats}}`);
	return (
		theme.fg("toolDiffContext", "{") +
		theme.fg("toolDiffAdded", `+${match[1]}`) +
		theme.fg("toolDiffContext", "/") +
		theme.fg("toolDiffRemoved", `-${match[2]}`) +
		theme.fg("toolDiffContext", "}")
	);
}

function isEditTool(name: string): boolean {
	return name.split(".").pop() === "edit";
}

function isWriteTool(name: string): boolean {
	return name.split(".").pop() === "write";
}

function resultPreview(result: any, isPartial = false): string {
	const text = Array.isArray(result?.content)
		? result.content.find((c: any) => c?.type === "text" && typeof c.text === "string")?.text
		: undefined;
	if (!text) return isPartial ? "running" : "";
	const lines = String(text).trim().split("\n").filter(Boolean);
	if (lines.length === 0) return isPartial ? "running" : "";
	if (lines.length === 1) return lines[0];
	return `${lines.length} lines`;
}

function resetToolRun() {
	state.toolsById = new Map();
	state.currentBurst = [];
	state.hiddenToolIds = new Set();
	state.runningToolIds = new Set();
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	stopBlinkTimer();
}

function captureTheme(ctx: ExtensionContext) {
	state.currentTheme = ctx.ui.theme;
}

function setToolHidden(info: ToolInfo, hidden: boolean) {
	info.hidden = hidden;
	if (hidden) state.hiddenToolIds.add(info.id);
	else state.hiddenToolIds.delete(info.id);
}

function applyResult(info: ToolInfo, result: any, isError: boolean, isPartial: boolean) {
	const diffStats = isEditTool(info.name) ? diffStatsFromResult(result) : undefined;
	if (diffStats) info.diffStats = diffStats;
	else if (isError) info.diffStats = undefined;
	const suffix = resultPreview(result, isPartial);
	if (suffix) info.result = suffix;
	if (isError) {
		info.isError = true;
		// A failed tool always gets its own visible row, even if a burst had
		// hidden it; render it as itself rather than as a burst summary.
		info.burstCount = 1;
		setToolHidden(info, false);
	}
}

function ensureBlinkTimer() {
	if (state.blinkTimer || state.runningToolIds.size === 0) return;
	state.blinkTimer = setInterval(() => {
		if (state.runningToolIds.size === 0) {
			stopBlinkTimer();
			return;
		}
		state.blinkOn = !state.blinkOn;
		for (const id of state.runningToolIds) state.toolsById.get(id)?.invalidate?.();
	}, BLINK_INTERVAL_MS);
	state.blinkTimer.unref?.();
}

function stopBlinkTimer() {
	if (state.blinkTimer) clearInterval(state.blinkTimer);
	state.blinkTimer = undefined;
	state.blinkOn = true;
}

function statusMarker(theme: Theme, opts: { running?: boolean; isError?: boolean; hasResult?: boolean }): string {
	if (opts.isError) return theme.fg("error", "◆ ");
	if (opts.running) return theme.fg("dim", state.blinkOn ? "◆ " : "◇ ");
	if (opts.hasResult) return theme.fg("success", "◆ ");
	return theme.fg("dim", "◆ ");
}

function textSignalHasVisibleContent(assistantMessageEvent: any): boolean {
	const type = assistantMessageEvent?.type;
	if (type === "text_delta") {
		return typeof assistantMessageEvent.delta === "string" && assistantMessageEvent.delta.trim().length > 0;
	}
	if (type === "text_end") {
		return typeof assistantMessageEvent.content === "string" && assistantMessageEvent.content.trim().length > 0;
	}
	return false;
}

function thoughtTickerEnabled(): boolean {
	// Hidden thinking is its own one-line row in the assistant message, same
	// place as Pi's "Thinking..." label. A second headline under a tool is the
	// old hole: it vanishes until a tool exists, and duplicates the row after.
	return false;
}

function cleanThoughtHeading(line: string): string {
	let clean = oneLine(line)
		.replace(/^#{1,6}\s+/, "")
		.replace(/^[-*]\s+/, "")
		.trim();
	clean = clean
		.replace(/^\*\*(.+)\*\*$/, "$1")
		.replace(/^__(.+)__$/, "$1")
		.replace(/^`(.+)`$/, "$1");
	return clean.trim();
}

function extractThoughtHeading(text: unknown): string {
	if (typeof text !== "string") return "";
	const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0);
	return firstLine ? cleanThoughtHeading(firstLine) : "";
}

function latestThoughtLine(text: string): string {
	const lines = text.split(/\r?\n/);
	for (let i = lines.length - 1; i >= 0; i--) {
		const clean = cleanThoughtHeading(lines[i]);
		if (clean) return clean;
	}
	return "";
}

function latestThoughtHeading(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	for (let i = message.content.length - 1; i >= 0; i--) {
		const content = message.content[i];
		if (content?.type === "thinking") return extractThoughtHeading(content.thinking);
	}
	return "";
}

function invalidateToolById(id: string | undefined) {
	if (!id) return;
	state.toolsById.get(id)?.invalidate?.();
}

function latestVisibleTool(): ToolInfo | undefined {
	return Array.from(state.toolsById.values())
		.reverse()
		.find((tool) => !tool.hidden);
}

function clearCurrentThought() {
	if (!state.currentThoughtHeading && !state.thoughtAnchorId) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.currentThoughtHeading = undefined;
	state.thoughtAnchorId = undefined;
	invalidateToolById(previousAnchorId);
}

function setCurrentThought(heading: string) {
	const nextHeading = oneLine(heading);
	if (!thoughtTickerEnabled() || !nextHeading) {
		clearCurrentThought();
		return;
	}

	const previousAnchorId = state.thoughtAnchorId;
	const nextAnchorId = latestVisibleTool()?.id;
	const changed = state.currentThoughtHeading !== nextHeading || previousAnchorId !== nextAnchorId;
	state.currentThoughtHeading = nextHeading;
	state.thoughtAnchorId = nextAnchorId;
	if (!changed) return;

	invalidateToolById(previousAnchorId);
	if (nextAnchorId !== previousAnchorId) invalidateToolById(nextAnchorId);
}

function updateCurrentThoughtFromMessage(message: any) {
	const heading = latestThoughtHeading(message);
	// A new thinking block starts empty; keep showing the previous heading until
	// the replacement has real text so the ticker does not blink off/on between
	// tool completion and the next streamed thought.
	if (heading) setCurrentThought(heading);
}

function anchorCurrentThoughtTo(info: ToolInfo) {
	if (!thoughtTickerEnabled() || !state.currentThoughtHeading || state.thoughtAnchorId === info.id) return;
	const previousAnchorId = state.thoughtAnchorId;
	state.thoughtAnchorId = info.id;
	invalidateToolById(previousAnchorId);
	info.invalidate?.();
}

function currentThoughtLine(toolCallId: string, theme: Theme): string {
	const renderAnchorId = latestVisibleTool()?.id ?? state.thoughtAnchorId;
	if (!thoughtTickerEnabled() || renderAnchorId !== toolCallId || !state.currentThoughtHeading) return "";
	const prefix = "  ↳ ";
	return theme.fg("dim", prefix) + theme.fg("thinkingText", state.currentThoughtHeading);
}

function upsertToolInfo(id: string, name: string, args: any, invalidate?: () => void): ToolInfo {
	let info = state.toolsById.get(id);
	if (!info) {
		info = { id, name, args, preview: previewFor(name, args) };
		state.toolsById.set(id, info);
	}
	return refreshToolInfo(info, name, args, invalidate);
}

function refreshToolInfo(info: ToolInfo, name: string, args: any, invalidate?: () => void): ToolInfo {
	info.name = name;
	info.args = args;
	info.preview = previewFor(name, args);
	info.writeLines = isWriteTool(name) && typeof args?.content === "string" ? lineCount(args.content) : undefined;
	if (isEditTool(name) && !info.diffStats) info.diffStats = diffStatsFromArgs(args);
	if (invalidate) info.invalidate = invalidate;
	return info;
}

function recordToolStart(name: string, args: any) {
	const base = name.split(".").pop() ?? name;
	state.runStats.toolCount++;
	if (base === "read") {
		if (isNonEmptyString(args?.path)) state.runStats.readFiles.add(args.path);
	} else if (base === "edit" || base === "write") {
		if (isNonEmptyString(args?.path)) state.runStats.editFiles.add(args.path);
	} else if (base === "bash") {
		state.runStats.commandCount++;
	} else {
		state.runStats.otherCount++;
	}
}

function joinBurst(info: ToolInfo) {
	const previous = state.currentBurst[state.currentBurst.length - 1];

	if (!isEnabled()) {
		state.currentBurst = [];
		return;
	}

	// Bursts only group repeats of the same tool; a different tool starts a
	// fresh row (and leaves the previous row visible with its count).
	if (state.currentBurst.length && state.currentBurst[state.currentBurst.length - 1].name !== info.name) {
		state.currentBurst = [];
	}

	if (!state.currentBurst.some((tool) => tool.id === info.id)) state.currentBurst.push(info);
	for (const tool of state.currentBurst.slice(0, -1)) setToolHidden(tool, true);
	info.burstCount = state.currentBurst.length;
	info.burstIds = state.currentBurst.map(tool => tool.id);
	for (const member of state.currentBurst) member.burstOwnerId = info.id;
	previous?.invalidate?.();
}

function beginTool(id: string, name: string, args: any) {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	info.running = true;
	info.isError = false;
	info.startedAt = Date.now();
	state.runningToolIds.add(id);
	ensureBlinkTimer();
	recordToolStart(name, args);
	joinBurst(info);
	anchorCurrentThoughtTo(info);
	// The component may already be on screen from argument streaming; repaint
	// now so the running marker, burst count, and thought ticker appear
	// immediately instead of waiting for the next result event or blink tick.
	info.invalidate?.();
}

// A tool row rendered without a live tool_execution_start event — pi is
// rebuilding chat history after resume/reload. Reconstruct burst grouping so
// scrollback coalesces the same way the live view did, but skip timers,
// stats, and running state.
function hydrateTool(id: string, name: string, args: any, isError: boolean): ToolInfo {
	const info = upsertToolInfo(id, name, args);
	setToolHidden(info, false);
	info.burstCount = 1;
	if (isError) {
		info.isError = true;
		state.currentBurst = [];
		return info;
	}
	joinBurst(info);
	return info;
}

function updateToolResult(toolCallId: string, result: any, isError = false, isPartial = false) {
	if (!isPartial) {
		state.runningToolIds.delete(toolCallId);
		if (state.runningToolIds.size === 0) stopBlinkTimer();
	}
	const info = state.toolsById.get(toolCallId);
	if (!info) return;
	if (!isPartial) {
		info.running = false;
		if (info.startedAt) info.durationMs = Date.now() - info.startedAt;
		if (state.currentBurst.includes(info) && state.currentBurst.length > 1) {
			info.burstDurationMs = state.currentBurst.reduce((total, tool) => total + (tool.durationMs ?? 0), 0);
		}
		if (isError) state.runStats.failedCount++;
	}
	applyResult(info, result, isError, isPartial);
	// A failure ends the current burst so the red row stays visible and the
	// next tool starts a fresh count.
	if (isError) state.currentBurst = [];
	info.invalidate?.();
}

function compactToolLine(info: ToolInfo, theme: Theme, hasResult: boolean, individual = false): string {
	if (info.hidden && !individual) return "";

	const isBurst = !individual && (info.burstCount ?? 1) > 1;
	const durationText = formatDuration((isBurst ? (info.burstDurationMs ?? info.durationMs) : info.durationMs) ?? 0);
	const editStats = isEditTool(info.name) ? formatDiffStats(info.diffStats) : "";
	const writeStats =
		isWriteTool(info.name) && !info.isError && info.writeLines !== undefined
			? formatDiffStats({ additions: info.writeLines, deletions: 0 })
			: "";
	const stats = editStats || writeStats;
	const inner = [info.result ? oneLine(info.result) : "", durationText].filter(Boolean).join(" · ");
	const status = stats ? ` {${stats}}` : inner ? ` {${inner}}` : info.running ? " {running}" : "";
	const details = `${info.preview}${status}`;
	const marker = statusMarker(theme, {
		running: info.running,
		isError: info.isError,
		hasResult: hasResult || !!info.result,
	});
	const color = info.isError ? "muted" : "dim";
	const prefix = isBurst ? `${info.burstCount}× ` : "";
	const plainLine = prefix + oneLine(details);
	const action = info.name === "bash" ? /^\$\s+\S+/.exec(info.preview)?.[0] ?? "$" : info.name;
	const actionStart = prefix.length;
	const actionEnd = Math.min(actionStart + action.length, plainLine.length);
	const statsMarker = stats ? `{${stats}}` : "";
	const statsIndex = statsMarker ? plainLine.lastIndexOf(statsMarker) : -1;
	if (!state.config.highlightToolActions) {
		if (statsIndex >= 0) {
			return (
				marker +
				theme.fg(color, plainLine.slice(0, statsIndex)) +
				colorDiffStats(theme, stats) +
				theme.fg(color, plainLine.slice(statsIndex + statsMarker.length))
			);
		}
		return marker + theme.fg(color, plainLine);
	}
	const beforeStatsEnd = statsIndex >= 0 ? statsIndex : plainLine.length;
	return (
		marker +
		theme.fg(color, plainLine.slice(0, actionStart)) +
		theme.fg("toolTitle", theme.bold(plainLine.slice(actionStart, actionEnd))) +
		theme.fg(color, plainLine.slice(actionEnd, beforeStatsEnd)) +
		(statsIndex >= 0 ? colorDiffStats(theme, stats) : "") +
		theme.fg(color, statsIndex >= 0 ? plainLine.slice(statsIndex + statsMarker.length) : "")
	);
}

function toolInfoFor(component: any): ToolInfo | undefined {
	return state.componentToolInfos.get(component) ?? state.toolsById.get(component.toolCallId);
}

function closeInlineInspection(host: any, collapse = true) {
	const view = state.inlineInspections.get(host);
	if (!view) return;
	state.inlineInspections.delete(host);
	for (const member of view.members) state.inlineOwners.delete(member);
	if (collapse) for (const member of view.members) view.setExpanded.call(member, false);
	if (collapse) for (const member of view.members) member.updateDisplay();
}

function openInlineInspection(host: any, original: { render: Function; handleMouse: Function; setExpanded: (this: any, expanded: boolean) => void }): boolean {
	if (!state.currentTheme) return false;
	const info = toolInfoFor(host);
	if (!info) return false;
	const ids = (info?.burstCount ?? 1) > 1 ? info?.burstIds : [host.toolCallId];
	if (!ids?.length || ids.length !== (info?.burstCount ?? 1)) return false;
	const components = new Map([...state.toolComponents].map(component => [component.toolCallId, component]));
	const members = ids.map(id => components.get(id));
	if (members.some(member => !member || !toolInfoFor(member))) return false; // Never guess which hidden call the user meant.
	const summary = (member: any, individual: boolean): Component => ({
		render: width => [truncateToWidth(compactToolLine(toolInfoFor(member)!, state.currentTheme!, member.result != null, individual), Math.max(0, width), state.currentTheme!.fg("dim", "…"))],
		invalidate() {},
	});
	const entries = members.map(member => ({
		summary: summary(member, true),
		isExpanded: () => !!member.expanded,
		expand() {
			if (!member.result) return false;
			original.setExpanded.call(member, true);
			member.ui?.requestRender?.();
			return true;
		},
		details: {
			render: (width: number) => original.render.call(member, width),
			handleMouse(event: any) {
				state.inlineMouseDepth++;
				try { return original.handleMouse.call(member, event); }
				finally { state.inlineMouseDepth--; }
			},
			invalidate: () => member.invalidate(),
		},
	}));
	const component = createInlineToolInspection(entries, members.length > 1 ? {
		component: summary(host, false),
		close() { closeInlineInspection(host); host.ui?.requestRender?.(); },
	} : undefined);
	state.inlineInspections.set(host, {
		component, members,
		setExpanded: original.setExpanded,
	});
	for (const member of members) state.inlineOwners.set(member, host);
	if (members.length === 1) entries[0].expand();
	host.ui?.requestRender?.();
	return true;
}

function patchToolExecutionComponent() {
	const proto = ToolExecutionComponent.prototype as any;
	if (typeof proto.updateDisplay !== "function" || typeof proto.render !== "function") return;
	const existing = proto[TOOL_PATCH_KEY] as
		| { originalUpdateDisplay: (...args: any[]) => any; originalRender: (...args: any[]) => any; originalHandleMouse?: (...args: any[]) => any; originalSetExpanded?: (expanded: boolean) => void }
		| undefined;
	const originalUpdateDisplay = existing?.originalUpdateDisplay ?? proto.updateDisplay;
	const originalRender = existing?.originalRender ?? proto.render;
	const originalHandleMouse = existing?.originalHandleMouse ?? proto.handleMouse;
	const originalSetExpanded = existing?.originalSetExpanded ?? proto.setExpanded;

	proto.updateDisplay = function patchedUpdateDisplay() {
		if (!this.toolCallId || !this.toolName || !this.selfRenderContainer || typeof this.selfRenderContainer.clear !== "function") {
			this.__compactTranscriptForceSelf = false;
			this.__compactTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}
		state.toolComponents.add(this);
		const inspectionHost = state.inlineOwners.get(this);
		if (inspectionHost && this.result?.isError) closeInlineInspection(inspectionHost);

		const invalidate = () => {
			this.invalidate();
			this.ui?.requestRender?.();
		};
		// The per-run map is reset at agent_start. Keep the actual historical
		// component's metadata separately so an old group never becomes a new
		// live burst (or silently opens only its last member).
		let info = state.componentToolInfos.get(this);
		if (!info) {
			if (!state.toolsById.has(this.toolCallId)) hydrateTool(this.toolCallId, this.toolName, this.args, this.result?.isError ?? false);
			info = upsertToolInfo(this.toolCallId, this.toolName, this.args, invalidate);
			state.componentToolInfos.set(this, info);
		} else refreshToolInfo(info, this.toolName, this.args, invalidate);
		applyResult(info, this.result, this.result?.isError ?? false, this.isPartial);
		if (isEnabled() && !this.expanded) {
			// Burst ownership, unlike an inspection's saved hiding flags, stays
			// authoritative when new calls arrive or compact is toggled off/on.
			setToolHidden(info, !info.isError && !!info.burstOwnerId && info.burstOwnerId !== info.id);
		}

		if (!isEnabled() || this.expanded) {
			setToolHidden(info, false);
			this.__compactTranscriptForceSelf = false;
			this.__compactTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		this.__compactTranscriptForceSelf = true;
		this.__compactTranscriptHidden = false;
		this.selfRenderContainer.clear();
		for (const image of this.imageComponents ?? []) this.removeChild?.(image);
		for (const spacer of this.imageSpacers ?? []) this.removeChild?.(spacer);
		this.imageComponents = [];
		this.imageSources = [];
		this.imageSpacers = [];

		const theme = state.currentTheme;
		if (!theme) {
			this.__compactTranscriptForceSelf = false;
			this.__compactTranscriptHidden = false;
			return originalUpdateDisplay.call(this);
		}

		const line = compactToolLine(info, theme, this.result != null);

		if (!line) {
			this.__compactTranscriptHidden = true;
			return;
		}

		this.selfRenderContainer.addChild({
			render: (width: number) => [truncateToWidth(line, Math.max(0, width), theme.fg("dim", "…"))],
			invalidate() {},
		});
		const thoughtLine = currentThoughtLine(this.toolCallId, theme);
		if (thoughtLine) {
			this.selfRenderContainer.addChild({
				render: (width: number) => [truncateToWidth(thoughtLine, Math.max(0, width), theme.fg("dim", "…"))],
				invalidate() {},
			});
		}
	};

	proto.render = function patchedRender(width: number) {
		if (isEnabled()) {
			const owner = state.inlineOwners.get(this);
			if (owner && owner !== this) return [];
			const inspection = state.inlineInspections.get(this);
			if (inspection) {
				const info = toolInfoFor(this);
				if (info?.hidden || (info?.burstOwnerId && info.burstOwnerId !== info.id)) closeInlineInspection(this);
				else return inspection.component.render(width);
			}
		}
		if (this.hideComponent || this.__compactTranscriptHidden) return [];
		if (this.__compactTranscriptForceSelf) return this.selfRenderContainer.render(width);
		return originalRender.call(this, width);
	};
	if (typeof originalHandleMouse === "function" && typeof originalSetExpanded === "function") {
		proto.handleMouse = function (event: any) {
			if (isEnabled()) {
				const owner = state.inlineOwners.get(this);
				if (owner && owner !== this) return undefined;
				const inspection = state.inlineInspections.get(this);
				if (inspection) return inspection.component.handleMouse?.(event);
				if (this.__compactTranscriptForceSelf) {
					if (this.hideComponent || this.__compactTranscriptHidden || event.y !== 0 || event.type !== "click" || event.button !== "left") return undefined;
					if (!this.result && (toolInfoFor(this)?.burstCount ?? 1) <= 1) return undefined;
					if (openInlineInspection(this, { render: originalRender, handleMouse: originalHandleMouse, setExpanded: originalSetExpanded })) return { handled: true };
					return undefined;
				}
			}
			return originalHandleMouse.call(this, event);
		};
		proto.setExpanded = function (expanded: boolean) {
			if (!state.inlineMouseDepth) {
				const owner = state.inlineOwners.get(this);
				if (owner) closeInlineInspection(owner, false);
			}
			return originalSetExpanded.call(this, expanded);
		};
	}

	proto[TOOL_PATCH_KEY] = { originalUpdateDisplay, originalRender, originalHandleMouse, originalSetExpanded };
}

/** Re-apply pi's markdown transformers (mirrors createMarkdownTransform in pi core).
 *  Without this, Mermaid blocks fall back to raw code when this extension
 *  takes over rendering of assistant text. */
function applyMarkdownTransformers(
	markdown: string,
	transformers: any[],
	messageType: string,
	isStreaming: boolean,
	availableWidth: number,
): string {
	let transformedMarkdown = markdown;
	for (const transformer of transformers ?? []) {
		try {
			const transformed = transformer(transformedMarkdown, { messageType, isStreaming, availableWidth });
			if (typeof transformed === "string") transformedMarkdown = transformed;
		} catch {
			// Keep the current Markdown and continue with the next transformer.
		}
	}
	return transformedMarkdown;
}

class CommentaryRail implements Component {
	private readonly content: Component;

	constructor(content: Component) {
		this.content = content;
	}

	render(width: number): string[] {
		if (width <= COMMENTARY_RAIL_WIDTH) return this.content.render(width);
		const rail = state.currentTheme?.fg("accent", "│ ") ?? "│ ";
		return this.content.render(width - COMMENTARY_RAIL_WIDTH).map((line) => rail + line);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}

function frameCommentary(component: any, message: any): void {
	if (!message.content.some((content: any) => content.type === "toolCall")) return;
	const children = component.contentContainer?.children;
	if (!Array.isArray(children)) return;
	let framed = false;
	for (let i = 0; i < children.length; i++) {
		if (children[i] instanceof Markdown) {
			children[i] = new CommentaryRail(children[i]);
			framed = true;
		}
	}
	if (framed) component.contentContainer.addChild(new Spacer(1));
}

function patchAssistantMessageComponent() {
	const proto = AssistantMessageComponent.prototype as any;
	if (typeof proto.updateContent !== "function") return;
	const existing = proto[ASSISTANT_PATCH_KEY] as { originalUpdateContent: (...args: any[]) => any } | undefined;
	const originalUpdateContent = existing?.originalUpdateContent ?? proto.updateContent;

	proto.updateContent = function patchedUpdateContent(this: any, message: any, isStreaming = this.isStreaming) {
		state.assistantComponents.add(this);
		state.thinkingHidden = !!this.hideThinkingBlock;
		if (!state.thinkingHidden) clearCurrentThought();
		if (!isEnabled() || !Array.isArray(message?.content)) {
			return originalUpdateContent.call(this, message, isStreaming);
		}
		if (!(this.thinkingVisibilityOverrides instanceof Map) || ["length", "aborted", "error"].includes(message.stopReason) || (!this.hideThinkingBlock && this.thinkingVisibilityOverrides.size === 0)) {
			const result = originalUpdateContent.call(this, message, isStreaming);
			frameCommentary(this, message);
			return result;
		}
		if (!this.contentContainer || typeof this.contentContainer.clear !== "function") {
			return originalUpdateContent.call(this, message, isStreaming);
		}

		this.isStreaming = isStreaming;
		this.lastMessage = message;
		this.contentContainer.clear();
		this.hasToolCalls = message.content.some((c: any) => c.type === "toolCall");
		clearCurrentThought();
		// Assistant text ends a tool burst. The live path also does this via
		// message_update events; doing it here too keeps hydrated history from
		// grouping tool rows across turn boundaries.
		if (message.content.some((c: any) => c.type === "text" && c.text?.trim())) state.currentBurst = [];

		const theme = state.currentTheme;
		let opened = false;
		let thinkingParts: string[] = [];
		let thinkingRunIndex = 0;
		const open = () => {
			if (opened) return;
			this.contentContainer.addChild(new Spacer(1));
			opened = true;
		};
		const flushThinking = () => {
			if (thinkingParts.length === 0) return;
			// Pi skips a thinking run whose text trims to nothing. An empty
			// reasoning item still occupies a content slot, so a label here would
			// be a blank row that disappears when thinking is shown.
			const thinking = thinkingParts.map(part => part.trim()).filter(Boolean).join("\n\n");
			const heading = latestThoughtLine(thinking);
			thinkingParts = [];
			if (!heading) return;
			const runIndex = thinkingRunIndex++;
			const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
			// The separator sits under the thought, not above it. Marking it opened
			// stops a following answer from inserting a second blank in that slot.
			// An empty run returns before this, so it does not eat the text separator.
			// 0.11.1 dropped limitPlain and truncates tool rows inside render(width).
			// A Text child wraps whatever was pre-cut, so a one-line thought became
			// two lines whenever the guess was wider than the chat column.
			const component = this;
			const preview: Component = {
				render: (width: number) => {
					const pad = Math.max(0, component.outputPad ?? 0);
					const inset = Math.min(pad, Math.max(0, width));
					const room = Math.max(0, width - inset);
					const colored = theme?.fg ? theme.fg("thinkingText", heading) : heading;
					const styled = typeof theme?.italic === "function" ? theme.italic(colored) : colored;
					const ellipsis = theme?.fg ? theme.fg("dim", "…") : "…";
					return [" ".repeat(inset) + truncateToWidth(styled, room, ellipsis)];
				},
				invalidate() {},
			};
			const visible = new Markdown(thinking, this.outputPad, 0, this.markdownTheme, {
				color: (text: string) => theme?.fg ? theme.fg("thinkingText", text) : text,
				italic: true,
			}, { transform: (markdown: string, width: number) => applyMarkdownTransformers(markdown, this.markdownTransformers, "assistant-thinking", this.isStreaming, width) });
			this.contentContainer.addChild(new MouseRegion(hidden ? preview : visible, (event: any) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.thinkingVisibilityOverrides.set(runIndex, !hidden);
				if (this.lastMessage) this.updateContent(this.lastMessage);
				return { handled: true };
			}));
			this.contentContainer.addChild(new Spacer(1));
			opened = true;
		};

		for (const content of message.content) {
			if (content?.type === "thinking") {
				thinkingParts.push(typeof content.thinking === "string" ? content.thinking : "");
				continue;
			}
			flushThinking();
			if (content?.type !== "text" || !content.text?.trim()) continue;
			open();
			this.contentContainer.addChild(
				new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
					transform: (markdown: string, availableWidth: number) =>
						applyMarkdownTransformers(
							markdown,
							(this as any).markdownTransformers,
							"assistant",
							(this as any).isStreaming ?? false,
							availableWidth,
						),
				}),
			);
		}
		flushThinking();
		frameCommentary(this, message);
	};

	proto[ASSISTANT_PATCH_KEY] = { originalUpdateContent };
}

type BackgroundTask = {
	source: string;
	taskId: string;
	event: "ready" | "terminal";
	status: string;
	durationMs: number;
	ok?: boolean;
};

function isBackgroundTask(value: unknown): value is BackgroundTask {
	if (!value || typeof value !== "object") return false;
	const task = value as Partial<BackgroundTask>;
	return isNonEmptyString(task.source) && isNonEmptyString(task.taskId) && isNonEmptyString(task.status)
		&& (task.event === "ready" || task.event === "terminal")
		&& typeof task.durationMs === "number" && Number.isFinite(task.durationMs);
}

function compactBackgroundTaskLine(message: any, theme: Theme): string | undefined {
	// These are custom messages, not tool results. The shared task coordinator
	// uses this type for pwsh, Python and subagent updates, including batches.
	// Leave other extensions' messages and unknown payloads entirely alone.
	if (message?.customType !== "pi-background-task-notification") return undefined;
	const tasks: unknown = message.details?.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0 || !tasks.every(isBackgroundTask)) return undefined;
	const clean = (text: string) => oneLine(stripTerminalSequences(text));
	const status = (task: BackgroundTask) => task.event === "ready" ? "ready" : clean(task.status);
	const failed = tasks.some((task) => task.ok === false || ["failed", "orphaned"].includes(task.status));
	const tone = failed ? "error" : tasks.some((task) => !["ready", "completed"].includes(status(task))) ? "warning" : "success";
	let preview: string;
	if (tasks.length === 1) {
		const task = tasks[0];
		const details = [status(task), formatDuration(Math.max(0, task.durationMs))].filter(Boolean).join(" · ");
		preview = `${clean(task.source)} ${clean(task.taskId)} {${details}}`;
	} else {
		// A single delivery may contain several tasks. Keep all status counts so
		// a failure later in the batch cannot disappear behind the first task.
		const counts = new Map<string, number>();
		for (const task of tasks) counts.set(status(task), (counts.get(status(task)) ?? 0) + 1);
		// Readiness goes first so narrow rows do not hide requests for input;
		// failures remain visible in the red marker even if counts are clipped.
		const details = [...counts]
			.sort(([a], [b]) => Number(b === "ready") - Number(a === "ready"))
			.map(([name, count]) => `${count} ${name}`).join(" · ");
		preview = `${tasks.length} background tasks {${details}}`;
	}
	return theme.fg(tone, "◆ ") + theme.fg(failed ? "muted" : "dim", preview);
}

function patchBackgroundTaskNotifications() {
	const proto = CustomMessageComponent.prototype as any;
	if (typeof proto.render !== "function") return;
	const originalRender = proto[BACKGROUND_PATCH_KEY]?.originalRender ?? proto.render;

	proto.render = function patchedBackgroundRender(width: number) {
		// Render-time selection also handles already-visible and resumed
		// messages, on/off toggles and resizing, without retaining components.
		// Do not rewrite the message or replace the provider's detail renderer.
		if (isEnabled() && this._expanded === false && state.currentTheme) {
			const line = compactBackgroundTaskLine(this.message, state.currentTheme);
			if (line !== undefined) {
				return [truncateToWidth(line, Math.max(0, width), state.currentTheme.fg("dim", "…"))];
			}
		}
		return originalRender.call(this, width);
	};
	proto[BACKGROUND_PATCH_KEY] = { originalRender };
}

function patchRenderers() {
	patchToolExecutionComponent();
	patchAssistantMessageComponent();
	patchBackgroundTaskNotifications();
}

// Re-render every transcript row we have touched so toggling applies to the
// visible transcript immediately instead of only to future rows.
function refreshTranscript() {
	let ui: any;
	for (const component of state.toolComponents) {
		try {
			if (!isEnabled()) closeInlineInspection(state.inlineOwners.get(component));
			// ToolExecutionComponent.invalidate() re-runs updateDisplay.
			component.invalidate?.();
			ui ??= component.ui;
		} catch {
			state.toolComponents.delete(component);
		}
	}
	for (const component of state.assistantComponents) {
		try {
			if (component.lastMessage) component.updateContent?.(component.lastMessage);
			component.invalidate?.();
		} catch {
			state.assistantComponents.delete(component);
		}
	}
	ui?.requestRender?.();
}

function summaryLine(data: SummaryData): string {
	const plural = (count: number) => (count === 1 ? "" : "s");
	const parts: string[] = [];
	if (data.reads) parts.push(`read ${data.reads} file${plural(data.reads)}`);
	if (data.edits) parts.push(`edited ${data.edits} file${plural(data.edits)}`);
	if (data.commands) parts.push(`ran ${data.commands} command${plural(data.commands)}`);
	if (data.others) parts.push(`${data.others} other tool${plural(data.others)}`);
	if (data.failed) parts.push(`${data.failed} failed`);
	if (parts.length === 0) return "";
	const text = parts.join(", ");
	const capitalized = text[0].toUpperCase() + text.slice(1);
	const duration = formatDuration(data.durationMs);
	return duration ? `${capitalized} · ${duration}` : capitalized;
}

function normalizeSummary(input: unknown): SummaryData {
	const source = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
	const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
	return {
		reads: num(source.reads),
		edits: num(source.edits),
		commands: num(source.commands),
		others: num(source.others),
		failed: num(source.failed),
		durationMs: num(source.durationMs),
	};
}

function appendRunSummary(pi: ExtensionAPI) {
	const stats = state.runStats;
	// Single-tool runs are self-evident from the transcript; a summary line
	// would just repeat the row above it.
	if (!isEnabled() || stats.toolCount < 2) return;
	const data: SummaryData = {
		reads: stats.readFiles.size,
		edits: stats.editFiles.size,
		commands: stats.commandCount,
		others: stats.otherCount,
		failed: stats.failedCount,
		durationMs: Date.now() - stats.startedAt,
	};
	pi.appendEntry(SUMMARY_ENTRY_TYPE, data);
}

function restoreConfigFromBranch(ctx: ExtensionContext) {
	let nextConfig = loadConfigFromFiles(ctx);
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === CONFIG_ENTRY_TYPE) {
			nextConfig = normalizeConfig(entry.data, nextConfig);
		}
	}
	state.config = nextConfig;
}

function readNagDismissedFlag(): boolean {
	const configPath = join(getAgentDir(), "compact-transcript.json");
	try {
		const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return (parsed as Record<string, unknown>)[NAG_DISMISSED_KEY] === true;
		}
	} catch {
		// Missing or unreadable config — assume not dismissed.
	}
	return false;
}

function persistNagDismissed() {
	const configPath = join(getAgentDir(), "compact-transcript.json");
	let config: Record<string, unknown> = {};
	try {
		const raw = readFileSync(configPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			config = parsed as Record<string, unknown>;
		}
	} catch {
		// File missing or unreadable — start fresh.
	}
	config[NAG_DISMISSED_KEY] = true;
	writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function checkAndNotifyRecommendedSettings(ctx: ExtensionContext) {
	if (startupSettingsNagShown) return;
	startupSettingsNagShown = true;

	// User previously dismissed the dialog.
	if (readNagDismissedFlag()) return;

	const settingsPath = join(getAgentDir(), "settings.json");
	let settings: Record<string, unknown> = {};
	try {
		const raw = readFileSync(settingsPath, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			settings = parsed as Record<string, unknown>;
		}
	} catch {
		// Missing or unreadable settings file — skip.
		return;
	}

	const needsThinkingFix = settings.hideThinkingBlock !== true;
	const needsPadFix = settings.outputPad !== 0;
	if (!needsThinkingFix && !needsPadFix) return;

	const missing: string[] = [];
	if (needsThinkingFix) missing.push("hideThinkingBlock: true");
	if (needsPadFix) missing.push("outputPad: 0");

	// In non-TUI modes (RPC, print), fall back to a one-time warning notification
	// since interactive dialogs are unavailable.
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			`Compact Transcript tip: set ${missing.join(", ")} in /settings for the best experience.`,
			"warning",
		);
		return;
	}

	// Interactive confirm dialog.
	const message = [
		"Compact Transcript works best with:",
		...missing.map((m) => `  • ${m}`),
		"",
		"Apply these recommended settings now?",
	].join("\n");

	ctx.ui.confirm("Compact Transcript", message).then((accepted) => {
		if (accepted) {
			// Re-read settings fresh (may have changed since we last read).
			let current: Record<string, unknown> = {};
			try {
				const raw = readFileSync(settingsPath, "utf8");
				const parsed: unknown = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					current = parsed as Record<string, unknown>;
				}
			} catch {
				// Shouldn't happen since we just read it, but handle gracefully.
			}
			if (needsThinkingFix) current.hideThinkingBlock = true;
			if (needsPadFix) current.outputPad = 0;
			writeFileSync(settingsPath, JSON.stringify(current, null, 2) + "\n", "utf8");
			ctx.ui.notify(
				"Compact Transcript settings applied! Reload to take effect (/reload).",
				"info",
			);
		} else {
			persistNagDismissed();
			ctx.ui.notify(
				"Compact Transcript tip dismissed. Adjust anytime via /settings.",
				"info",
			);
		}
	});
}

function setEnabled(enabled: boolean, pi: ExtensionAPI, ctx: ExtensionContext) {
	state.config.enabled = enabled;
	// Session entries represent only the command's enabled override; file-only
	// settings such as summaryStyle should continue to follow configuration.
	pi.appendEntry(CONFIG_ENTRY_TYPE, { enabled });
	refreshTranscript();
	ctx.ui.notify(`Compact transcript: ${enabled ? "on" : "off"}`, "info");
}

function parseBoolean(value: string | undefined): boolean | undefined {
	if (!value) return undefined;
	const normalized = value.trim().toLowerCase();
	if (["on", "true", "yes", "1", "enabled"].includes(normalized)) return true;
	if (["off", "false", "no", "0", "disabled"].includes(normalized)) return false;
	return undefined;
}

function registerCommand(pi: ExtensionAPI) {
	pi.registerCommand("compact-transcript", {
		description: "Toggle compact transcript rendering (on/off).",
		getArgumentCompletions(prefix: string) {
			return ["on", "off", "status"]
				.filter((value) => value.startsWith(prefix.trimStart()))
				.map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			captureTheme(ctx);
			const trimmed = args.trim().toLowerCase();
			if (trimmed === "status") {
				ctx.ui.notify(`Compact transcript: ${isEnabled() ? "on" : "off"}`, "info");
				return;
			}
			if (!trimmed) {
				setEnabled(!isEnabled(), pi, ctx);
				return;
			}
			// on/off, plus pre-0.5 mode names as legacy aliases.
			const legacyOn = ["balanced", "aggressive", "debug"].includes(trimmed);
			const parsed = legacyOn ? true : parseBoolean(trimmed);
			if (parsed !== undefined) {
				setEnabled(parsed, pi, ctx);
				return;
			}
			ctx.ui.notify(`Unknown option "${trimmed}". Usage: /compact-transcript [on|off|status]`, "error");
		},
	});
}

export default function compactTranscript(pi: ExtensionAPI) {
	patchRenderers();
	registerCommand(pi);

	pi.registerEntryRenderer<SummaryData>(SUMMARY_ENTRY_TYPE, (entry, _options, theme) => {
		const line = summaryLine(normalizeSummary(entry.data));
		if (!line) return undefined;
		if (state.config.summaryStyle === "quote") {
			return new Markdown(`> ${line}`, 0, 0, getMarkdownTheme());
		}
		return new Text(theme.fg("muted", line), 0, 0);
	});

	pi.on("session_start", async (event, ctx) => {
		restoreConfigFromBranch(ctx);
		captureTheme(ctx);
		// Drop all per-tool state and component registries from the previous
		// session; stale burst counts otherwise corrupt the rebuilt transcript
		// after resume or /reload.
		resetToolRun();
		state.runStats = newRunStats();
		state.toolComponents = new Set();
		state.assistantComponents = new Set();
		state.componentToolInfos = new WeakMap();
		state.inlineInspections = new WeakMap();
		state.inlineOwners = new WeakMap();
		ctx.ui.setWorkingMessage();
		// Clear any footer status left behind by pre-0.4 versions of this extension.
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (event.reason === "startup") {
			checkAndNotifyRecommendedSettings(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		stopBlinkTimer();
		ctx.ui.setStatus(STATUS_KEY, undefined);
		ctx.ui.setWorkingMessage();
	});

	pi.on("agent_start", (_event, ctx) => {
		state.agentActive = true;
		captureTheme(ctx);
		resetToolRun();
		state.runStats = newRunStats();
	});

	pi.on("agent_end", (_event, _ctx) => {
		state.agentActive = false;
		state.currentBurst = [];
		clearCurrentThought();
		state.runningToolIds.clear();
		stopBlinkTimer();
		appendRunSummary(pi);
	});

	pi.on("turn_start", (_event, ctx) => {
		captureTheme(ctx);
	});

	pi.on("message_update", (event, ctx) => {
		captureTheme(ctx);
		const type = event.assistantMessageEvent?.type;
		if (typeof type === "string" && type.startsWith("thinking_")) {
			updateCurrentThoughtFromMessage(event.message);
		}
		if (textSignalHasVisibleContent(event.assistantMessageEvent)) {
			const messageHasToolCall = Array.isArray(event.message?.content) && event.message.content.some((content: any) => content.type === "toolCall");
			if (!messageHasToolCall && state.runningToolIds.size === 0) clearCurrentThought();
			// Visible assistant text ends the current tool burst. Do not split on
			// text_start alone: some providers create empty text blocks before a
			// tool-only turn, and those blocks are hidden from the transcript.
			state.currentBurst = [];
		}
	});

	pi.on("tool_execution_start", (event, ctx) => {
		captureTheme(ctx);
		beginTool(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.partialResult, false, true);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		captureTheme(ctx);
		updateToolResult(event.toolCallId, event.result, event.isError, false);
	});
}

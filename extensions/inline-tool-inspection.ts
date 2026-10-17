import { Container, MouseRegion, stripTerminalSequences, type Component, type TuiMouseEvent as MouseEvent } from "@earendil-works/pi-tui";

export type InlineToolEntry = {
	summary: Component;
	details: Component;
	isExpanded(): boolean;
	expand(): boolean;
};

/** Project a native tool below its compact header without moving the header down by its stock leading spacer. */
function entryComponent(entry: InlineToolEntry, indent: number): Component {
	let leadingRows = 0;
	let inset = 0;
	return {
		render(width) {
			inset = Math.min(indent, Math.max(0, width));
			const lines = (entry.isExpanded() ? entry.details : entry.summary).render(Math.max(0, width - inset));
			leadingRows = 0;
			if (entry.isExpanded()) {
				while (leadingRows < lines.length && !stripTerminalSequences(lines[leadingRows]).trim()) leadingRows++;
			}
			return lines.slice(leadingRows).map(line => " ".repeat(inset) + line);
		},
		handleMouse(event: MouseEvent) {
			if (event.x < inset || event.width <= inset) return undefined;
			if (!entry.isExpanded()) {
				if (event.type !== "click" || event.button !== "left") return undefined;
				if (!entry.expand()) return undefined;
				return { handled: true };
			}
			return entry.details.handleMouse?.({ ...event, x: event.x - inset, y: event.y + leadingRows, width: event.width - inset, height: event.height + leadingRows });
		},
		invalidate() {
			entry.summary.invalidate?.();
			entry.details.invalidate?.();
		},
	};
}

/** Entries stay below the original group header; no earlier transcript components are unhidden/reparented. */
export function createInlineToolInspection(entries: InlineToolEntry[], header?: { component: Component; close(): void }): Component {
	const container = new Container();
	if (header) {
		container.addChild(new MouseRegion(header.component, event => {
			if (event.type !== "click" || event.button !== "left") return undefined;
			header.close();
			return { handled: true };
		}));
	}
	for (const entry of entries) container.addChild(entryComponent(entry, header ? 2 : 0));
	return container;
}

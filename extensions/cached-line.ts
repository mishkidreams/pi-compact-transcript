import type { Component } from "@earendil-works/pi-tui";

/** A fixed single line. Its formatter may depend only on the supplied width. */
export function cachedLine(format: (width: number) => string): Component {
	let cachedWidth: number | undefined;
	let cachedText = "";
	return {
		render(width) {
			const safeWidth = Math.max(0, width);
			if (safeWidth !== cachedWidth) {
				cachedText = format(safeWidth);
				cachedWidth = safeWidth;
			}
			// Native parents may decorate their returned array; never expose the cache.
			return [cachedText];
		},
		invalidate() { cachedWidth = undefined; },
	};
}

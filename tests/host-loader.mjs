import { createRequire, registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.PI_ROOT;
if (!root || !existsSync(resolve(root, 'dist/index.js'))) {
	throw new Error('Set PI_ROOT to the installed Pi directory; tests use the host without installing another Pi.');
}
const require = createRequire(resolve(root, 'package.json'));
const aliases = new Map([
	['@earendil-works/pi-coding-agent', pathToFileURL(resolve(root, 'dist/index.js')).href],
	['@earendil-works/pi-tui', pathToFileURL(require.resolve('@earendil-works/pi-tui')).href],
]);
registerHooks({
	resolve(specifier, context, nextResolve) {
		return nextResolve(aliases.get(specifier) ?? specifier, context);
	},
});

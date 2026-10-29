// The tracker's own file on this computer: the state as JSON, written atomically (a temporary file,
// flushed to disk, then renamed over the old one) so a crash or power cut never leaves half a file.
// The device token is kept apart, encrypted by the operating system (main process).

import fs from 'node:fs';
import path from 'node:path';

export function createStore(dir, name = 'tracker.json') {
	const file = path.join(dir, name);
	const tmp = file + '.tmp';

	function load(fallback) {
		for (const f of [file, tmp]) {
			try {
				return JSON.parse(fs.readFileSync(f, 'utf8'));
			} catch (e) {
				// Missing or unreadable: try the next one.
			}
		}
		return fallback;
	}

	function save(state) {
		fs.mkdirSync(dir, { recursive: true });
		const fd = fs.openSync(tmp, 'w');
		try {
			fs.writeSync(fd, JSON.stringify(state));
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, file);
	}

	function clear() {
		for (const f of [file, tmp]) {
			try {
				fs.unlinkSync(f);
			} catch (e) {
				// Already gone.
			}
		}
	}

	return { file, load, save, clear };
}

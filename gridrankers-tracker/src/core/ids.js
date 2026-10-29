// ULIDs made on the computer (SPEC.md 6.21): an entry keeps the same id from the moment it starts, so
// a retried upload is never saved twice. 26 Crockford base-32 characters, time-ordered.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(nowMs = Date.now(), random = defaultRandom) {
	let time = '';
	let t = Math.floor(nowMs);
	for (let i = 0; i < 10; i++) {
		time = ALPHABET[t % 32] + time;
		t = Math.floor(t / 32);
	}
	let rand = '';
	const bytes = random(16);
	for (let i = 0; i < 16; i++) rand += ALPHABET[bytes[i] % 32];
	return time + rand;
}

function defaultRandom(n) {
	const out = new Uint8Array(n);
	globalThis.crypto.getRandomValues(out);
	return out;
}

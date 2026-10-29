// The portal's REST API for the tracker (SPEC.md 6.21, section 8): sign in with the employee code for a
// device token, then `Authorization: Bearer` on /auth/*, /timer/* and /time-entries*. No cookies, no nonce.

export class ApiError extends Error {
	constructor(status, code, message) {
		super(message || 'Something went wrong. Try again.');
		this.status = status;
		this.code = code;
	}
	// No answer at all: the computer is offline or the portal can't be reached.
	get offline() {
		return this.status === 0;
	}
	// The token no longer works (signed out, revoked, a new code was set): sign in again.
	get signedOut() {
		return this.status === 401;
	}
}

// Where the team's portal (and their sign-in codes) live.
export const DEFAULT_SERVER = 'https://bot.gridrankers.com';

// A clean portal address: https:// added when missing, no trailing slash.
export function cleanServer(value) {
	let s = String(value || '').trim();
	if (!s) return DEFAULT_SERVER;
	if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
	return s.replace(/\/+$/, '');
}

export function createClient({ server, getToken, fetchImpl, timeoutMs = 20000 }) {
	// `?rest_route=` works on every WordPress site, with or without pretty permalinks.
	const base = cleanServer(server) + '/';
	const doFetch = fetchImpl || globalThis.fetch;

	async function request(method, path, { body, query, auth = true } = {}) {
		const url = new URL(base);
		url.searchParams.set('rest_route', '/gr-portal/v1/' + path.replace(/^\//, ''));
		Object.entries(query || {}).forEach(([k, v]) => v !== undefined && v !== null && url.searchParams.set(k, v));
		const headers = { Accept: 'application/json' };
		if (body !== undefined) headers['Content-Type'] = 'application/json';
		const token = auth && getToken ? getToken() : null;
		if (token) headers.Authorization = 'Bearer ' + token;

		const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
		const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
		let res;
		try {
			res = await doFetch(url.toString(), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: ctrl ? ctrl.signal : undefined, cache: 'no-store' });
		} catch (e) {
			throw new ApiError(0, 'offline', 'Can’t reach the portal. Your time is saved on this computer.');
		} finally {
			if (timer) clearTimeout(timer);
		}
		let data = null;
		const text = await res.text();
		try {
			data = text ? JSON.parse(text) : null;
		} catch (e) {
			data = null;
		}
		if (!res.ok) {
			// Not a portal with the tracker: a wrong address, or the portal hasn't updated itself yet.
			if (res.status === 404 && (!data || data.code === 'rest_no_route' || data.code === 'rest_invalid_handler')) {
				throw new ApiError(404, 'grp_no_tracker', 'This portal doesn’t have the time tracker yet (or the address is wrong). Check the portal address, or try again after the portal updates.');
			}
			throw new ApiError(res.status, data && data.code, data && data.message);
		}
		if (data === null && text) {
			throw new ApiError(res.status, 'grp_not_portal', 'That address isn’t a GridRankers portal. Check the portal address.');
		}
		return data;
	}

	return {
		// POST /auth/device: the employee code → token, device, member, work_day, schedule, tasks, timer.
		signIn: (code, device) => request('POST', 'auth/device', { body: { code, ...device }, auth: false }),
		signOut: () => request('DELETE', 'auth/device'),
		me: () => request('GET', 'auth/me'),
		timer: () => request('GET', 'timer'),
		schedule: (days = 14) => request('GET', 'timer/schedule', { query: { days } }),
		tasks: () => request('GET', 'timer/tasks'),
		// POST /time-entries/batch: an answer per entry (saved / exists / refused).
		batch: (entries, clockOffset = 0) => request('POST', 'time-entries/batch', { body: { entries, clock_offset: clockOffset } }),
	};
}

// Small fetch wrapper for the gr-portal/v1 REST API: JSON in/out, WordPress nonce,
// same-origin cookies. Errors carry the server's status, code and message.

export class ApiError extends Error {
	constructor(status, code, message, data) {
		super(message || 'Something went wrong. Try again.');
		this.status = status;
		this.code = code;
		this.data = data;
	}
}

export function createApi({ root, nonce, onUnauthorized, fetchImpl }) {
	const doFetch = fetchImpl || ((...args) => window.fetch(...args));
	const base = root.endsWith('/') ? root : root + '/';

	async function request(method, path, { body, query } = {}) {
		const url = new URL(base + path.replace(/^\//, ''), window.location.origin);
		Object.entries(query || {}).forEach(([k, v]) => {
			if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
		});

		let res;
		try {
			res = await doFetch(url.toString(), {
				method,
				credentials: 'same-origin',
				cache: 'no-store',
				headers: {
					'X-WP-Nonce': nonce,
					Accept: 'application/json',
					...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (e) {
			throw new ApiError(0, 'network', "Can't reach the server. Check your connection.");
		}

		let data = null;
		const text = await res.text();
		if (text) {
			try {
				data = JSON.parse(text);
			} catch (e) {
				data = null;
			}
		}

		if (!res.ok) {
			if (res.status === 401 && onUnauthorized) onUnauthorized();
			throw new ApiError(res.status, data && data.code, data && data.message, data && data.data);
		}
		return data;
	}

	return {
		get: (path, query) => request('GET', path, { query }),
		post: (path, body) => request('POST', path, { body: body || {} }),
		patch: (path, body) => request('PATCH', path, { body: body || {} }),
		del: (path) => request('DELETE', path),
	};
}

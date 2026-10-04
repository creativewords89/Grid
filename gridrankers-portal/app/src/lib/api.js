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

	// Multipart upload of one file (SPEC.md 6.6): resolves to `{id, mime, name, size}`.
	async function upload(path, file) {
		const form = new FormData();
		form.append('file', file, file.name);
		let res;
		try {
			res = await doFetch(new URL(base + path.replace(/^\//, ''), window.location.origin).toString(), {
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'X-WP-Nonce': nonce, Accept: 'application/json' },
				body: form,
			});
		} catch (e) {
			throw new ApiError(0, 'network', "Can't reach the server. Check your connection.");
		}
		const data = await res.json().catch(() => null);
		if (!res.ok) {
			if (res.status === 401 && onUnauthorized) onUnauthorized();
			if (res.status === 413) throw new ApiError(413, 'grp_file', 'That file is too large for the server.');
			throw new ApiError(res.status, data && data.code, data && data.message, data && data.data);
		}
		return data;
	}

	// A stored file as a Blob (the portal's sign-in rides on headers, so links can't open it directly).
	async function blob(path, query) {
		const url = new URL(base + path.replace(/^\//, ''), window.location.origin);
		Object.entries(query || {}).forEach(([k, v]) => url.searchParams.set(k, v));
		let res;
		try {
			res = await doFetch(url.toString(), {
				credentials: 'same-origin',
				cache: 'no-store',
				headers: { 'X-WP-Nonce': nonce },
			});
		} catch (e) {
			throw new ApiError(0, 'network', "Can't reach the server. Check your connection.");
		}
		if (!res.ok) {
			const data = await res.json().catch(() => null);
			throw new ApiError(res.status, data && data.code, (data && data.message) || 'That file is no longer available.');
		}
		return res.blob();
	}

	return {
		upload,
		blob,
		get: (path, query) => request('GET', path, { query }),
		post: (path, body) => request('POST', path, { body: body || {} }),
		patch: (path, body) => request('PATCH', path, { body: body || {} }),
		put: (path, body) => request('PUT', path, { body: body || {} }),
		del: (path) => request('DELETE', path),
	};
}

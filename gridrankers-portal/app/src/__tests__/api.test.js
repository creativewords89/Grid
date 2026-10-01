import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from '../lib/api.js';

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, text: () => Promise.resolve(body === undefined ? '' : JSON.stringify(body)) });

describe('createApi', () => {
	it('sends the nonce, JSON body and query', async () => {
		const fetchImpl = vi.fn(() => reply(200, { ok: 1 }));
		const api = createApi({ root: 'https://x.test/wp-json/gr-portal/v1/', nonce: 'n1', fetchImpl });

		await api.post('auth/login', { code: 'ABC' });
		await api.get('sync', { since: '2026-10-01 00:00:00', page: 0, empty: '' });

		const [url, opts] = fetchImpl.mock.calls[0];
		expect(url).toBe('https://x.test/wp-json/gr-portal/v1/auth/login');
		expect(opts.headers['X-WP-Nonce']).toBe('n1');
		expect(opts.credentials).toBe('same-origin');
		expect(JSON.parse(opts.body)).toEqual({ code: 'ABC' });
		expect(fetchImpl.mock.calls[1][0]).toBe('https://x.test/wp-json/gr-portal/v1/sync?since=2026-10-01+00%3A00%3A00&page=0');
	});

	it('throws server errors and reports 401', async () => {
		const onUnauthorized = vi.fn();
		const api = createApi({ root: '/r/', nonce: '', onUnauthorized, fetchImpl: () => reply(401, { code: 'grp_unauthorized', message: 'Sign in to continue.' }) });

		await expect(api.get('projects')).rejects.toMatchObject({ status: 401, code: 'grp_unauthorized', message: 'Sign in to continue.' });
		expect(onUnauthorized).toHaveBeenCalledTimes(1);
	});

	it('turns network failures into a readable error', async () => {
		const api = createApi({ root: '/r/', nonce: '', fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
		const err = await api.get('projects').catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.code).toBe('network');
	});
});

// Client requests (SPEC.md 6.15, designs DP-B and DP-G): what the team needs from a client, each
// with a status and a thread. Same rules as GRP_REST_Client_Requests; the server checks again.
import { daysBetween } from './cycles.js';
import { rowsOf } from './store.js';

export const KINDS = [
	['images', 'Images'],
	['info', 'Info'],
	['page', 'Page'],
	['access', 'Access'],
	['other', 'Other'],
];
export const KIND_LABEL = Object.fromEntries(KINDS);

export const STATUSES = [
	['needed', 'Needed'],
	['asked', 'Asked client'],
	['received', 'Received'],
	['done', 'Done'],
];
export const STATUS_LABEL = Object.fromEntries(STATUSES);

export const VIAS = [
	['email', 'email'],
	['whatsapp', 'WhatsApp'],
	['phone', 'phone'],
	['meeting', 'meeting'],
	['other', 'other'],
];
export const VIA_LABEL = Object.fromEntries(VIAS);

// Days after "Asked client" before the asker and the Team Leaders are reminded to chase.
export const CHASE_DAYS = 3;
const DAY = 24 * 60 * 60 * 1000;

const time = (iso) => (iso ? Date.parse(String(iso).replace(' ', 'T') + (String(iso).length === 19 ? 'Z' : '')) : 0);
const plural = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

export const isOpenRequest = (r) => r.status !== 'done';

// A request's thread, oldest first.
export const threadOf = (data, id) =>
	rowsOf(data, 'request_messages')
		.filter((m) => m.request_id === id)
		.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || String(a.id).localeCompare(String(b.id)));

// The project's requests with what the table shows: files, messages and the last change. Open
// ones first (Needed, Asked, Received), then by the last change, newest first.
export function requestsOf(data, projectId) {
	const order = { needed: 0, asked: 1, received: 2, done: 3 };
	return rowsOf(data, 'client_requests')
		.filter((r) => r.project_id === projectId)
		.map((r) => {
			const thread = threadOf(data, r.id);
			const said = thread.filter((m) => !m.event && !m.deleted_at);
			const last = [r.updated_at, ...thread.map((m) => m.created_at)].sort().pop();
			return { ...r, thread, files: said.reduce((n, m) => n + (m.files || []).length, 0), messages: said.length, last };
		})
		.sort((a, b) => (isOpenRequest(a) === isOpenRequest(b) ? 0 : isOpenRequest(a) ? -1 : 1) || String(b.last).localeCompare(String(a.last)) || order[a.status] - order[b.status]);
}

export const openCount = (data, projectId) => rowsOf(data, 'client_requests').filter((r) => r.project_id === projectId && isOpenRequest(r)).length;

// "Today", "Yesterday", "4 days ago", or the date.
export function whenText(iso, today) {
	const d = String(iso || '').slice(0, 10);
	if (!d) return '';
	const n = daysBetween(d, today);
	if (n <= 0) return 'Today';
	if (n === 1) return 'Yesterday';
	if (n < 7) return `${n} days ago`;
	return new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

// Same as GRP_Permissions::DELETE_CLIENT_REQUEST: whoever added it, or the Super Admin.
export const canDeleteRequest = (me, r) => !!me && !!r && (me.role === 'admin' || r.created_by === me.id);

// The one line under Overview: "3 open client requests · Privacy Policy page asked 4 days ago · 1 received to check".
export function openSummary(data, projectId, today) {
	const open = requestsOf(data, projectId).filter(isOpenRequest);
	if (!open.length) return null;
	const asked = open.filter((r) => r.status === 'asked').sort((a, b) => String(a.asked_at).localeCompare(String(b.asked_at)))[0];
	const received = open.filter((r) => r.status === 'received').length;
	const parts = [];
	if (asked) parts.push(`${asked.title} asked ${whenText(asked.asked_at, today).toLowerCase()}`);
	if (received) parts.push(`${received} received to check`);
	return { count: open.length, text: parts.join(' · ') };
}

// Daily reminder (SPEC.md 6.15): a request still on "Asked client" CHASE_DAYS after it was asked,
// for the person who asked and the Team Leaders, until its status changes. Shown with the other
// "until it's done" reminders (Notifications box and bell).
export function chaseReminders(data, me, today) {
	if (!me) return [];
	return rowsOf(data, 'client_requests')
		.filter((r) => r.status === 'asked' && r.asked_at && data.projects[r.project_id] && (r.asked_by === me.id || me.role === 'lead'))
		.map((r) => ({ r, days: daysBetween(String(r.asked_at).slice(0, 10), today) }))
		.filter(({ days }) => days >= CHASE_DAYS)
		.sort((a, b) => b.days - a.days)
		.map(({ r, days }) => ({
			key: `chase:${r.id}:${today}`,
			kind: 'chase',
			tone: 'amber',
			title: `${data.projects[r.project_id].name}: chase the client — “${r.title}” asked ${plural(days, 'day')} ago`,
			ok: 'Open request',
			project: data.projects[r.project_id],
			request: r.id,
		}));
}

// Notifications (bell and box) for the last 7 days: new messages and files in a thread, and a
// request marked done, for the person who added it and everyone who has written in it — never
// for your own.
export function requestBell(data, me, now = Date.now()) {
	if (!me) return [];
	const out = [];
	rowsOf(data, 'client_requests').forEach((r) => {
		const project = data.projects[r.project_id];
		if (!project) return;
		const thread = threadOf(data, r.id);
		const inIt = r.created_by === me.id || thread.some((m) => !m.event && m.created_by === me.id);
		if (!inIt) return;
		thread.forEach((m) => {
			if (m.created_by === me.id || m.deleted_at || now - time(m.created_at) > 7 * DAY) return;
			if (m.event && m.event !== 'done') return;
			const who = data.members[m.created_by];
			const name = who ? who.name : 'Someone';
			const files = (m.files || []).length;
			const text = m.event ? `${name} marked “${r.title}” done` : m.from_client ? `${project.name}: the client sent “${r.title}”` : `${name} wrote on “${r.title}”`;
			out.push({
				key: `rq:${m.id}`,
				text,
				sub: m.body || (files ? `📎 ${plural(files, 'file')}` : ''),
				at: m.created_at,
				project_id: r.project_id,
				request: r.id,
				fromClient: !!m.from_client,
			});
		});
	});
	return out;
}

// Opening a request from a notification or a reminder: Details shows it on its next render.
let pending = '';
export function openRequest(id) {
	pending = id;
	window.dispatchEvent(new CustomEvent('grp:open-request', { detail: id }));
}
export function takePendingRequest() {
	const id = pending;
	pending = '';
	return id;
}

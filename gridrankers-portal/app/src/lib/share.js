// Share a task (SPEC.md 7.7, design SHR-1B): ↗ on a task card copies a link to it; opening the
// link (after sign-in) goes to the task's board with the card found and highlighted.
import { boardOf } from './tasks.js';

export const SHARE_PARAM = 'task';

// The portal's address with `?task={id}`.
export const taskLink = (id, loc = window.location) => `${loc.origin}${loc.pathname}?${SHARE_PARAM}=${encodeURIComponent(id)}`;

// The task id a shared link asks for, or ''.
export const sharedId = (search) => new URLSearchParams(search || '').get(SHARE_PARAM) || '';

// Where a shared task lives: its project and board (Meeting Minutes, General tasks or Monthly
// Tasks), or null when it no longer exists.
export function sharedTarget(data, id) {
	const meeting = (data.meeting_tasks || {})[id];
	if (meeting && !meeting.deleted_at) return { task: meeting, project_id: meeting.project_id, tab: boardOf(meeting) };
	const monthly = (data.monthly_tasks || {})[id];
	if (monthly && !monthly.deleted_at) return { task: monthly, project_id: monthly.project_id, tab: 'monthly' };
	return null;
}

// Copies text to the clipboard (the older way when the Clipboard API isn't there).
export async function copyText(text) {
	if (navigator.clipboard && window.isSecureContext) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const area = document.createElement('textarea');
	area.value = text;
	area.setAttribute('readonly', '');
	area.style.position = 'fixed';
	area.style.opacity = '0';
	document.body.appendChild(area);
	area.select();
	document.execCommand('copy');
	area.remove();
}

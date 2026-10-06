// The Super Admin's invoice tracker (SPEC.md 6.14): one row per project per cycle (the current one
// and the ended ones), a payment tag on each, and daily reminders. A record for the Super Admin, not a way to send invoices.

import { rowsOf } from './store.js';
import { daysBetween } from './cycles.js';
import { short } from './format.js';

export const REMIND_DAYS = 3;
export const CURRENCY = '$';
export const METHODS = ['Bank', 'bKash', 'PayPal', 'Wise', 'Cash'];

// Tag order is the filter-chip order.
export const TAGS = [
	{ id: 'to_send', label: 'To send' },
	{ id: 'waiting', label: 'Waiting' },
	{ id: 'partly', label: 'Partly paid' },
	{ id: 'overdue', label: 'Overdue' },
	{ id: 'paid', label: 'Paid' },
	{ id: 'skipped', label: 'Not billed' },
	{ id: 'current', label: 'This cycle' },
];
export const TAG_LABEL = Object.fromEntries(TAGS.map((t) => [t.id, t.label]));

const round = (n) => Math.round(n * 100) / 100;
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export const paidOf = (row) => round((row.payments || []).reduce((s, p) => s + (+p.amount || 0), 0));

export const remindDaysOf = (data, projectId) => {
	const fee = (data.billing_fees || {})[projectId];
	return fee && +fee.remind_days > 0 ? +fee.remind_days : REMIND_DAYS;
};

// Days since the invoice was sent (0 when not sent).
export const daysSinceSent = (row, today) => (row.sent_at ? Math.max(0, daysBetween(row.sent_at, today)) : 0);

// Same rules as GRP_Billing::status(). Without an amount, any payment settles it.
export function statusOf(row, remindDays, today) {
	const paid = paidOf(row);
	const amount = row.amount == null ? 0 : +row.amount;
	if (+row.skipped) return 'skipped';
	if (paid > 0 && (amount <= 0 || paid >= amount)) return 'paid';
	// Not sent: still running → This cycle (bill early if you like, no reminder); ended → To send.
	if (!row.sent_at) return String(row.cycle_end || '') >= today ? 'current' : 'to_send';
	if (paid > 0) return 'partly';
	return daysSinceSent(row, today) >= remindDays ? 'overdue' : 'waiting';
}

// "$1,250" / "৳45,000" / "—" when there is no amount.
export function money(amount, currency = CURRENCY) {
	if (amount == null || amount === '') return '—';
	const n = +amount;
	const text = n.toLocaleString('en-US', { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 });
	return (currency || CURRENCY) + text;
}

// Sums per currency: [{currency, amount}] → "$1,100 + ৳45,000".
export function sums(list) {
	const by = {};
	list.forEach(({ currency, amount }) => {
		const c = currency || CURRENCY;
		by[c] = round((by[c] || 0) + (+amount || 0));
	});
	return Object.entries(by)
		.filter(([, a]) => a > 0)
		.map(([c, a]) => money(a, c))
		.join(' + ');
}

export const cycleLabel = (row) => `${short(row.cycle_start)} – ${short(row.cycle_end)}`;

// Every billing row with its project name (live, or as it was when the row was made), tag and sums.
export function billingRows(data, today) {
	return rowsOf(data, 'billing')
		.map((row) => {
			const project = data.projects[row.project_id];
			const remind = remindDaysOf(data, row.project_id);
			const paid = paidOf(row);
			const status = statusOf(row, remind, today);
			const amount = row.amount == null ? null : +row.amount;
			const left = status === 'paid' || status === 'skipped' || status === 'current' || amount == null ? 0 : round(Math.max(0, amount - paid));
			return { ...row, name: project ? project.name : row.project_name, project, status, paid, left, remind, days: daysSinceSent(row, today) };
		})
		.sort((a, b) => a.name.localeCompare(b.name) || String(a.cycle_end).localeCompare(String(b.cycle_end)));
}

// Short tag text for a row: "Overdue · 12 days", "Partly paid · $400 left", "Waiting · sent Oct 1".
export function tagText(r) {
	if (r.status === 'overdue') return `Overdue · ${plural(r.days, 'day')}`;
	if (r.status === 'partly') return r.left > 0 ? `Partly paid · ${money(r.left, r.currency)} left` : 'Partly paid';
	if (r.status === 'waiting') return `Waiting · sent ${short(r.sent_at)}`;
	if (r.status === 'current') return `This cycle · ends ${short(r.cycle_end)}`;
	return TAG_LABEL[r.status];
}

// Something still to do on a row: send it, or wait for its money.
export const isOpen = (r) => r.status === 'to_send' || r.status === 'waiting' || r.status === 'partly' || r.status === 'overdue';

// TR-A: one line per project — its oldest cycle that still needs something (send or get paid),
// or else its latest cycle (usually This cycle) — plus how many more of its cycles are open.
export function latestByProject(rows) {
	const by = {};
	rows.forEach((r) => (by[r.project_id] = by[r.project_id] || []).push(r));
	return Object.values(by)
		.map((list) => {
			const open = list.filter(isOpen);
			const focus = open[0] || list[list.length - 1];
			return { ...focus, older: open.filter((r) => r.id !== focus.id) };
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

// The four tiles on top of the Invoices screen.
export function totals(rows, today) {
	const month = today.slice(0, 7);
	const toSend = rows.filter((r) => r.status === 'to_send');
	const waiting = rows.filter((r) => r.status === 'waiting' || r.status === 'partly');
	const overdue = rows.filter((r) => r.status === 'overdue').sort((a, b) => b.days - a.days);
	const received = [];
	rows.forEach((r) => (r.payments || []).forEach((p) => String(p.date).slice(0, 7) === month && received.push({ currency: r.currency, amount: p.amount })));
	return {
		toSend,
		waiting,
		waitingSum: sums(waiting.map((r) => ({ currency: r.currency, amount: r.status === 'partly' ? r.left : r.amount }))),
		overdue,
		received: sums(received),
		payments: received.length,
	};
}

// What is still owed on a project's cycles (not paid, not "Not billed").
export const owedOf = (rows) => sums(rows.filter((r) => r.left > 0).map((r) => ({ currency: r.currency, amount: r.left })));

// TR-B: the six months ending `off` half-years from this month, `YYYY-MM`.
export function yearMonths(today, off = 0) {
	const [y, m] = today.split('-').map(Number);
	const out = [];
	for (let i = 5; i >= 0; i--) {
		const d = new Date(Date.UTC(y, m - 1 - i + off * 6, 1));
		out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
	}
	return out;
}

// Daily reminders for the Super Admin (SPEC.md 6.14), shown with the cycle setup reminders until
// the work is done: an invoice not sent yet, and a payment not received `remind` days after it.
export function billingReminders(data, me, today) {
	if (!me || me.role !== 'admin') return [];
	const out = [];
	billingRows(data, today).forEach((r) => {
		const base = { kind: 'invoice', ok: 'Open invoices', row: r.id };
		if (r.status === 'to_send') {
			out.push({ ...base, key: `invoice:send:${r.id}:${today}`, tone: 'amber', title: `${r.name}: send the invoice for ${cycleLabel(r)}` });
		} else if (r.status === 'overdue') {
			out.push({ ...base, key: `invoice:paid:${r.id}:${today}`, tone: 'red', title: `${r.name}: payment not received — ${plural(r.days, 'day')} since the invoice` });
		} else if (r.status === 'partly' && r.days >= r.remind) {
			out.push({ ...base, key: `invoice:paid:${r.id}:${today}`, tone: 'red', title: `${r.name}: ${money(r.left, r.currency)} still to come — ${plural(r.days, 'day')} since the invoice` });
		}
	});
	return out;
}

// CSV of every row, for the Super Admin's own records. Cells that a spreadsheet would run as a
// formula are quoted with a leading apostrophe.
export function billingCsv(rows) {
	const cell = (v) => {
		let s = v == null ? '' : String(v);
		if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
		return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const head = ['Project', 'Cycle start', 'Cycle end', 'Amount', 'Currency', 'Status', 'Invoice sent', 'Invoice ref', 'Paid', 'Left', 'Payments', 'Note'];
	const lines = rows.map((r) =>
		[
			r.name,
			r.cycle_start,
			r.cycle_end,
			r.amount == null ? '' : r.amount,
			r.currency,
			TAG_LABEL[r.status],
			r.sent_at || '',
			r.ref || '',
			r.paid,
			r.left,
			(r.payments || []).map((p) => [p.date, p.amount, p.method, p.ref].filter(Boolean).join(' ')).join('; '),
			r.note || '',
		]
			.map(cell)
			.join(','),
	);
	return [head.join(','), ...lines].join('\r\n') + '\r\n';
}

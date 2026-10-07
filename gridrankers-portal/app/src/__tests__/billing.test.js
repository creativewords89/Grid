// The Super Admin's invoice tracker (SPEC.md 6.14, designs TR-A and TR-B).
import { describe, expect, it } from 'vitest';
import { billingCsv, billingReminders, billingRows, latestByProject, money, owedOf, statusOf, sums, tagText, totals, yearMonths } from '../lib/billing.js';
import { bellItems } from '../lib/feed.js';
import { emptyData } from '../lib/store.js';

const TODAY = '2026-10-10';
const ADMIN = { id: 'ada', name: 'Ada', role: 'admin', active: 1 };
const LEAD = { id: 'lee', name: 'Lee', role: 'lead', active: 1 };

const bill = (id, project, end, extra = {}) => ({ id, project_id: project, project_name: 'Old name', cycle_key: end.slice(0, 7), cycle_start: end.slice(0, 8) + '01', cycle_end: end, amount: 500, currency: '$', sent_at: null, skipped: 0, payments: [], ...extra });

function data() {
	const d = emptyData();
	d.members = { ada: ADMIN, lee: LEAD };
	d.projects = {
		a: { id: 'a', name: 'Acme', state: 'active' },
		b: { id: 'b', name: 'Bright', state: 'active' },
	};
	d.billing = {
		a1: bill('a1', 'a', '2026-08-31', { sent_at: '2026-09-01', payments: [{ id: 'x', amount: 500, date: '2026-09-05' }] }),
		a2: bill('a2', 'a', '2026-09-30'),
		b1: bill('b1', 'b', '2026-08-31', { sent_at: '2026-09-01', payments: [{ id: 'y', amount: 200, date: '2026-10-02' }] }),
		b2: bill('b2', 'b', '2026-09-30', { sent_at: '2026-10-01', currency: '৳', amount: 45000 }),
		gone: bill('gone', 'z', '2026-09-30', { skipped: 1 }),
	};
	d.billing_fees = { b: { id: 'b', fee: 45000, currency: '৳', remind_days: 10 } };
	return d;
}

describe('payment tags', () => {
	const row = { amount: 500, sent_at: null, skipped: 0, payments: [] };
	it('follows the server rules, with a 3-day payment reminder by default', () => {
		expect(statusOf(row, 3, TODAY)).toBe('to_send');
		expect(statusOf({ ...row, cycle_end: '2026-10-31' }, 3, TODAY)).toBe('current');
		expect(statusOf({ ...row, cycle_end: '2026-10-10' }, 3, TODAY)).toBe('current');
		expect(statusOf({ ...row, cycle_end: '2026-10-09' }, 3, TODAY)).toBe('to_send');
		expect(statusOf({ ...row, cycle_end: '2026-10-31', sent_at: '2026-10-09' }, 3, TODAY)).toBe('waiting');
		expect(statusOf({ ...row, sent_at: '2026-10-08' }, 3, TODAY)).toBe('waiting');
		expect(statusOf({ ...row, sent_at: '2026-10-07' }, 3, TODAY)).toBe('overdue');
		expect(statusOf({ ...row, sent_at: '2026-10-07' }, 10, TODAY)).toBe('waiting');
		expect(statusOf({ ...row, sent_at: '2026-09-01', payments: [{ amount: 100 }] }, 3, TODAY)).toBe('partly');
		expect(statusOf({ ...row, payments: [{ amount: 250 }, { amount: '250' }] }, 3, TODAY)).toBe('paid');
		expect(statusOf({ ...row, amount: null, payments: [{ amount: 1 }] }, 3, TODAY)).toBe('paid');
		expect(statusOf({ ...row, amount: null }, 3, TODAY)).toBe('to_send');
		expect(statusOf({ ...row, skipped: 1 }, 3, TODAY)).toBe('skipped');
	});

	it('formats money and sums per currency', () => {
		expect(money(1250.5, '$')).toBe('$1,250.50');
		expect(money(45000, '৳')).toBe('৳45,000');
		expect(money(null)).toBe('—');
		expect(sums([{ currency: '$', amount: 600 }, { currency: '৳', amount: 45000 }, { currency: '$', amount: 500 }])).toBe('$1,100 + ৳45,000');
	});
});

describe('rows, by project and year view', () => {
	it('names rows after the live project, tags them and works out what is left', () => {
		const rows = billingRows(data(), TODAY);
		const by = Object.fromEntries(rows.map((r) => [r.id, r]));
		expect(by.a1).toMatchObject({ name: 'Acme', status: 'paid', paid: 500, left: 0 });
		expect(by.a2).toMatchObject({ status: 'to_send', left: 500 });
		expect(by.b1).toMatchObject({ status: 'partly', left: 300, remind: 10 });
		expect(by.b2).toMatchObject({ status: 'waiting', days: 9 });
		expect(by.gone).toMatchObject({ name: 'Old name', status: 'skipped', left: 0 });
		expect(tagText(by.b1)).toBe('Partly paid · $300 left');
		expect(tagText({ ...by.b2, status: 'overdue' })).toBe('Overdue · 9 days');
	});

	it('shows each project’s oldest cycle that needs something, else its latest (This cycle)', () => {
		const d = data();
		d.billing.a3 = bill('a3', 'a', '2026-10-31');
		d.billing.c1 = bill('c1', 'c', '2026-10-31', { project_name: 'Coastal' });
		const rows = billingRows(d, TODAY);
		expect(rows.find((r) => r.id === 'a3')).toMatchObject({ status: 'current', left: 0 });
		expect(tagText(rows.find((r) => r.id === 'a3'))).toBe('This cycle · ends Oct 31');
		const latest = latestByProject(rows);
		expect(latest.map((r) => r.id)).toEqual(['a2', 'b1', 'c1', 'gone']);
		expect(latest[0].older).toEqual([]);
		expect(latest[1].older.map((r) => r.id)).toEqual(['b2']);
		expect(latest[2].status).toBe('current');
		// This cycle is no reminder and nothing owed yet.
		expect(billingReminders(d, ADMIN, TODAY).some((r) => r.row === 'a3' || r.row === 'c1')).toBe(false);
		expect(owedOf(rows.filter((r) => r.project_id === 'c'))).toBe('');
	});

	it('adds up the tiles and what is owed', () => {
		const rows = billingRows(data(), TODAY);
		const t = totals(rows, TODAY);
		expect(t.toSend.map((r) => r.id)).toEqual(['a2']);
		expect(t.waiting.map((r) => r.id)).toEqual(['b1', 'b2']);
		expect(t.waitingSum).toBe('$300 + ৳45,000');
		expect(t.received).toBe('$200');
		expect(t.payments).toBe(1);
		expect(owedOf(rows.filter((r) => r.project_id === 'b'))).toBe('$300 + ৳45,000');
	});

	it('steps through six months at a time', () => {
		expect(yearMonths(TODAY)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
		expect(yearMonths(TODAY, -1)).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04']);
	});

	it('exports CSV without letting a cell run as a formula', () => {
		const rows = billingRows(data(), TODAY);
		rows[0].note = '=HYPERLINK("x")';
		const csv = billingCsv(rows).split('\r\n');
		expect(csv[0]).toBe('Project,Cycle start,Cycle end,Amount,Currency,Status,Invoice sent,Invoice ref,Paid,Left,Payments,Note');
		expect(csv[1]).toBe(`Acme,2026-08-01,2026-08-31,500,$,Paid,2026-09-01,,500,0,2026-09-05 500,"'=HYPERLINK(""x"")"`);
	});
});

describe('daily reminders', () => {
	it('are for the Super Admin only, every day until done', () => {
		const d = data();
		d.billing.b2.sent_at = '2026-09-20';
		const list = billingReminders(d, ADMIN, TODAY);
		expect(list.map((r) => [r.key, r.tone, r.title])).toEqual([
			['invoice:send:a2:2026-10-10', 'amber', 'Acme: send the invoice for Sep 1 – Sep 30'],
			['invoice:paid:b1:2026-10-10', 'red', 'Bright: $300 still to come — 39 days since the invoice'],
			['invoice:paid:b2:2026-10-10', 'red', 'Bright: payment not received — 20 days since the invoice'],
		]);
		expect(billingReminders(d, LEAD, TODAY)).toEqual([]);

		// On the bell too, and opening it doesn't clear them.
		const bell = bellItems(d, ADMIN, TODAY, Date.parse('2026-10-10T12:00:00Z')).filter((i) => i.key.startsWith('invoice:'));
		expect(bell).toHaveLength(3);
		expect(bell.every((i) => i.sticky && i.unread)).toBe(true);

		// Ticking "Invoice sent" ends the first one.
		d.billing.a2.sent_at = TODAY;
		expect(billingReminders(d, ADMIN, TODAY).some((r) => r.row === 'a2')).toBe(false);
	});
});

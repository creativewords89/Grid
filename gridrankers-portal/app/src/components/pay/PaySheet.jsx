import { useCallback, useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { addMonths, dayLength, hourPay, hours, methodName, money, monthTitle, payWhere, shortDay } from '../../lib/pay.js';
import Avatar from '../Avatar.jsx';

// The pay sheet (SPEC.md 6.19, design PAY-4), the Super Admin's Salary tab: everyone with a salary,
// their hours, hourly pay, extra hours, days off and what is deducted, the total and where to pay.
// From the 1st the month before is billed (payslips) and can be marked paid.
export default function PaySheet() {
	const { api, data, toast, viewOnly } = usePortal();
	const today = new Date().toISOString().slice(0, 10);
	const [month, setMonth] = useState(null);
	const [res, setRes] = useState(null);
	const [error, setError] = useState('');
	const [query, setQuery] = useState('');

	const load = useCallback(() => {
		setRes(null);
		return api
			.get('salary/sheet', month ? { month } : undefined)
			.then(setRes)
			.catch((err) => setError(err.message));
	}, [api, month]);
	useEffect(() => {
		load();
	}, [load]);

	if (error) return <p className="err">{error}</p>;
	const shown = (res && res.month) || month || today.slice(0, 7);
	const atNow = res && shown >= res.today.slice(0, 7);
	const rows = res
		? res.rows
				.filter((r) => data.members[r.member_id])
				.filter((r) => !query.trim() || data.members[r.member_id].name.toLowerCase().includes(query.trim().toLowerCase()))
				.map((r) => ({ ...r, nums: r.slip || r.summary }))
		: [];
	const billed = rows.filter((r) => r.slip);
	const sumOf = (k) => rows.reduce((s, r) => s + (r.nums ? +r.nums[k] || 0 : 0), 0);
	const unpaid = billed.filter((r) => !r.slip.paid_at);

	const markPaid = async (ids, paid = true) => {
		try {
			await api.post('salary/paid', { month: shown, member_ids: ids, paid });
			toast(paid ? (ids.length === 1 ? 'Marked paid' : `${ids.length} salaries marked paid`) : 'Marked not paid');
			load();
		} catch (err) {
			toast(err.message);
		}
	};
	const copy = (text) => {
		if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('Account number copied'), () => toast(text));
		else toast(text);
	};
	const exportCsv = () => {
		const head = ['Name', 'Hours a day', 'Salary', '1 hour', 'Extra hours', 'Extra pay', 'Days off', 'Deducted', 'Casual day paid', 'Total', 'Paid by', 'Bank', 'Branch', 'Account name', 'Account number', 'Routing', 'Paid'];
		const lines = rows.map((r) => {
			const n = r.nums || {};
			const p = r.pay || {};
			return [data.members[r.member_id].name, n.day_minutes ? n.day_minutes / 60 : '', n.salary || '', n.salary ? Math.round(hourPay(n.salary, n.day_minutes)) : '', n.extra != null ? hours(n.extra) : '', n.extra_pay || 0, taken(r), n.deducted || 0, n.leave_pay || 0, n.total || '', p.method ? methodName(p.method) : '', p.bank_name || '', p.branch || '', p.account_name || '', p.account_number || '', p.routing || '', r.slip && r.slip.paid_at ? r.slip.paid_at : ''];
		});
		const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
		const a = document.createElement('a');
		a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
		a.download = `pay-${shown}.csv`;
		a.click();
		URL.revokeObjectURL(a.href);
	};

	return (
		<div className="pay-sheet">
			<div className="pay-bar">
				<div className="dr-dayrow">
					<button type="button" className="dr-nav" aria-label="Previous month" onClick={() => setMonth(addMonths(shown, -1))}>
						‹
					</button>
					<b className="dr-day">
						{monthTitle(shown)} · {res && res.billed ? 'billed' : 'billing'} {res ? shortDay(res.billing) : ''}
					</b>
					<button type="button" className="dr-nav" aria-label="Next month" onClick={() => setMonth(addMonths(shown, 1))} disabled={!res || atNow}>
						›
					</button>
				</div>
				<span className="pay-grow" />
				<input className="dr-in pay-search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="🔍 Search people" aria-label="Search people" />
				<button type="button" className="btn" onClick={exportCsv} disabled={!rows.length}>
					⬇ Export CSV
				</button>
			</div>
			{!res ? (
				<p className="empty">Loading…</p>
			) : (
				<>
					<div className="pay-notice" role="status">
						<span aria-hidden="true">{res.billed ? '🔔' : '🗓'}</span>
						<p>
							<b>{res.billed ? `Billing day — ${monthTitle(shown, true)} pay.` : `${monthTitle(shown, true)} so far — billed ${shortDay(res.billing)}.`}</b> {noticeLine(rows, sumOf, res.billed)}
						</p>
						{res.billed && unpaid.length > 0 && (
							<button type="button" className="btn primary" onClick={() => markPaid(unpaid.map((r) => r.member_id))} disabled={viewOnly}>
								Mark all paid
							</button>
						)}
					</div>
					<div className="pay-table" role="table" aria-label={`Pay for ${monthTitle(shown)}`}>
						<div className="pay-tr pay-th" role="row">
							{['Person', 'Salary', '1 hour', 'Extra', 'Extra pay', 'Days off', 'Deducted', 'Total', 'Pay to', ''].map((h) => (
								<span key={h} role="columnheader">
									{h}
								</span>
							))}
						</div>
						{rows.length === 0 && <p className="empty">Nobody here.</p>}
						{rows.map((r) => {
							const person = data.members[r.member_id];
							const n = r.nums;
							return (
								<div key={r.member_id} className="pay-tr" role="row" aria-label={person.name}>
									<span className="pay-who" role="cell">
										<Avatar person={person} />
										<b>{person.name}</b>
										{r.summary && r.summary.hand > 0 && (
											<small className="pay-hand" title="Both are paid">
												⏱ {hours(r.summary.tracked)} tracked · ✍ {hours(r.summary.hand)} by hand
											</small>
										)}
									</span>
									{!n ? (
										<span className="pay-unset" role="cell">
											Hasn’t set up their pay yet
										</span>
									) : (
										<>
											<span role="cell">{money(n.salary)}</span>
											<span role="cell" className="pay-hr">
												{money(hourPay(n.salary, n.day_minutes))}
												<small>{dayLength(n.day_minutes)} a day</small>
											</span>
											<b role="cell" className={n.extra ? 'pay-t-extra' : 'muted'}>
												{n.extra ? hours(n.extra) : '—'}
											</b>
											<b role="cell" className={n.extra_pay ? 'pay-t-extra' : 'muted'}>
												{n.extra_pay ? `+ ${money(n.extra_pay)}` : '—'}
											</b>
											<span role="cell" className="muted">
												{n.leave_pay ? `${taken(r) || 0} · unused paid + ${money(n.leave_pay)}` : taken(r) || '—'}
											</span>
											<b role="cell" className={n.deducted ? 'pay-t-off' : 'muted'}>
												{n.deducted ? `− ${money(n.deducted)}` : '—'}
											</b>
											<b role="cell">{money(n.total)}</b>
											<span role="cell" className="pay-to">
												{r.pay ? (
													<>
														<span>
															{payWhere(r.pay) || methodName(r.pay.method)}
															<small>{r.pay.account_number}</small>
														</span>
														<button type="button" className="linkbtn" onClick={() => copy(r.pay.account_number)}>
															Copy
														</button>
													</>
												) : (
													<span className="muted">{r.slip ? r.slip.account : ''}</span>
												)}
											</span>
										</>
									)}
									<span role="cell" className="pay-act">
										{r.slip ? (
											r.slip.paid_at ? (
												<button type="button" className="pay-paid" onClick={() => markPaid([r.member_id], false)} disabled={viewOnly} title="Click to mark not paid">
													✓ Paid
												</button>
											) : (
												<button type="button" className="btn small" onClick={() => markPaid([r.member_id])} disabled={viewOnly}>
													Mark paid
												</button>
											)
										) : null}
									</span>
								</div>
							);
						})}
						{rows.length > 0 && (
							<div className="pay-tr pay-tf" role="row">
								<b role="cell">{rows.length} people</b>
								<b role="cell">{money(sumOf('salary'))}</b>
								<span />
								<span />
								<b role="cell" className="pay-t-extra">
									+ {money(sumOf('extra_pay'))}
								</b>
								<span />
								<b role="cell" className="pay-t-off">
									− {money(sumOf('deducted'))}
								</b>
								<b role="cell">{money(sumOf('total'))}</b>
								<span />
								<span />
							</div>
						)}
					</div>
					<p className="muted pay-legend">Extra pay = extra hours × (salary ÷ 30 ÷ hours a day). Deducted = leave days past the year’s casual / sick days × salary ÷ 30. December pays out the unused days. {res.billed ? '' : 'Mark paid opens on the billing date.'}</p>
				</>
			)}
		</div>
	);
}

// "2 worked extra (+ 1,250 BDT), 1 went over their leave (− 1,000 BDT). Total to pay 31,250 BDT."
function noticeLine(rows, sumOf, billed) {
	const extra = rows.filter((r) => r.nums && r.nums.extra_pay > 0).length;
	const over = rows.filter((r) => r.nums && r.nums.deducted > 0).length;
	const parts = [
		extra ? `${extra} worked extra (+ ${money(sumOf('extra_pay'))} BDT)` : 'Nobody worked extra',
		over ? `${over} went over their leave (− ${money(sumOf('deducted'))} BDT)` : 'nobody went over their leave',
	];
	return `${parts.join(', ')}. Total ${billed ? 'to pay' : 'so far'} ${money(sumOf('total'))} BDT.`;
}

// Leave days taken that month (a payslip keeps it as leave_taken).
function taken(r) {
	const n = r.nums;
	if (!n) return 0;
	return r.slip ? +n.leave_taken || 0 : (n.leave && n.leave.taken) || 0;
}

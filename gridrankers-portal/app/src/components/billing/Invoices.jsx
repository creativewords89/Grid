import { useEffect, useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { rowsOf } from '../../lib/store.js';
import { short } from '../../lib/format.js';
import { CURRENCY, METHODS, REMIND_DAYS, TAGS, TAG_LABEL, billingCsv, billingRows, cycleLabel, latestByProject, money, owedOf, tagText, totals, yearMonths } from '../../lib/billing.js';
import Modal from '../Modal.jsx';

const MONTH = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 1, 1)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });

// Saves a billing row returned by the server.
function useSave() {
	const { api, dispatch, toast } = usePortal();
	return async (call, done) => {
		try {
			const row = await call(api);
			dispatch({ type: 'upsert', table: row.cycle_key ? 'billing' : 'billing_fees', row });
			if (done) toast(done);
			return row;
		} catch (err) {
			toast(err.message);
			return null;
		}
	};
}

function Tag({ r, full = true }) {
	return <span className={'bl-tag b-' + r.status}>{full ? tagText(r) : TAG_LABEL[r.status]}</span>;
}

// Invoices (SPEC.md 6.14, designs TR-A and TR-B): the Super Admin's own record of what is billed
// and paid. By project shows each project's latest cycle with two ticks; Year view shows every
// cycle's tag by the month it ended.
export default function Invoices() {
	const { api, data, dispatch, today, confirm } = usePortal();
	const save = useSave();
	const [mode, setMode] = useState('project');
	const [filter, setFilter] = useState('all');
	const [half, setHalf] = useState(0);
	const [payFor, setPayFor] = useState(null);
	const [openId, setOpenId] = useState(null);
	const [fees, setFees] = useState(false);

	// Rows for cycles that ended since the last full sync are made on the server when asked.
	useEffect(() => {
		api
			.get('billing')
			.then((res) => dispatch({ type: 'sync', changes: res }))
			.catch(() => {});
	}, [api, dispatch]);

	const rows = useMemo(() => billingRows(data, today), [data, today]);
	const latest = useMemo(() => latestByProject(rows), [rows]);
	const sum = useMemo(() => totals(rows, today), [rows, today]);
	const shown = filter === 'all' ? latest : latest.filter((r) => r.status === filter);
	const open = openId && rows.find((r) => r.id === openId);

	const tickSent = async (r) => {
		if (r.sent_at) {
			const ok = await confirm({ title: `Untick “Invoice sent” for ${r.name}?`, message: `The ${cycleLabel(r)} invoice goes back to To send.`, ok: 'Untick' });
			if (!ok) return;
			save((a) => a.patch(`billing/${r.id}`, { sent: false }));
			return;
		}
		save((a) => a.patch(`billing/${r.id}`, { sent: true }), `${r.name}: invoice marked as sent`);
	};

	const exportCsv = () => {
		const blob = new Blob([billingCsv(rows)], { type: 'text/csv;charset=utf-8' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `invoices-${today}.csv`;
		document.body.appendChild(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	};

	return (
		<div className="bl">
			<div className="bl-tiles">
				<div className="bl-tile">
					<span className="bl-tl">To send</span>
					<span className="bl-tv">
						<b className="c-amber">{sum.toSend.length}</b> <small>{sum.toSend.map((r) => r.name).join(', ') || 'All sent'}</small>
					</span>
				</div>
				<div className="bl-tile">
					<span className="bl-tl">Waiting for payment</span>
					<span className="bl-tv">
						<b className="c-blue">{sum.waiting.length}</b> <small>{sum.waitingSum || 'Nothing waiting'}</small>
					</span>
				</div>
				<div className="bl-tile">
					<span className="bl-tl">Overdue</span>
					<span className="bl-tv">
						<b className="c-red">{sum.overdue.length}</b> <small>{sum.overdue.length ? `${sum.overdue[0].name} · ${sum.overdue[0].days} days` : 'Nothing overdue'}</small>
					</span>
				</div>
				<div className="bl-tile">
					<span className="bl-tl">Received this month</span>
					<span className="bl-tv">
						<b className="c-green">{sum.received || money(0)}</b> <small>{sum.payments === 1 ? '1 payment' : `${sum.payments} payments`}</small>
					</span>
				</div>
			</div>

			<div className="bl-bar">
				<div className="bl-seg" role="group" aria-label="View">
					<button type="button" aria-pressed={mode === 'project'} onClick={() => setMode('project')}>
						By project
					</button>
					<button type="button" aria-pressed={mode === 'year'} onClick={() => setMode('year')}>
						Year view
					</button>
				</div>
				{mode === 'project' ? (
					<div className="bl-chips" role="group" aria-label="Show">
						<button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
							All <span>{latest.length}</span>
						</button>
						{TAGS.map((t) => {
							const n = latest.filter((r) => r.status === t.id).length;
							return (
								(n > 0 || filter === t.id) && (
									<button key={t.id} type="button" aria-pressed={filter === t.id} onClick={() => setFilter(t.id)}>
										{t.label} <span>{n}</span>
									</button>
								)
							);
						})}
					</div>
				) : (
					<div className="bl-legend" aria-label="Tags">
						{TAGS.map((t) => (
							<span key={t.id} className={'bl-key b-' + t.id}>
								{t.label}
							</span>
						))}
					</div>
				)}
				<span className="bl-acts">
					<button type="button" className="btn small" onClick={() => setFees(true)}>
						⚙ Fees
					</button>
					<button type="button" className="btn small" onClick={exportCsv} disabled={!rows.length}>
						Export CSV
					</button>
				</span>
			</div>

			{!rows.length ? (
				<p className="empty bl-empty">No ended cycles yet. Each active project gets a line here the day its cycle ends.</p>
			) : mode === 'project' ? (
				<div className="bl-table" role="table" aria-label="Invoices by project">
					<div className="bl-row bl-head" role="row">
						<span role="columnheader">Project</span>
						<span role="columnheader">Last cycle</span>
						<span role="columnheader">Amount</span>
						<span role="columnheader">Payment</span>
						<span role="columnheader">Invoice sent</span>
						<span role="columnheader">Payment received</span>
						<span role="columnheader">
							<span className="sr-only">Open</span>
						</span>
					</div>
					{shown.length === 0 && <p className="empty bl-none">Nothing tagged {TAG_LABEL[filter]}.</p>}
					{shown.map((r) => (
						<div className="bl-row" role="row" key={r.id} data-project={r.project_id}>
							<span role="cell" className="bl-name">
								<b>{r.name}</b>
								{r.older.length > 0 && (
									<button type="button" className="bl-older" onClick={() => setMode('year')}>
										+{r.older.length} older {r.older.length === 1 ? 'cycle' : 'cycles'} open
									</button>
								)}
							</span>
							<span role="cell" className="muted">
								{cycleLabel(r)}
							</span>
							<span role="cell">
								<b>{money(r.amount, r.currency)}</b>
							</span>
							<span role="cell">
								<Tag r={r} />
							</span>
							<span role="cell">
								{+r.skipped ? (
									<span className="muted">Not billed</span>
								) : (
									<label className="bl-tick">
										<input type="checkbox" checked={!!r.sent_at} onChange={() => tickSent(r)} aria-label={`Invoice sent · ${r.name}`} />
										{r.sent_at ? (
											<span>
												<b>Sent</b> · {short(r.sent_at)}
											</span>
										) : (
											<span>Sent</span>
										)}
									</label>
								)}
							</span>
							<span role="cell">
								{+r.skipped ? (
									<span className="muted">—</span>
								) : (
									<label className="bl-tick">
										<input type="checkbox" checked={r.status === 'paid'} onChange={() => (r.status === 'paid' ? setOpenId(r.id) : setPayFor(r))} aria-label={`Payment received · ${r.name}`} />
										{r.status === 'paid' ? (
											<span>
												<b>Received</b> · {short((r.payments[r.payments.length - 1] || {}).date)}
											</span>
										) : r.paid > 0 ? (
											<span>
												{money(r.paid, r.currency)} of {money(r.amount, r.currency)}
											</span>
										) : (
											<span>Not yet</span>
										)}
									</label>
								)}
							</span>
							<span role="cell">
								<button type="button" className="linkbtn" onClick={() => setOpenId(r.id)} aria-label={`Open ${r.name} ${cycleLabel(r)}`}>
									Open ›
								</button>
							</span>
						</div>
					))}
				</div>
			) : (
				<YearView rows={rows} half={half} setHalf={setHalf} onOpen={(r) => setOpenId(r.id)} />
			)}

			{open && <BillDialog r={open} onClose={() => setOpenId(null)} onPay={() => setPayFor(open)} />}
			{payFor && <PaymentDialog r={payFor} onClose={() => setPayFor(null)} />}
			{fees && <FeesDialog onClose={() => setFees(false)} />}
		</div>
	);
}

// TR-B: projects down, six months across (by the month a cycle ends), Owed on the right.
function YearView({ rows, half, setHalf, onOpen }) {
	const { today } = usePortal();
	const months = yearMonths(today, half);
	const by = {};
	rows.forEach((r) => {
		const p = (by[r.project_id] = by[r.project_id] || { name: r.name, id: r.project_id, rows: [] });
		p.rows.push(r);
	});
	const projects = Object.values(by).sort((a, b) => a.name.localeCompare(b.name));

	return (
		<div className="bl-table bl-year" role="table" aria-label="Invoices by month">
			<div className="bl-yrow bl-head" role="row">
				<span role="columnheader" className="bl-ynav">
					Project
					<span>
						<button type="button" className="bl-step" aria-label="Earlier months" onClick={() => setHalf(half - 1)}>
							‹
						</button>
						<button type="button" className="bl-step" aria-label="Later months" disabled={half >= 0} onClick={() => setHalf(half + 1)}>
							›
						</button>
					</span>
				</span>
				{months.map((m) => (
					<span role="columnheader" key={m} className="bl-mh">
						{MONTH(m)}
						{m.slice(5) === '01' || m === months[0] ? <small> {m.slice(0, 4)}</small> : null}
					</span>
				))}
				<span role="columnheader" className="bl-owed">
					Owed
				</span>
			</div>
			{projects.map((p) => {
				const owed = owedOf(p.rows);
				return (
					<div className="bl-yrow" role="row" key={p.id}>
						<span role="cell">
							<b>{p.name}</b>
						</span>
						{months.map((m) => {
							const cell = p.rows.filter((r) => String(r.cycle_end).slice(0, 7) === m);
							return (
								<span role="cell" key={m} className="bl-cellw">
									{cell.length === 0 ? (
										<span className="bl-cell b-none" aria-label="No cycle">
											—
										</span>
									) : (
										cell.map((r) => (
											<button key={r.id} type="button" className={'bl-cell b-' + r.status} title={`${cycleLabel(r)} · ${tagText(r)}`} onClick={() => onOpen(r)}>
												{TAG_LABEL[r.status]}
											</button>
										))
									)}
								</span>
							);
						})}
						<span role="cell" className={'bl-owed' + (owed ? ' c-red' : ' c-green')}>
							<b>{owed || '—'}</b>
						</span>
					</div>
				);
			})}
		</div>
	);
}

// "Payment received": amount (what is left by default), date, method, reference. Part payments add up.
function PaymentDialog({ r, onClose }) {
	const { today } = usePortal();
	const save = useSave();
	const [amount, setAmount] = useState(r.left > 0 ? String(r.left) : r.amount != null && !r.paid ? String(r.amount) : '');
	const [date, setDate] = useState(today);
	const [method, setMethod] = useState('');
	const [ref, setRef] = useState('');
	const [error, setError] = useState('');

	const submit = async (e) => {
		e.preventDefault();
		if (!(+String(amount).replace(/,/g, '') > 0)) return setError('Enter the amount received.');
		const row = await save((a) => a.post(`billing/${r.id}/payments`, { amount, date, method, ref }), `${r.name}: payment recorded`);
		if (row) onClose();
	};

	return (
		<Modal open onClose={onClose} labelledBy="blPay" className="bl-dlg">
			<form onSubmit={submit} noValidate>
				<h2 id="blPay">Payment received · {r.name}</h2>
				<p className="muted bl-sub">
					{cycleLabel(r)} · {r.amount != null ? `${money(r.amount, r.currency)} billed` : 'no amount set'}
					{r.paid > 0 ? ` · ${money(r.paid, r.currency)} received so far` : ''}
				</p>
				<div className="row">
					<label>
						Amount ({r.currency || CURRENCY})
						<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
					</label>
					<label>
						Date
						<input type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} />
					</label>
				</div>
				<div className="bl-methods" role="group" aria-label="Method">
					{METHODS.map((m) => (
						<button key={m} type="button" aria-pressed={method === m} onClick={() => setMethod(method === m ? '' : m)}>
							{m}
						</button>
					))}
				</div>
				<label>
					<span>
						Reference <span className="muted">(optional)</span>
					</span>
					<input value={ref} maxLength={191} onChange={(e) => setRef(e.target.value)} placeholder="Transaction ID, cheque no." />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Save
					</button>
				</div>
			</form>
		</Modal>
	);
}

// One cycle in full: amount, invoice sent date and number, Not billed, payments.
function BillDialog({ r, onClose, onPay }) {
	const { confirm } = usePortal();
	const save = useSave();
	const [amount, setAmount] = useState(r.amount == null ? '' : String(r.amount));
	const [currency, setCurrency] = useState(r.currency || CURRENCY);
	const [sentAt, setSentAt] = useState(r.sent_at || '');
	const [ref, setRef] = useState(r.ref || '');
	const [skipped, setSkipped] = useState(!!+r.skipped);
	const [note, setNote] = useState(r.note || '');

	const submit = async (e) => {
		e.preventDefault();
		const row = await save((a) => a.patch(`billing/${r.id}`, { amount, currency, sent_at: sentAt || null, ref, skipped, note }), 'Saved');
		if (row) onClose();
	};
	const removePayment = async (p) => {
		const ok = await confirm({ title: 'Remove this payment?', message: `${money(p.amount, r.currency)} on ${short(p.date)}.`, ok: 'Remove', danger: true });
		if (ok) save((a) => a.del(`billing/${r.id}/payments/${p.id}`));
	};

	return (
		<Modal open onClose={onClose} labelledBy="blBill" className="bl-dlg">
			<form onSubmit={submit} noValidate>
				<h2 id="blBill">
					{r.name} · {cycleLabel(r)}
				</h2>
				<p className="bl-sub">
					<Tag r={r} />
				</p>
				<div className="row bl-row3">
					<label>
						Amount
						<input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="No amount" />
					</label>
					<label>
						Currency
						<input value={currency} maxLength={8} onChange={(e) => setCurrency(e.target.value)} />
					</label>
				</div>
				<div className="row">
					<label>
						Invoice sent on
						<input type="date" value={sentAt} onChange={(e) => setSentAt(e.target.value)} aria-label="Invoice sent on" />
					</label>
					<label>
						<span>
							Invoice no. or link <span className="muted">(optional)</span>
						</span>
						<input value={ref} maxLength={191} onChange={(e) => setRef(e.target.value)} placeholder="INV-1042" />
					</label>
				</div>
				<label className="bl-check">
					<input type="checkbox" checked={skipped} onChange={(e) => setSkipped(e.target.checked)} />
					Not billed for this cycle (free month, paused work…)
				</label>
				<label>
					<span>
						Note <span className="muted">(optional)</span>
					</span>
					<textarea value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} rows={2} />
				</label>
				<div className="bl-pays">
					<div className="bl-pays-h">
						<b>Payments</b>
						<span className="muted">{r.paid > 0 ? `${money(r.paid, r.currency)} received` : 'None yet'}</span>
						<button type="button" className="btn small" onClick={onPay}>
							+ Record payment
						</button>
					</div>
					{(r.payments || []).length > 0 && (
						<ul>
							{r.payments.map((p) => (
								<li key={p.id}>
									<b>{money(p.amount, r.currency)}</b>
									<span>{short(p.date)}</span>
									<span className="muted">{[p.method, p.ref].filter(Boolean).join(' · ')}</span>
									<button type="button" className="ld-x" aria-label={`Remove payment of ${money(p.amount, r.currency)}`} onClick={() => removePayment(p)}>
										✕
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
					<button type="submit" className="btn primary">
						Save changes
					</button>
				</div>
			</form>
		</Modal>
	);
}

// ⚙ Fees: each active project's usual fee (the amount of new cycles), currency and how many days
// after the invoice an unpaid one turns Overdue.
function FeesDialog({ onClose }) {
	const { api, data, dispatch } = usePortal();
	const save = useSave();
	const projects = rowsOf(data, 'projects')
		.filter((p) => p.state === 'active')
		.sort((a, b) => a.name.localeCompare(b.name));
	const initial = () =>
		Object.fromEntries(
			projects.map((p) => {
				const f = (data.billing_fees || {})[p.id];
				return [p.id, { fee: f && f.fee != null ? String(f.fee) : '', currency: (f && f.currency) || CURRENCY, remind_days: String((f && f.remind_days) || REMIND_DAYS) }];
			}),
		);
	const [form, setForm] = useState(initial);
	const [start] = useState(initial);
	const set = (id, k, v) => setForm({ ...form, [id]: { ...form[id], [k]: v } });

	const submit = async (e) => {
		e.preventDefault();
		const changed = projects.filter((p) => JSON.stringify(form[p.id]) !== JSON.stringify(start[p.id]));
		for (const p of changed) {
			const row = await save((a) => a.put(`billing/projects/${p.id}`, form[p.id]));
			if (!row) return;
		}
		// A new fee fills in the amount of cycles not sent yet: show them now, not at the next sync.
		if (changed.length) await api.get('billing').then((res) => dispatch({ type: 'sync', changes: res }), () => {});
		onClose();
	};

	return (
		<Modal open onClose={onClose} labelledBy="blFees" className="bl-dlg bl-fees">
			<form onSubmit={submit} noValidate>
				<h2 id="blFees">Fees</h2>
				<p className="muted bl-sub">The usual fee fills in the amount of each new cycle. Payment reminder: days after the invoice is sent.</p>
				<div className="bl-fee bl-fee-h" aria-hidden="true">
					<span>Project</span>
					<span>Fee</span>
					<span>Currency</span>
					<span>Remind after</span>
				</div>
				{projects.map((p) => (
					<div className="bl-fee" key={p.id}>
						<b>{p.name}</b>
						<input inputMode="decimal" value={form[p.id].fee} onChange={(e) => set(p.id, 'fee', e.target.value)} placeholder="No fee" aria-label={`Fee · ${p.name}`} />
						<input value={form[p.id].currency} maxLength={8} onChange={(e) => set(p.id, 'currency', e.target.value)} aria-label={`Currency · ${p.name}`} />
						<span className="bl-days">
							<input type="number" min={1} max={90} value={form[p.id].remind_days} onChange={(e) => set(p.id, 'remind_days', e.target.value)} aria-label={`Reminder days · ${p.name}`} /> days
						</span>
					</div>
				))}
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Save fees
					</button>
				</div>
			</form>
		</Modal>
	);
}

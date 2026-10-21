import { useState } from 'react';
import { usePortal } from '../../context.js';
import { EMPLOYMENT, employmentOf, hasLeave } from '../../lib/people.js';
import { dayLength, dayPay, hourPay, hours, masked, methodName, money, monthTitle, shortDay } from '../../lib/pay.js';
import Modal from '../Modal.jsx';
import PayForm from './PayForm.jsx';

// Payment information (SPEC.md 6.19, design PAY-2): your pay (salary, hours, a day's and an
// hour's pay, the casual day off) and payment details, each with Edit; your past payslips below.
export default function PaymentInfo() {
	const { data, me, pay, toast } = usePortal();
	const self = data.members[me.id] || me;
	const [editing, setEditing] = useState(false);
	const state = pay.state;
	if (!state) return <p className="empty">Loading…</p>;
	const p = state.pay;
	if (!p) return <p className="empty">Your pay isn’t set up yet.</p>;

	return (
		<div className="pay-info">
			<div className="pay-cards">
				<section className="pay-card" aria-label="Your pay">
					<div className="pay-card-h">
						<h3>Your pay</h3>
						<button type="button" className="btn small" onClick={() => setEditing(true)}>
							✎ Edit
						</button>
					</div>
					<KV k="Salary" v={`${money(p.salary)} BDT a month`} />
					<KV k="Working hours" v={`${dayLength(p.day_minutes)} a day`} />
					<KV k="1 day (salary ÷ 30)" v={`${money(dayPay(p.salary))} BDT`} />
					<KV k={`1 hour (day ÷ ${+(p.day_minutes / 60).toFixed(2)})`} v={`${money(hourPay(p.salary, p.day_minutes))} BDT`} />
					<KV k="Leave" v={hasLeave(self) ? '10 casual + 14 sick days a year' : `none (${EMPLOYMENT[employmentOf(self)]})`} />
				</section>
				<section className="pay-card" aria-label="Payment details">
					<div className="pay-card-h">
						<h3>Payment details</h3>
						<button type="button" className="btn small" onClick={() => setEditing(true)}>
							✎ Edit
						</button>
					</div>
					<KV k="Method" v={methodName(p.method)} />
					{p.method === 'bank' && <KV k="Bank" v={[p.bank_name, p.branch].filter(Boolean).join(' · ')} />}
					<KV k="Account name" v={p.account_name} />
					<KV k={p.method === 'bank' ? 'Account number' : 'Number'} v={masked(p.account_number)} />
					{p.method === 'bank' && p.routing && <KV k="Routing number" v={p.routing} />}
					<p className="muted pay-note">🔒 Only you and the Super Admin see this.</p>
				</section>
			</div>

			<section className="pay-card pay-history" aria-label="Past months">
				<h3>Past months</h3>
				{state.slips.length === 0 ? (
					<p className="muted">Your first payslip comes on the 1st of next month.</p>
				) : (
					<div className="pay-table" role="table">
						<div className="pay-tr pay-th hist" role="row">
							{['Month', 'Salary', 'Extra hours', 'Extra pay', 'Days off', 'Deducted', 'Total', 'Status'].map((h) => (
								<span key={h} role="columnheader">
									{h}
								</span>
							))}
						</div>
						{state.slips.map((s) => (
							<div key={s.id} className="pay-tr hist" role="row">
								<b role="cell">{monthTitle(s.month)}</b>
								<span role="cell">{money(s.salary)}</span>
								<span role="cell">{s.extra ? hours(s.extra) : '—'}</span>
								<b role="cell" className={s.extra_pay ? 'pay-t-extra' : 'muted'}>
									{s.extra_pay ? `+ ${money(s.extra_pay)}` : '—'}
								</b>
								<span role="cell">{s.leave_taken}</span>
								<b role="cell" className={s.deducted ? 'pay-t-off' : 'muted'}>
									{s.deducted ? `− ${money(s.deducted)}` : s.leave_pay ? `+ ${money(s.leave_pay)}` : '—'}
								</b>
								<b role="cell">{money(s.total)}</b>
								<span role="cell">{s.paid_at ? <span className="pay-tag paid">Paid {shortDay(s.paid_at.slice(0, 10))}</span> : <span className="pay-tag due">To be paid</span>}</span>
							</div>
						))}
					</div>
				)}
			</section>

			<Modal open={editing} onClose={() => setEditing(false)} className="dr-dlg pay-dlg" labelledBy="payEditTitle">
				<div className="pay-dlg-in">
					<div className="dr-form-h">
						<h2 id="payEditTitle">Your work and pay</h2>
						<button type="button" className="dr-x" aria-label="Close" onClick={() => setEditing(false)}>
							×
						</button>
					</div>
					<PayForm
						pay={p}
						submitLabel="Save"
						onCancel={() => setEditing(false)}
						onSaved={(row) => {
							pay.update(row);
							setEditing(false);
							toast('Saved');
						}}
					/>
				</div>
			</Modal>
		</div>
	);
}

function KV({ k, v }) {
	return (
		<div className="pay-kv">
			<span>{k}</span>
			<b>{v}</b>
		</div>
	);
}

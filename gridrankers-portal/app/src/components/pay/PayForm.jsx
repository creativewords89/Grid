import { useState } from 'react';
import { usePortal } from '../../context.js';
import { DAY_CHOICES, METHODS, dayPay, hourPay, money, parseSalary, payError } from '../../lib/pay.js';

// Working hours, salary and payment details (SPEC.md 6.19, design PAY-1): the setup page and the
// Edit dialog on Payment information. Shows a day's and an hour's pay as the salary is typed.
export default function PayForm({ pay, onSaved, submitLabel, onCancel }) {
	const { api } = usePortal();
	const start = pay || {};
	const startMinutes = +start.day_minutes || 0;
	const [choice, setChoice] = useState(startMinutes ? (DAY_CHOICES.includes(startMinutes) ? startMinutes : 'other') : null);
	const [otherH, setOtherH] = useState(startMinutes && !DAY_CHOICES.includes(startMinutes) ? String(Math.floor(startMinutes / 60)) : '');
	const [otherM, setOtherM] = useState(startMinutes && !DAY_CHOICES.includes(startMinutes) ? String(startMinutes % 60) : '');
	const [salary, setSalary] = useState(start.salary ? money(start.salary) : '');
	const [method, setMethod] = useState(start.method || 'bank');
	const [bank, setBank] = useState(start.bank_name || '');
	const [branch, setBranch] = useState(start.branch || '');
	const [name, setName] = useState(start.account_name || '');
	const [number, setNumber] = useState(start.account_number || '');
	const [routing, setRouting] = useState(start.routing || '');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);

	const minutes = choice === 'other' ? (Math.max(0, parseInt(otherH, 10) || 0) * 60 + Math.max(0, parseInt(otherM, 10) || 0)) : choice || 0;
	const amount = parseSalary(salary);

	const submit = async (e) => {
		e.preventDefault();
		const form = { day_minutes: minutes, salary, method, bank_name: bank, branch, account_name: name, account_number: number, routing };
		const why = payError(form);
		setError(why);
		if (why) return;
		setBusy(true);
		try {
			const row = await api.put('pay/me', form);
			onSaved(row);
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};

	return (
		<form className="pay-form" onSubmit={submit} noValidate>
			<section className="pay-sec">
				<div className="pay-sec-h">
					<span className="pay-n">1</span>
					<div>
						<h3>Your working hours</h3>
						<p>How many hours you work a day</p>
					</div>
				</div>
				<div className="pay-hours" role="group" aria-label="Hours a day">
					{DAY_CHOICES.map((m) => (
						<button key={m} type="button" aria-pressed={choice === m} onClick={() => setChoice(m)}>
							{m / 60} hours
						</button>
					))}
					<button type="button" aria-pressed={choice === 'other'} onClick={() => setChoice('other')}>
						Other
					</button>
				</div>
				{choice === 'other' && (
					<div className="dr-hm">
						<input className="dr-in" type="number" min="1" max="16" value={otherH} onChange={(e) => setOtherH(e.target.value)} aria-label="Hours" />h
						<input className="dr-in" type="number" min="0" max="59" value={otherM} onChange={(e) => setOtherM(e.target.value)} aria-label="Minutes" />m
					</div>
				)}
			</section>

			<section className="pay-sec">
				<div className="pay-sec-h">
					<span className="pay-n">2</span>
					<div>
						<h3>Your monthly salary</h3>
						<p>Extra hours are paid from this</p>
					</div>
				</div>
				<label className="dr-lab">
					Salary a month (BDT)
					<input className="dr-in" inputMode="numeric" value={salary} onChange={(e) => setSalary(e.target.value)} placeholder="e.g. 30,000" aria-label="Salary a month (BDT)" />
				</label>
				{amount > 0 && (
					<div className="pay-calc" aria-live="polite">
						<span>
							1 day = {money(amount)} ÷ 30 = <b>{money(dayPay(amount))} BDT</b>
						</span>
						{minutes > 0 && (
							<span>
								1 hour = {money(dayPay(amount))} ÷ {+(minutes / 60).toFixed(2)} = <b>{money(hourPay(amount, minutes))} BDT</b>
							</span>
						)}
					</div>
				)}
			</section>

			<section className="pay-sec">
				<div className="pay-sec-h">
					<span className="pay-n">3</span>
					<div>
						<h3>Payment details</h3>
						<p>Where your salary is sent</p>
					</div>
				</div>
				<div className="pay-methods" role="group" aria-label="Paid by">
					{METHODS.map(([k, label]) => (
						<button key={k} type="button" aria-pressed={method === k} onClick={() => setMethod(k)}>
							{label}
						</button>
					))}
				</div>
				<div className="pay-grid">
					{method === 'bank' && (
						<>
							<label className="dr-lab">
								Bank name
								<input className="dr-in" value={bank} onChange={(e) => setBank(e.target.value)} maxLength={120} aria-label="Bank name" />
							</label>
							<label className="dr-lab">
								Branch <span className="muted">(optional)</span>
								<input className="dr-in" value={branch} onChange={(e) => setBranch(e.target.value)} maxLength={120} aria-label="Branch" />
							</label>
						</>
					)}
					<label className="dr-lab">
						Account name
						<input className="dr-in" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} aria-label="Account name" />
					</label>
					<label className="dr-lab">
						{method === 'bank' ? 'Account number' : `${method === 'bkash' ? 'bKash' : 'Nagad'} number`}
						<input className="dr-in" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} maxLength={40} placeholder={method === 'bank' ? '' : '01712345678'} aria-label="Account number" />
					</label>
					{method === 'bank' && (
						<label className="dr-lab">
							Routing number <span className="muted">(optional)</span>
							<input className="dr-in" inputMode="numeric" value={routing} onChange={(e) => setRouting(e.target.value)} maxLength={20} aria-label="Routing number" />
						</label>
					)}
				</div>
			</section>

			<p className="err" role="alert">
				{error}
			</p>
			<div className="pay-acts">
				<span className="muted">🔒 Only you and the Super Admin can see your salary and payment details.</span>
				{onCancel && (
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
				)}
				<button type="submit" className="btn primary" disabled={busy}>
					{submitLabel}
				</button>
			</div>
		</form>
	);
}

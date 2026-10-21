import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { WEEK, addMonths, calendarCells, dayLength, dayPay, dayTone, hourPay, hours, leaveLine, money, monthTitle, shortDay } from '../../lib/pay.js';

// Salary tab, your own month (SPEC.md 6.19, design PAY-3): every day's hours from your sent
// reports on a calendar (full day, short, extra, days off and leave), and the month adding up —
// salary + extra pay ± the casual day off = pay so far. A billed month shows its payslip.
export default function SalaryMonth() {
	const { api, pay } = usePortal();
	const today = (pay.state && pay.state.today) || new Date().toISOString().slice(0, 10);
	const [month, setMonth] = useState(today.slice(0, 7));
	const [res, setRes] = useState(null);
	const [error, setError] = useState('');

	useEffect(() => {
		let live = true;
		setRes(null);
		api
			.get('salary', { month })
			.then((r) => live && setRes(r))
			.catch((err) => live && setError(err.message));
		return () => {
			live = false;
		};
	}, [api, month]);

	if (error) return <p className="err">{error}</p>;
	const atNow = month >= today.slice(0, 7);
	const sum = res && res.summary;
	const slip = res && res.slip;
	const total = slip ? slip.total : sum ? sum.total : 0;
	const leave = sum ? leaveLine(sum) : null;

	return (
		<div className="pay-month">
			<div className="pay-bar">
				<div className="dr-dayrow">
					<button type="button" className="dr-nav" aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))}>
						‹
					</button>
					<b className="dr-day">{monthTitle(month)}</b>
					<button type="button" className="dr-nav" aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))} disabled={atNow}>
						›
					</button>
				</div>
			</div>
			{!res ? (
				<p className="empty">Loading…</p>
			) : !sum ? (
				<p className="empty">Set up your working hours and salary in Payment information.</p>
			) : (
				<>
					<div className="pay-tiles">
						<div>
							<b>{hours(sum.worked)}</b>
							<span>worked in {monthTitle(month, true)}</span>
						</div>
						<div className="extra">
							<b>+{hours(sum.extra)}</b>
							<span>extra hours · + {money(sum.extra_pay)} BDT</span>
						</div>
						<div className={sum.deducted ? 'off' : ''}>
							<b>
								{sum.leave.taken} {sum.leave.taken === 1 ? 'day' : 'days'}
							</b>
							<span>off · {sum.leave.deducted ? `${sum.leave.deducted} over the allowance, deducted` : sum.leave.paid ? `${sum.leave.paid} unused paid` : 'within the allowance'}</span>
						</div>
						<div className="total">
							<b>{money(total)} BDT</b>
							<span>{slip ? (slip.paid_at ? 'paid' : 'to be paid') : 'pay so far'}</span>
						</div>
					</div>
					<div className="pay-split">
						<div className="pay-cal" role="grid" aria-label={`Hours in ${monthTitle(month)}`}>
							{WEEK.map((w) => (
								<span key={w} className="pay-wd">
									{w}
								</span>
							))}
							{calendarCells(sum.days).map((d, i) =>
								d ? <DayCell key={d.day} day={d} dayMinutes={sum.day_minutes} salary={sum.salary} today={today} /> : <span key={'b' + i} />
							)}
						</div>
						<div className="pay-sum">
							<div className="pay-sum-h">
								<b>{monthTitle(month, true)} {slip ? '' : 'so far'}</b>
								<span className="muted">
									{slip ? (slip.paid_at ? 'Paid' : 'Billed') : 'Billed'} <b>{shortDay(res.billing)}</b>
								</span>
							</div>
							<Line k="Salary" how={`${dayLength(sum.day_minutes)} a day · 1 day ${money(dayPay(sum.salary))} · 1 hour ${money(hourPay(sum.salary, sum.day_minutes))}`} v={money(sum.salary)} />
							<Line k="Extra hours" how={`${hours(sum.extra)} × ${money(hourPay(sum.salary, sum.day_minutes))}`} v={`+ ${money(sum.extra_pay)}`} tone="extra" />
							<Line k="Days off" how={leave.text} v={leave.amount ? `${leave.sign} ${money(leave.amount)}` : '—'} tone={leave.sign === '−' ? 'off' : leave.sign === '+' ? 'extra' : ''} />
							<Line k={slip ? 'Total' : 'Pay so far'} v={`${money(total)} BDT`} big />
							<p className="muted pay-note">Weekly days off never count. 8h extra on an 8-hour day = one more day’s pay; each leave day past the year’s allowance = one day less; December pays out the unused days.</p>
						</div>
					</div>
					<p className="muted pay-legend">
						<i className="pay-t-full" /> your full day <i className="pay-t-short" /> less <i className="pay-t-extra" /> extra hours <i className="pay-t-off" /> day off or leave
					</p>
				</>
			)}
		</div>
	);
}

function Line({ k, how, v, tone, big }) {
	return (
		<div className={'pay-line' + (big ? ' big' : '')}>
			<span>{k}</span>
			<b className={tone ? 'pay-t-' + tone : ''}>{v}</b>
			{how && <small>{how}</small>}
		</div>
	);
}

function DayCell({ day, dayMinutes, today }) {
	const tone = dayTone(day, dayMinutes);
	const n = +day.day.slice(8);
	let body = null;
	if (tone === 'off') body = <span className="pay-mute">Day off</span>;
	else if (tone === 'leave') body = <span className="pay-tag leave">Leave</span>;
	else if (tone === 'empty') body = <span className="pay-mute">—</span>;
	else if (tone !== 'future')
		body = (
			<>
				<b className={'pay-t-' + (tone === 'extra' ? 'full' : tone)}>{hours(day.minutes)}</b>
				{day.extra > 0 && <span className="pay-tag extra">+{hours(day.extra)}</span>}
			</>
		);
	return (
		<div className={'pay-day ' + tone + (day.day === today ? ' today' : '')} role="gridcell" aria-label={`${day.day}: ${day.minutes ? hours(day.minutes) : tone}`}>
			<span className="pay-d">{n}</span>
			<span className="pay-dv">{body}</span>
		</div>
	);
}

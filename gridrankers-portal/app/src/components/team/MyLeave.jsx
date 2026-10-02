import { useState } from 'react';
import { usePortal } from '../../context.js';
import { daysLeft, monthName, takenInMonth, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import { LeaveDialog } from '../day/Leave.jsx';
import { LeaveTable } from './leaveParts.jsx';

const SETTLED = { paid: 'Unused · 1 day paid', even: 'Even', deducted: (n) => `${n} day${n === 1 ? '' : 's'} deducted` };

// Member page → My leave (SPEC.md 7.6): this month's days left, requests, past months' settlement.
export default function MyLeave({ pid }) {
	const { data, me, today } = usePortal();
	const [open, setOpen] = useState(false);
	const person = data.members[pid];
	const leaves = rowsOf(data, 'leave').filter((l) => l.member_id === pid);
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const month = today.slice(0, 7);
	const left = daysLeft(takenInMonth(person, month, leaves, team, daysOff));
	const self = pid === me.id;

	// The last 6 finished months since the person joined.
	const [y, m] = month.split('-').map(Number);
	const joined = String(person.created_at || '').slice(0, 7);
	const past = Array.from({ length: 6 }, (_, i) => {
		const d = new Date(y, m - 2 - i, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	}).filter((k) => !joined || k >= joined);

	return (
		<div className="set-grid lv-grid">
			<section className="dcard">
				<div className="dc-head">
					<span className="s-k">{self ? 'My leave' : `${person.name}’s leave`}</span>
					{self && (
						<button type="button" className="btn small primary" onClick={() => setOpen(true)}>
							{me.role === 'lead' ? 'Take day leave' : 'Request day leave'}
						</button>
					)}
				</div>
				<p className="dl-left">
					<b>{left}</b> day{left === 1 ? '' : 's'} left in {monthName(month)}
				</p>
				<LeaveTable rows={[...leaves].sort((a, b) => b.from_date.localeCompare(a.from_date))} empty="No leave yet." />
				<p className="hint">1 leave day a month for day leave or sick leave. At the end of the month an unused day is paid with that month’s salary; extra days are deducted. Nothing carries over.</p>
			</section>
			{past.length > 0 && (
				<section className="dcard">
					<div className="dc-head">
						<span className="s-k">Past months</span>
					</div>
					<ul className="do-list">
						{past.map((k) => {
							const taken = takenInMonth(person, k, leaves, team, daysOff);
							const result = taken === 0 ? 'paid' : taken === 1 ? 'even' : 'deducted';
							return (
								<li key={k}>
									<b>
										{monthName(k)} {k.slice(0, 4)}
									</b>
									<span>{taken} taken</span>
									<span className={'mp-flag ' + (result === 'paid' ? 'f-green' : result === 'deducted' ? 'f-red' : 'f-plain')}>{result === 'deducted' ? SETTLED.deducted(taken - 1) : SETTLED[result]}</span>
								</li>
							);
						})}
					</ul>
				</section>
			)}
			{self && <LeaveDialog open={open} onClose={() => setOpen(false)} />}
		</div>
	);
}

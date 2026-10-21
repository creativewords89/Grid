import { useState } from 'react';
import { usePortal } from '../../context.js';
import { EMPLOYMENT, balance, employmentOf, hasLeave, monthName, settlement, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import { LeaveDialog } from '../day/Leave.jsx';
import { LeaveTable } from './leaveParts.jsx';

const SETTLED = { paid: (r) => `${r.paid} unused day${r.paid === 1 ? '' : 's'} paid`, even: () => 'Even', deducted: (r) => `${r.deducted} day${r.deducted === 1 ? '' : 's'} deducted` };

// Member page → My leave (SPEC.md 7.6): this year's casual and sick days left, requests, this year's months.
export default function MyLeave({ pid }) {
	const { data, me, today } = usePortal();
	const [open, setOpen] = useState(false);
	const person = data.members[pid];
	const leaves = rowsOf(data, 'leave').filter((l) => l.member_id === pid);
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const year = today.slice(0, 4);
	const left = balance(person, +year, leaves, team, daysOff);
	const self = pid === me.id;

	// This year's months up to this one, since the person joined, newest first.
	const joined = String(person.created_at || '').slice(0, 7);
	const months = Array.from({ length: +today.slice(5, 7) }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`)
		.filter((k) => !joined || k >= joined)
		.reverse();

	return (
		<div className="set-grid lv-grid">
			<section className="dcard">
				<div className="dc-head">
					<span className="s-k">{self ? 'My leave' : `${person.name}’s leave`}</span>
					{self && (
						<button type="button" className="btn small primary" onClick={() => setOpen(true)}>
							{me.role === 'lead' ? 'Take leave' : 'Request leave'}
						</button>
					)}
				</div>
				{hasLeave(person) ? (
					<p className="dl-left">
						<b>{left.day.left}</b> of {left.day.allowance} casual · <b>{left.sick.left}</b> of {left.sick.allowance} sick days left in {year}
					</p>
				) : (
					<p className="dl-left">No leave days ({EMPLOYMENT[employmentOf(person)]}) · leave is deducted</p>
				)}
				<LeaveTable rows={[...leaves].sort((a, b) => b.from_date.localeCompare(a.from_date))} empty="No leave yet." />
				<p className="hint">Full-Time and Part-Time: 10 casual and 14 sick days a calendar year. Days past them are deducted; unused days are paid with December’s salary. Everything starts again on January 1.</p>
			</section>
			{months.length > 0 && (
				<section className="dcard">
					<div className="dc-head">
						<span className="s-k">{year}</span>
					</div>
					<ul className="do-list">
						{months.map((k) => {
							const r = settlement(person, k, leaves, team, daysOff);
							return (
								<li key={k}>
									<b>{monthName(k)}</b>
									<span>{r.taken} taken</span>
									<span className={'mp-flag ' + (r.result === 'paid' ? 'f-green' : r.result === 'deducted' ? 'f-red' : 'f-plain')}>{SETTLED[r.result](r)}</span>
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

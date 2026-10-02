import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { monthName } from '../../lib/people.js';
import { isAdmin } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import { LeaveTable, STATUS, downloadCsv, printOnly } from './leaveParts.jsx';

const RESULT = { paid: (r) => `${r.paid} day paid`, even: () => 'Even', deducted: (r) => `${r.deducted} day${r.deducted === 1 ? '' : 's'} deducted` };
const RESULT_CLS = { paid: 'f-green', even: 'f-plain', deducted: 'f-red' };

const monthsBack = (today, n) => {
	const [y, m] = today.split('-').map(Number);
	return Array.from({ length: n }, (_, i) => {
		const d = new Date(y, m - 1 - i, 1);
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
	});
};

// Super Admin: monthly settlement and the year-end counts (SPEC.md 6.10, 7.5).
function Reports() {
	const { api, data, today, toast } = usePortal();
	const [mode, setMode] = useState('month');
	const [month, setMonth] = useState(today.slice(0, 7));
	const [year, setYear] = useState(+today.slice(0, 4));
	const [report, setReport] = useState(null);

	useEffect(() => {
		let gone = false;
		setReport(null);
		api
			.get('leave/report', mode === 'month' ? { month } : { year })
			.then((r) => !gone && setReport(r))
			.catch((err) => !gone && toast(err.message));
		return () => {
			gone = true;
		};
		// Reloads when leave or days off change (toast is left out: it is a new function each render).
	}, [api, mode, month, year, data.leave, data.days_off]);

	const name = (id) => (data.members[id] ? data.members[id].name : '—');
	const rows = report ? report.rows : [];
	const csv = () =>
		mode === 'month'
			? downloadCsv(`leave-settlement-${month}.csv`, [['Person', 'Taken', 'Settlement', 'Paid days', 'Deducted days'], ...rows.map((r) => [name(r.member_id), r.taken, r.result, r.paid, r.deducted])])
			: downloadCsv(`leave-report-${year}.csv`, [['Person', 'Day leave', 'Sick leave', 'Total', 'Company days off'], ...rows.map((r) => [name(r.member_id), r.day, r.sick, r.total, r.days_off])]);

	return (
		<section className="dcard" id="leaveReport">
			<div className="dc-head">
				<span className="s-k">{mode === 'month' ? `Monthly settlement · ${monthName(month)} ${month.slice(0, 4)}` : `Year-end report ${year}`}</span>
				<div className="lr-tools">
					<div className="ra-chips" role="group" aria-label="Report">
						<button type="button" className="ra-chip" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
							Monthly settlement
						</button>
						<button type="button" className="ra-chip" aria-pressed={mode === 'year'} onClick={() => setMode('year')}>
							Year-end report
						</button>
					</div>
					{mode === 'month' ? (
						<select value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month">
							{monthsBack(today, 24).map((m) => (
								<option key={m} value={m}>
									{monthName(m)} {m.slice(0, 4)}
								</option>
							))}
						</select>
					) : (
						<select value={year} onChange={(e) => setYear(+e.target.value)} aria-label="Year">
							{[0, 1, 2].map((i) => (
								<option key={i} value={+today.slice(0, 4) - i}>
									{+today.slice(0, 4) - i}
								</option>
							))}
						</select>
					)}
					<button type="button" className="btn small" onClick={csv} disabled={!report}>
						Download CSV
					</button>
					<button type="button" className="btn small" onClick={() => printOnly('leaveReport')} disabled={!report}>
						Print
					</button>
				</div>
			</div>
			{!report ? (
				<p className="muted">Loading…</p>
			) : (
				<div className="tbl-wrap">
					<table className="hrs mtable">
						<thead>
							{mode === 'month' ? (
								<tr>
									<th>Person</th>
									<th>Taken</th>
									<th>End of {monthName(month)}</th>
								</tr>
							) : (
								<tr>
									<th>Person</th>
									<th>Day leave</th>
									<th>Sick leave</th>
									<th>Total</th>
									<th>Company days off</th>
								</tr>
							)}
						</thead>
						<tbody>
							{rows.map((r) =>
								mode === 'month' ? (
									<tr key={r.member_id}>
										<td>
											<b>{name(r.member_id)}</b>
										</td>
										<td>{r.taken}</td>
										<td>
											<span className={'mp-flag ' + RESULT_CLS[r.result]}>{RESULT[r.result](r)}</span>
										</td>
									</tr>
								) : (
									<tr key={r.member_id}>
										<td>
											<b>{name(r.member_id)}</b>
										</td>
										<td>{r.day}</td>
										<td>{r.sick}</td>
										<td>
											<b>{r.total}</b>
										</td>
										<td>{r.days_off}</td>
									</tr>
								),
							)}
						</tbody>
					</table>
				</div>
			)}
			<p className="hint">
				{mode === 'month'
					? 'Everyone gets 1 leave day a month (day leave or sick leave). Unused → 1 day paid with that month’s salary; extra days → deducted. Nothing carries over.'
					: 'Counts only — leave is settled every month. Total = day leave + sick leave. Company days off = weekly, event and seasonal days off.'}
			</p>
		</section>
	);
}

// Team → Leave (SPEC.md 7.5): everyone's leave with filters and actions; reports for the Super Admin.
export default function LeaveTab() {
	const { data, me } = usePortal();
	const [who, setWho] = useState('');
	const [status, setStatus] = useState('');
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.role !== 'admin')
		.sort((a, b) => a.name.localeCompare(b.name));
	const rows = rowsOf(data, 'leave')
		.filter((l) => (!who || l.member_id === who) && (!status || l.status === status))
		.sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.from_date.localeCompare(a.from_date));

	return (
		<div className="set-grid lv-grid">
			<section className="dcard">
				<div className="dc-head">
					<span className="s-k">Leave</span>
					<div className="lr-tools">
						<select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
							<option value="">Everyone</option>
							{people.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
						<select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
							<option value="">Any status</option>
							{Object.entries(STATUS).map(([k, [l]]) => (
								<option key={k} value={k}>
									{l}
								</option>
							))}
						</select>
					</div>
				</div>
				<LeaveTable rows={rows} showPerson empty="No leave yet." />
				<p className="hint">Team Members’ requests wait for a Team Leader or the Super Admin. A Team Leader’s leave is approved straight away.</p>
			</section>
			{isAdmin(me) && <Reports />}
		</div>
	);
}

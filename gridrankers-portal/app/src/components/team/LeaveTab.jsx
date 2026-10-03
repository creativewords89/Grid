import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { isIssued, leaveSummary, mayDecideLeave, overBy, sortLeave } from '../../lib/leaveBoard.js';
import { LEAVE_PER_MONTH, monthName } from '../../lib/people.js';
import { isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import IssueDayOff from './IssueDayOff.jsx';
import { STATUS, TYPE, downloadCsv, leaveActions, printOnly, rangeText, useLeaveAction } from './leaveParts.jsx';

const RESULT = { paid: (r) => `${r.paid} day paid`, even: () => 'Even', deducted: (r) => `${r.deducted} day${r.deducted === 1 ? '' : 's'} deducted` };
const RESULT_CLS = { paid: 'f-green', even: 'f-plain', deducted: 'f-red' };
const CHIPS = [
	['', 'All'],
	['pending', 'Waiting'],
	['approved', 'Approved'],
	['rejected', 'Not approved'],
	['cancelled', 'Cancelled'],
];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const shiftMonth = (month, k) => {
	const [y, m] = month.split('-').map(Number);
	const d = new Date(y, m - 1 + k, 1);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const names = (list) => (list.length > 3 ? `${list.slice(0, 3).join(' · ')} +${list.length - 3}` : list.join(' · '));

function Stat({ label, value, sub, tone }) {
	return (
		<div className={'lv-stat' + (tone ? ' t-' + tone : '')}>
			<span>{label}</span>
			<b>{value}</b>
			<small>{sub}</small>
		</div>
	);
}

// ‹ October 2026 › (or ‹ 2026 ›); never past `max`, never before `min`.
function Stepper({ label, onPrev, onNext, prevOk, nextOk }) {
	return (
		<div className="lv-step">
			<button type="button" aria-label="Previous" disabled={!prevOk} onClick={onPrev}>
				‹
			</button>
			<b aria-live="polite">{label}</b>
			<button type="button" aria-label="Next" disabled={!nextOk} onClick={onNext}>
				›
			</button>
		</div>
	);
}

// One request: who and why, type, dates (+ over the allowance), days, status, decision.
function Row({ l }) {
	const { data, me } = usePortal();
	const act = useLeaveAction();
	const owner = data.members[l.member_id];
	const by = data.members[l.decided_by];
	const [st, cls] = STATUS[l.status] || [l.status, 'f-plain'];
	const decide = mayDecideLeave(l, me, data);
	const over = l.status === 'pending' ? overBy(data, l) : 0;
	const cancel = leaveActions(l, me, owner).includes('cancel');
	return (
		<div className={'lv-row' + (l.status === 'pending' ? ' wait' : '')} role="row">
			<span className="lv-who" role="cell">
				<Avatar person={owner} small />
				<span>
					<b>{owner ? owner.name : '—'}</b>
					{l.reason && <small>“{l.reason}”</small>}
				</span>
			</span>
			<span role="cell">
				<span className={'lv-type ty-' + l.type}>{TYPE[l.type] || '—'}</span>
			</span>
			<span className="lv-dates" role="cell">
				{rangeText(l)}
				{over > 0 && <small className="lv-over">{plural(over, 'day')} over → deducted</small>}
			</span>
			<span role="cell">{plural(l.days, 'day')}</span>
			<span role="cell">
				<span className={'mp-flag ' + cls}>{st}</span>
			</span>
			<span className="lv-dec" role="cell">
				{decide ? (
					<span className="lv-btns">
						<button type="button" className="btn small lv-no" onClick={() => act(l, 'reject')}>
							Reject
						</button>
						<button type="button" className="btn small primary" onClick={() => act(l, 'approve')}>
							Approve
						</button>
					</span>
				) : (
					<>
						<span>
							{isIssued(l) && <span className="lv-issued">Issued</span>}
							{by && l.decided_by !== l.member_id ? (
								<>
									by <b>{by.name}</b>
								</>
							) : l.status === 'approved' && l.decided_by === l.member_id ? (
								'Approved straight away'
							) : l.status === 'pending' ? (
								'Waiting for a decision'
							) : null}
							{cancel && (
								<>
									{' · '}
									<button type="button" className="linkbtn" onClick={() => act(l, 'cancel')}>
										Cancel
									</button>
								</>
							)}
						</span>
						{l.message && <small>“{l.message}”</small>}
					</>
				)}
			</span>
		</div>
	);
}

// Super Admin: monthly settlement and the year-end counts (SPEC.md 6.10, 7.5).
function Settlement() {
	const { api, data, today, toast } = usePortal();
	const now = today.slice(0, 7);
	const thisYear = +today.slice(0, 4);
	const [mode, setMode] = useState('month');
	const [month, setMonth] = useState(now);
	const [year, setYear] = useState(thisYear);
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
	const totals = ['paid', 'even', 'deducted'].map((k) => rows.filter((r) => r.result === k).length);
	const oldest = shiftMonth(now, -23);

	return (
		<section className="dcard lv-card" id="leaveReport" aria-labelledby="lvSet">
			<div className="lv-head">
				<h3 id="lvSet">Settlement</h3>
				<div className="lv-seg" role="group" aria-label="Report">
					<button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
						Monthly
					</button>
					<button type="button" aria-pressed={mode === 'year'} onClick={() => setMode('year')}>
						Year-end
					</button>
				</div>
				<span className="lv-sp" />
				{mode === 'month' ? (
					<Stepper label={`${monthName(month)} ${month.slice(0, 4)}`} prevOk={month > oldest} nextOk={month < now} onPrev={() => setMonth(shiftMonth(month, -1))} onNext={() => setMonth(shiftMonth(month, 1))} />
				) : (
					<Stepper label={String(year)} prevOk={year > thisYear - 2} nextOk={year < thisYear} onPrev={() => setYear(year - 1)} onNext={() => setYear(year + 1)} />
				)}
				<button type="button" className="btn small" onClick={csv} disabled={!report}>
					⬇ CSV
				</button>
				<button type="button" className="btn small" onClick={() => printOnly('leaveReport')} disabled={!report}>
					Print
				</button>
			</div>
			{!report ? (
				<p className="muted lv-pad">Loading…</p>
			) : mode === 'month' ? (
				<div className="lv-table lv-set" role="table" aria-label={`Settlement ${monthName(month)} ${month.slice(0, 4)}`}>
					<div className="lv-row lv-th" role="row">
						<span role="columnheader">Person</span>
						<span role="columnheader">Allowance used</span>
						<span role="columnheader">Taken</span>
						<span role="columnheader">End of {monthName(month)}</span>
					</div>
					{rows.map((r) => (
						<div key={r.member_id} className="lv-row" role="row">
							<span className="lv-who" role="cell">
								<Avatar person={data.members[r.member_id]} small />
								<b>{name(r.member_id)}</b>
							</span>
							<span className="lv-bar" role="cell">
								{Array.from({ length: Math.max(LEAVE_PER_MONTH, r.taken) }, (_, k) => (
									<i key={k} className={k >= r.taken ? '' : k < LEAVE_PER_MONTH ? 'used' : 'over'} />
								))}
								<small>
									{r.taken} of {LEAVE_PER_MONTH}
								</small>
							</span>
							<b role="cell">{r.taken}</b>
							<span role="cell">
								<span className={'mp-flag ' + RESULT_CLS[r.result]}>{RESULT[r.result](r)}</span>
							</span>
						</div>
					))}
				</div>
			) : (
				<div className="lv-table lv-year" role="table" aria-label={`Year-end report ${year}`}>
					<div className="lv-row lv-th" role="row">
						<span role="columnheader">Person</span>
						<span role="columnheader">Day leave</span>
						<span role="columnheader">Sick leave</span>
						<span role="columnheader">Total</span>
						<span role="columnheader">Company days off</span>
					</div>
					{rows.map((r) => (
						<div key={r.member_id} className="lv-row" role="row">
							<span className="lv-who" role="cell">
								<Avatar person={data.members[r.member_id]} small />
								<b>{name(r.member_id)}</b>
							</span>
							<span role="cell">{r.day}</span>
							<span role="cell">{r.sick}</span>
							<b role="cell">{r.total}</b>
							<span role="cell">{r.days_off}</span>
						</div>
					))}
				</div>
			)}
			<div className="lv-foot">
				<span>
					{mode === 'month'
						? '1 leave day a month (day or sick). Unused → 1 day paid; extra → deducted. Nothing carries over.'
						: 'Counts only — leave is settled every month. Total = day leave + sick leave. Company days off = weekly, event and seasonal days off.'}
				</span>
				{mode === 'month' && report && (
					<span className="lv-tot">
						<b className="t-green">{totals[0]} paid</b> · <b>{totals[1]} even</b> · <b className="t-red">{totals[2]} deducted</b>
					</span>
				)}
			</div>
		</section>
	);
}

// My page → Leave (SPEC.md 7.5, design LV-A): the numbers, the requests, the settlement.
export default function LeaveTab() {
	const { data, me, today } = usePortal();
	const admin = isAdmin(me);
	const [who, setWho] = useState('');
	const [status, setStatus] = useState('');
	const [issuing, setIssuing] = useState(false);
	const sum = leaveSummary(data, me, today);
	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.role !== 'admin')
		.sort((a, b) => a.name.localeCompare(b.name));
	const mine = rowsOf(data, 'leave').filter((l) => !who || l.member_id === who);
	const rows = sortLeave(mine.filter((l) => !status || l.status === status));
	const nameOf = (l) => data.members[l.member_id].name;
	const mon = monthName(sum.month);

	return (
		<div className="lv-page">
			<div className={'lv-stats' + (admin ? '' : ' three')}>
				<Stat label="Waiting for you" value={sum.waiting.length} sub={sum.waiting.length ? names([...new Set(sum.waiting.map(nameOf))]) : 'Nothing to decide'} tone={sum.waiting.length ? 'amber' : ''} />
				<Stat label="Out today" value={sum.outToday.length} sub={sum.outToday.length ? names(sum.outToday.map((l) => `${nameOf(l)} · ${TYPE[l.type]}`)) : 'Everyone is in'} />
				<Stat label={`Taken in ${mon}`} value={plural(sum.takenDays, 'day')} sub={plural(sum.takenPeople, 'person').replace('persons', 'people')} />
				{admin && <Stat label="Over the allowance" value={sum.over.length} sub={sum.over.length ? names(sum.over.map((o) => `${o.member.name} · ${plural(o.taken - LEAVE_PER_MONTH, 'day')} deducted`)) : `Nobody over in ${mon}`} tone={sum.over.length ? 'red' : ''} />}
			</div>
			<section className="dcard lv-card" aria-labelledby="lvReq">
				<div className="lv-head">
					<h3 id="lvReq">Leave requests</h3>
					<div className="ra-chips lv-chips" role="group" aria-label="Filter by status">
						{CHIPS.map(([k, l]) => (
							<button key={k || 'all'} type="button" className="ra-chip" aria-pressed={status === k} onClick={() => setStatus(k)}>
								{l} <span className="lv-n">{k ? mine.filter((x) => x.status === k).length : mine.length}</span>
							</button>
						))}
					</div>
					<span className="lv-sp" />
					<select className="lv-pick" value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
						<option value="">Everyone</option>
						{people.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
					{isManager(me) && (
						<button type="button" className="btn primary" onClick={() => setIssuing(true)}>
							+ Issue day off
						</button>
					)}
				</div>
				{rows.length ? (
					<div className="lv-table lv-req" role="table" aria-label="Leave requests">
						<div className="lv-row lv-th" role="row">
							<span role="columnheader">Person</span>
							<span role="columnheader">Type</span>
							<span role="columnheader">Dates</span>
							<span role="columnheader">Days</span>
							<span role="columnheader">Status</span>
							<span role="columnheader">Decision</span>
						</div>
						{rows.map((l) => (
							<Row key={l.id} l={l} />
						))}
					</div>
				) : (
					<p className="d-empty lv-pad">{mine.length ? 'Nothing with this status.' : 'No leave yet.'}</p>
				)}
				<p className="lv-foot">Waiting requests stay on top. Team Members’ requests wait for a Team Leader or the Super Admin; a Team Leader’s leave is approved straight away.</p>
			</section>
			{admin && <Settlement />}
			{issuing && <IssueDayOff onClose={() => setIssuing(false)} />}
		</div>
	);
}

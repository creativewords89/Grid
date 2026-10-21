import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { WEEK, dayChips, holidayOn, holidaysAhead, holidaysOf, monthCells, takenThisMonth, workingDays, yearMonths } from '../../lib/holidays.js';
import { mayDecideLeave, overBy, sortLeave } from '../../lib/leaveBoard.js';
import { addMonths } from '../../lib/pay.js';
import { ALLOWANCE, EMPLOYMENT, FESTIVAL_PER_YEAR, WEEKDAYS, balance, dayOffKind, employmentOf, festivalDays, hasLeave, leavePeople, monthName, teamWeekly, whosOut } from '../../lib/people.js';
import { isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import { LeaveDialog } from '../day/Leave.jsx';
import IssueDayOff from '../team/IssueDayOff.jsx';
import { STATUS, TYPE, leaveActions, rangeText, useLeaveAction } from '../team/leaveParts.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const monthTitle = (month) => `${monthName(month)} ${month.slice(0, 4)}`;

// Daily reports → Holidays (SPEC.md 6.20): the Super Admin and Team Leaders get design HOL-1 (tiles,
// calendar, Waiting for you, Festival holidays, Holiday system, Out today); Team Members HOL-2
// (My leave, calendar, upcoming holidays, their requests, the year). A Team Leader also gets their
// own leave card. ‹ month › and Month / Year sit in the tabs row (`slot`).
export default function Holidays({ slot }) {
	const { me, today } = usePortal();
	const [mode, setMode] = useState('month');
	const [month, setMonth] = useState(today.slice(0, 7));
	const [asking, setAsking] = useState(false);
	const manager = isManager(me);
	const year = +month.slice(0, 4);

	const nav = (
		<div className="hol-nav">
			<div className="hol-seg" role="group" aria-label="Show">
				<button type="button" aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
					Month
				</button>
				<button type="button" aria-pressed={mode === 'year'} onClick={() => setMode('year')}>
					Year
				</button>
			</div>
			<div className="dr-dayrow tg-day">
				<button type="button" className="dr-nav" aria-label={mode === 'month' ? 'Previous month' : 'Previous year'} onClick={() => setMonth(addMonths(month, mode === 'month' ? -1 : -12))}>
					‹
				</button>
				<b className="dr-day" aria-live="polite">
					{mode === 'month' ? monthTitle(month) : year}
				</b>
				<button type="button" className="dr-nav" aria-label={mode === 'month' ? 'Next month' : 'Next year'} onClick={() => setMonth(addMonths(month, mode === 'month' ? 1 : 12))}>
					›
				</button>
			</div>
		</div>
	);

	const calendar = mode === 'month' ? <MonthCalendar month={month} manager={manager} /> : <YearCalendar year={year} manager={manager} onPick={(m) => (setMonth(m), setMode('month'))} />;
	return (
		<div className="hol">
			{slot ? createPortal(nav, slot) : nav}
			{me.role !== 'admin' && <MyLeave year={year} onAsk={() => setAsking(true)} />}
			{manager && <Tiles month={month} year={year} />}
			<div className="hol-main">
				<section className="hol-cal-card" aria-label={mode === 'month' ? monthTitle(month) : String(year)}>
					{calendar}
					<Legend manager={manager} />
				</section>
				<div className="hol-side">
					{manager ? (
						<>
							<Waiting />
							<Festival year={year} />
							<System year={year} />
							<OutToday />
						</>
					) : (
						<>
							<Upcoming year={year} />
							<MyRequests />
							<TakenThisYear year={year} />
						</>
					)}
				</div>
			</div>
			<LeaveDialog open={asking} onClose={() => setAsking(false)} />
		</div>
	);
}

// The four tiles of HOL-1.
function Tiles({ month, year }) {
	const { data, me } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const set = festivalDays(year, daysOff, team);
	const taken = takenThisMonth(month, leaves, data.members, team, daysOff);
	const waiting = leaves.filter((l) => mayDecideLeave(l, me, data)).length;
	return (
		<section className="hol-tiles" aria-label="This month">
			<div>
				<b>
					{set} of {FESTIVAL_PER_YEAR}
				</b>
				<span>festival holiday days set for {year}</span>
			</div>
			<div>
				<b>{workingDays(month, team, daysOff)}</b>
				<span>working days · {team.map((d) => WEEKDAYS[d]).join(', ') || 'no weekly day'} off</span>
			</div>
			<div>
				<b>{taken.days}</b>
				<span>leave days taken · {plural(taken.people, 'person').replace('persons', 'people')}</span>
			</div>
			<div className={waiting ? 'wait' : ''}>
				<b>{waiting}</b>
				<span>{waiting === 1 ? 'request' : 'requests'} waiting for you</span>
			</div>
		</section>
	);
}

// The viewer's own leave (HOL-2): casual and sick days left, festival holidays, the employment.
function MyLeave({ year, onAsk }) {
	const { data, me, today, viewOnly } = usePortal();
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const b = balance(self, year, rowsOf(data, 'leave'), team, daysOff);
	const kind = employmentOf(self);
	const ahead = +today.slice(0, 4) === year ? holidaysAhead(year, daysOff, team, today) : null;
	const ask = !viewOnly && (
		<button type="button" className="btn primary" onClick={onAsk}>
			{hasLeave(self) ? (me.role === 'lead' ? 'Take leave' : 'Request leave') : me.role === 'lead' ? 'Take unpaid leave' : 'Request unpaid leave'}
		</button>
	);
	if (!hasLeave(self)) {
		return (
			<section className="hol-mine none" aria-label="My leave">
				<div className="hol-mine-txt">
					<span className="hol-badge no">{EMPLOYMENT[kind]}</span>
					<h2>You don’t have leave days</h2>
					<p className="muted">Leave days are for Full-Time and Part-Time employees. Any leave you take is unpaid. Festival holidays and the weekly day off are still days off for you.</p>
				</div>
				{ask}
			</section>
		);
	}
	const Bar = ({ label, v, tone }) => (
		<div className="hol-bal">
			<span className="hol-k">
				{label} · {year}
			</span>
			<span className="hol-n">
				<b>{v.left}</b> of {v.allowance} days left
			</span>
			<span className="hol-bar" aria-hidden="true">
				<i className={tone} style={{ width: `${Math.round((v.left / v.allowance) * 100)}%` }} />
			</span>
			{v.over > 0 && <small className="t-red">{plural(v.over, 'day')} over · deducted</small>}
		</div>
	);
	return (
		<section className="hol-mine" aria-label="My leave">
			<Bar label="Casual leave" v={b.day} tone="casual" />
			<Bar label="Sick leave" v={b.sick} tone="sick" />
			<div className="hol-bal">
				<span className="hol-k">Festival holidays</span>
				<span className="hol-n">
					<b>{FESTIVAL_PER_YEAR}</b> days{ahead !== null ? ` · ${ahead} still to come` : ''}
				</span>
			</div>
			<div className="hol-bal hol-year">
				<span className="hol-badge">{EMPLOYMENT[kind]}</span>
				<span>
					<b>{year}</b> · Jan 1 – Dec 31
				</span>
				<span className="muted">Starts again on Jan 1, {year + 1}</span>
			</div>
			{ask}
		</section>
	);
}

// The month from Saturday: festival holidays, leave and requests per person, the weekly day off.
function MonthCalendar({ month, manager }) {
	const { data, me, today } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	return (
		<div className="hol-cal" role="grid" aria-label={`Holidays and leave in ${monthTitle(month)}`}>
			{WEEK.map((w) => (
				<span key={w} className="hol-wd" role="columnheader">
					{w}
				</span>
			))}
			{monthCells(month).map((d, i) => {
				if (!d) return <span key={'b' + i} />;
				const hol = holidayOn(d, daysOff);
				const weekly = !hol && dayOffKind(d, { weekly_off: null }, team, []) === 'weekly';
				const chips = hol || weekly ? [] : dayChips(d, leaves, data.members, me, manager);
				return (
					<div key={d} role="gridcell" className={'hol-day' + (hol ? ' hol-h' : weekly ? ' hol-off' : '') + (d === today ? ' today' : '')} aria-label={`${short(d)}${hol ? ': ' + hol.name : weekly ? ': weekly day off' : chips.length ? ': ' + chips.map((c) => c.label).join(', ') : ''}`}>
						<span className="hol-dn">{+d.slice(8)}</span>
						{hol && <span className="hol-chip h">{hol.name}</span>}
						{weekly && <span className="hol-mute">Weekly off</span>}
						{chips.slice(0, 3).map((c) => (
							<span key={c.id} className={'hol-chip ' + c.tone} title={c.label}>
								{c.label}
							</span>
						))}
						{chips.length > 3 && <span className="hol-mute">+{chips.length - 3} more</span>}
					</div>
				);
			})}
		</div>
	);
}

// The twelve months small: festival holidays and leave as coloured days; a month opens on click.
function YearCalendar({ year, manager, onPick }) {
	const { data, me, today } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	return (
		<div className="hol-year-grid">
			{yearMonths(year).map((m) => (
				<button key={m} type="button" className="hol-mini" onClick={() => onPick(m)} aria-label={`Open ${monthTitle(m)}`}>
					<b>{monthName(m)}</b>
					<span className="hol-mini-grid" aria-hidden="true">
						{monthCells(m).map((d, i) => {
							if (!d) return <i key={'b' + i} />;
							const hol = holidayOn(d, daysOff);
							const weekly = !hol && dayOffKind(d, { weekly_off: null }, team, []) === 'weekly';
							const chips = hol || weekly ? [] : dayChips(d, leaves, data.members, me, manager);
							const tone = hol ? 'h' : weekly ? 'off' : chips.some((c) => c.tone === 'you') ? 'you' : chips.length ? (chips.some((c) => c.tone === 'asked') ? 'asked' : 'casual') : '';
							return <i key={d} className={tone + (d === today ? ' today' : '')} />;
						})}
					</span>
				</button>
			))}
		</div>
	);
}

function Legend({ manager }) {
	return (
		<p className="hol-legend">
			<span>
				<i className="hol-chip h">Holiday</i> festival holiday
			</span>
			{manager ? (
				<>
					<span>
						<i className="hol-chip casual">Casual</i> approved
					</span>
					<span>
						<i className="hol-chip sick">Sick</i> approved
					</span>
					<span>
						<i className="hol-chip asked">Asked</i> waiting for approval
					</span>
				</>
			) : (
				<>
					<span>
						<i className="hol-chip you">You</i> your leave
					</span>
					<span>
						<i className="hol-chip out">Name out</i> a teammate is off (no reason shown)
					</span>
				</>
			)}
		</p>
	);
}

// Requests the viewer may decide (Approve / Reject) and + Issue day off.
function Waiting() {
	const { data, me, viewOnly } = usePortal();
	const act = useLeaveAction();
	const [issuing, setIssuing] = useState(false);
	const rows = sortLeave(rowsOf(data, 'leave').filter((l) => mayDecideLeave(l, me, data)));
	return (
		<section className={'hol-box' + (rows.length ? ' wait' : '')} aria-label="Waiting for you">
			<h2>Waiting for you · {rows.length}</h2>
			{rows.length === 0 && <p className="muted">Nothing to decide.</p>}
			{rows.map((l) => {
				const who = data.members[l.member_id];
				const over = overBy(data, l);
				return (
					<div key={l.id} className="hol-req">
						<span>
							<b>{who.name}</b> · {TYPE[l.type]}
						</span>
						<small className="muted">
							{rangeText(l)} · {plural(l.days, 'day')}
							{l.reason ? ` · “${l.reason}”` : ''}
						</small>
						{over > 0 && <small className="t-amber">{plural(over, 'day')} over the allowance · deducted</small>}
						{!viewOnly && (
							<div className="hol-acts">
								<button type="button" className="btn small primary" onClick={() => act(l, 'approve')}>
									Approve
								</button>
								<button type="button" className="btn small" onClick={() => act(l, 'reject')}>
									Reject
								</button>
							</div>
						)}
					</div>
				);
			})}
			{!viewOnly && (
				<button type="button" className="btn small hol-issue" onClick={() => setIssuing(true)}>
					+ Issue day off
				</button>
			)}
			{issuing && <IssueDayOff onClose={() => setIssuing(false)} />}
		</section>
	);
}

// Festival holidays of the year; the Super Admin adds (HOL-3) and removes them.
function Festival({ year }) {
	const { api, data, dispatch, me, toast, confirm, viewOnly } = usePortal();
	const [adding, setAdding] = useState(false);
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const list = holidaysOf(year, daysOff, team);
	const set = festivalDays(year, daysOff, team);
	const admin = isAdmin(me) && !viewOnly;
	const remove = async (o) => {
		if (!(await confirm({ title: `Remove ${o.name}?`, message: 'It becomes a working day again.', ok: 'Remove', danger: true }))) return;
		try {
			await api.del(`days-off/${o.id}`);
			dispatch({ type: 'remove', table: 'days_off', id: o.id });
			toast(`${o.name} removed`);
		} catch (err) {
			toast(err.message);
		}
	};
	return (
		<section className="hol-box" aria-label="Festival holidays">
			<div className="hol-box-h">
				<h2>Festival holidays {year}</h2>
				{admin && (
					<button type="button" className="btn small primary" onClick={() => setAdding(true)} disabled={set >= FESTIVAL_PER_YEAR}>
						+ Add holiday
					</button>
				)}
			</div>
			{list.length === 0 && <p className="muted">No festival holidays yet.</p>}
			{list.map((o) => (
				<div key={o.id} className="hol-li">
					<span className="hol-date">
						<b>{+o.from_date.slice(8)}</b>
						<small>{monthName(o.from_date.slice(0, 7)).slice(0, 3).toUpperCase()}</small>
					</span>
					<span className="hol-li-t">
						<b>{o.name}</b>
						<small className="muted">
							{o.from_date === o.to_date ? WEEKDAYS[new Date(o.from_date + 'T00:00:00Z').getUTCDay()] : rangeText(o)} · {plural(o.days, 'day')}
						</small>
					</span>
					{admin && (
						<button type="button" className="linkbtn danger" aria-label={`Remove ${o.name}`} onClick={() => remove(o)}>
							✕
						</button>
					)}
				</div>
			))}
			<small className="muted">
				{set} of {FESTIVAL_PER_YEAR} days set{set < FESTIVAL_PER_YEAR ? ` · ${FESTIVAL_PER_YEAR - set} left to add` : ''} · Weekly day off: <b>{team.map((d) => WEEKDAYS[d]).join(', ') || 'none'}</b>
			</small>
			{adding && <AddHoliday year={year} onClose={() => setAdding(false)} />}
		</section>
	);
}

// + Add holiday (HOL-3): name, one day or a few days, the dates; the count against the 13 days.
export function AddHoliday({ year, onClose }) {
	const { api, data, dispatch, toast, today } = usePortal();
	const start = String(year) === today.slice(0, 4) ? today : `${year}-01-01`;
	const [form, setForm] = useState({ name: '', many: false, from: start, to: start });
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const to = form.many && form.to > form.from ? form.to : form.from;
	const y = +form.from.slice(0, 4);
	const days = form.from ? festivalDays(y, [{ from_date: form.from, to_date: to }], team) : 0;
	const after = form.from ? festivalDays(y, [...daysOff, { from_date: form.from, to_date: to }], team) : 0;
	const submit = async (e) => {
		e.preventDefault();
		if (!form.name.trim()) return setError('Give the holiday a name.');
		if (to.slice(0, 4) !== form.from.slice(0, 4)) return setError('A holiday must end in the year it starts.');
		if (after > FESTIVAL_PER_YEAR) return setError(`That makes ${after} festival holiday days in ${y}; the limit is ${FESTIVAL_PER_YEAR} a year.`);
		setBusy(true);
		try {
			const row = await api.post('days-off', { kind: form.many ? 'seasonal' : 'event', name: form.name.trim(), from: form.from, to });
			dispatch({ type: 'upsert', table: 'days_off', row });
			toast(`${row.name} added`);
			onClose();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="grpHoliday">
			<form onSubmit={submit} noValidate>
				<h2 id="grpHoliday">Add a festival holiday</h2>
				<label>
					Name
					<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={191} placeholder="e.g. Durga Puja" aria-label="Name" />
				</label>
				<div className="hol-seg" role="group" aria-label="How long">
					<button type="button" aria-pressed={!form.many} onClick={() => setForm({ ...form, many: false })}>
						One day
					</button>
					<button type="button" aria-pressed={form.many} onClick={() => setForm({ ...form, many: true })}>
						A few days
					</button>
				</div>
				<div className="row">
					<label>
						{form.many ? 'From' : 'Date'}
						<input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} aria-label={form.many ? 'From' : 'Date'} />
					</label>
					{form.many && (
						<label>
							To
							<input type="date" value={to} min={form.from} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="To" />
						</label>
					)}
				</div>
				<p className="lv-sum" aria-live="polite">
					{plural(days, 'day')} off for everyone · nobody’s leave is used · {Math.min(after, 99)} of {FESTIVAL_PER_YEAR} festival days set for {y} after this
				</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy}>
						Add holiday
					</button>
				</div>
			</form>
		</Modal>
	);
}

// Holiday system · {year}: the rules, everyone's days left, and (Super Admin) the employment picker.
function System({ year }) {
	const { api, data, dispatch, me, toast, viewOnly } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const people = leavePeople(data).sort((a, b) => a.name.localeCompare(b.name));
	const withLeave = people.filter(hasLeave);
	const without = people.filter((p) => !hasLeave(p));
	const admin = isAdmin(me) && !viewOnly;
	const setKind = async (p, employment) => {
		try {
			dispatch({ type: 'upsert', table: 'members', row: await api.patch(`members/${p.id}`, { employment }) });
			toast(`${p.name} is now ${EMPLOYMENT[employment]}`);
		} catch (err) {
			toast(err.message);
		}
	};
	const Pick = ({ p }) =>
		admin ? (
			<select className="hol-pick" value={employmentOf(p)} onChange={(e) => setKind(p, e.target.value)} aria-label={`Employment of ${p.name}`}>
				{Object.entries(EMPLOYMENT).map(([k, v]) => (
					<option key={k} value={k}>
						{v}
					</option>
				))}
			</select>
		) : (
			<span className="hol-badge sm">{EMPLOYMENT[employmentOf(p)]}</span>
		);
	return (
		<section className="hol-box" aria-label="Holiday system">
			<h2>Holiday system · {year}</h2>
			<p className="muted hol-rule">
				Calendar year <b>Jan 1 – Dec 31</b> · everything starts again on Jan 1, {year + 1}. Full-Time and Part-Time employees get <b>{ALLOWANCE.day} casual</b> and <b>{ALLOWANCE.sick} sick</b> leave days a year; unused days are paid with December’s salary. Festival holidays ({FESTIVAL_PER_YEAR} days) and the weekly day off are for everyone.
			</p>
			{withLeave.length > 0 && (
				<div className="hol-sys" role="table" aria-label={`Leave left in ${year}`}>
					<div className="hol-sys-r hol-sys-h" role="row">
						<span role="columnheader">Left in {year}</span>
						<span role="columnheader">Casual</span>
						<span role="columnheader">Sick</span>
					</div>
					{withLeave.map((p) => {
						const b = balance(p, year, leaves, team, daysOff);
						return (
							<div key={p.id} className="hol-sys-r" role="row">
								<span role="cell" className="hol-who">
									<Avatar person={p} small />
									<span>
										<span className="hol-nm" title={p.name}>
											{p.name}
										</span>
										<Pick p={p} />
									</span>
								</span>
								<b role="cell" className={b.day.over ? 't-red' : ''}>
									{b.day.left}/{b.day.allowance}
								</b>
								<b role="cell" className={b.sick.over ? 't-red' : ''}>
									{b.sick.left}/{b.sick.allowance}
								</b>
							</div>
						);
					})}
				</div>
			)}
			{without.length > 0 && (
				<div className="hol-none">
					<span className="hol-badge no">No leave days · {without.length}</span>
					{without.map((p) => (
						<div key={p.id} className="hol-none-r">
							<span className="hol-who">
								<Avatar person={p} small />
								<span>
									<b>{p.name}</b>
									<small className="muted">{p.created_at ? `Joined ${short(p.created_at.slice(0, 10))} · ` : ''}leave is deducted</small>
								</span>
							</span>
							<Pick p={p} />
						</div>
					))}
				</div>
			)}
		</section>
	);
}

// Who is out today (6.10): approved leave or a day off.
function OutToday() {
	const { data, me, today } = usePortal();
	const out = whosOut(today, leavePeople(data), rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'), me.id);
	return (
		<section className="hol-box" aria-label="Out today">
			<h2>Out today · {short(today)}</h2>
			{out.length === 0 && <p className="muted">Everyone is in today.</p>}
			{out.map((o) => (
				<span key={o.member.id} className="hol-out">
					<b>{o.member.name}</b> · {o.why === 'leave' ? 'on leave' : 'day off'} · back {short(o.back)}
				</span>
			))}
		</section>
	);
}

// Team Members: the year's festival holidays still to come and the weekly day off.
function Upcoming({ year }) {
	const { data, today } = usePortal();
	const team = teamWeekly(data);
	const list = holidaysOf(year, rowsOf(data, 'days_off'), team).filter((o) => o.to_date >= today);
	return (
		<section className="hol-box" aria-label="Upcoming holidays">
			<h2>Upcoming holidays</h2>
			{list.length === 0 && <p className="muted">No more festival holidays in {year}.</p>}
			{list.map((o) => (
				<div key={o.id} className="hol-li">
					<span className="hol-date">
						<b>{+o.from_date.slice(8)}</b>
						<small>{monthName(o.from_date.slice(0, 7)).slice(0, 3).toUpperCase()}</small>
					</span>
					<span className="hol-li-t">
						<b>{o.name}</b>
						<small className="muted">
							{rangeText(o)} · {plural(o.days, 'day')}
						</small>
					</span>
				</div>
			))}
			<small className="muted">
				Weekly day off: <b>{team.map((d) => WEEKDAYS[d]).join(', ') || 'none'}</b>
			</small>
		</section>
	);
}

// The viewer's own requests, newest first, Cancel while allowed.
function MyRequests() {
	const { data, me } = usePortal();
	const act = useLeaveAction();
	const rows = sortLeave(rowsOf(data, 'leave').filter((l) => l.member_id === me.id)).slice(0, 6);
	return (
		<section className="hol-box" aria-label="My requests">
			<h2>My requests</h2>
			{rows.length === 0 && <p className="muted">No leave yet.</p>}
			{rows.map((l) => {
				const [st, cls] = STATUS[l.status] || [l.status, 'f-plain'];
				const cancel = leaveActions(l, me, data.members[me.id]).includes('cancel');
				return (
					<div key={l.id} className="hol-li">
						<span className="hol-li-t">
							<b>{TYPE[l.type]}</b>
							<small className="muted">
								{rangeText(l)} · {plural(l.days, 'day')}
							</small>
						</span>
						<span className={'mp-flag ' + cls}>{st}</span>
						{cancel && l.status === 'pending' && (
							<button type="button" className="linkbtn" onClick={() => act(l, 'cancel')}>
								Cancel
							</button>
						)}
					</div>
				);
			})}
		</section>
	);
}

// Taken in {year}: casual, sick, over the allowance.
function TakenThisYear({ year }) {
	const { data, me } = usePortal();
	const self = data.members[me.id] || me;
	const b = balance(self, year, rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'));
	const over = b.day.over + b.sick.over;
	return (
		<section className="hol-box" aria-label="Taken this year">
			<h2>Taken in {year}</h2>
			<div className="hol-kv">
				<span>Casual leave</span>
				<b>
					{b.day.taken} of {b.day.allowance}
				</b>
			</div>
			<div className="hol-kv">
				<span>Sick leave</span>
				<b>
					{b.sick.taken} of {b.sick.allowance}
				</b>
			</div>
			<div className="hol-kv">
				<span>Over the allowance</span>
				<b className={over ? 't-red' : 'muted'}>{over ? `${plural(over, 'day')} · deducted` : '0 days · nothing deducted'}</b>
			</div>
		</section>
	);
}

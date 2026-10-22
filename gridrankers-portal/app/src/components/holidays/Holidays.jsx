import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { WEEK, dayChips, holidayOn, holidaysOf, monthCells, takenThisMonth, workingDays, yearMonths } from '../../lib/holidays.js';
import { mayDecideLeave, overBy, sortLeave } from '../../lib/leaveBoard.js';
import { addMonths } from '../../lib/pay.js';
import { EMPLOYMENT, WEEKDAYS, balance, dayOffKind, employmentOf, festivalDays, firstYearSince, hasLeave, leaveDays, leavePeople, leaveRules, MAX_LEAVE_DAYS, monthName, teamWeekly, whosOut, yearDays } from '../../lib/people.js';
import Balances, { RequestDialog } from './Balances.jsx';
import { isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import IssueDayOff from '../team/IssueDayOff.jsx';
import { STATUS, TYPE, leaveActions, rangeText, useLeaveAction } from '../team/leaveParts.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const monthTitle = (month) => `${monthName(month)} ${month.slice(0, 4)}`;

// Daily reports → Holidays (SPEC.md 6.20): the Super Admin and Team Leaders get design HOL-1 (tiles,
// calendar, Waiting for you, Festival holidays, Out today); Team Members HOL-2 (My leave, calendar,
// upcoming holidays, their requests, the year). A Team Leader also gets their own leave card.
// ‹ month › and Month / Year sit in the tabs row (`slot`). Holiday system is in Admin settings.
export default function Holidays({ slot, scope }) {
	const { data, me, today, viewOnly } = usePortal();
	const [mode, setMode] = useState('month');
	const [month, setMonth] = useState(today.slice(0, 7));
	const [asking, setAsking] = useState(false);
	// Days picked on the calendar for a request (HOL-6): {from, to}.
	const [plan, setPlan] = useState(null);
	// A Team Leader sees their own leave (scope `mine`, design TL-B: My holidays) and the team's
	// (scope `team`: Team holidays) on separate tabs; others get one tab with their view.
	const manager = scope === 'mine' ? false : isManager(me);
	const takes = scope === 'team' ? false : me.role !== 'admin';
	const ownOnly = scope === 'mine';
	const self = data.members[me.id] || me;
	const picked = plan ? Object.values(leaveDays(plan.from, plan.to, self, teamWeekly(data), rowsOf(data, 'days_off'))).reduce((a, n) => a + n, 0) : 0;
	const pickDay = (d) =>
		setPlan((p) => (!p || p.to !== p.from || d < p.from ? { from: d, to: d } : d === p.from ? null : { from: p.from, to: d }));
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

	const calendar =
		mode === 'month' ? (
			<MonthCalendar month={month} manager={manager} ownOnly={ownOnly} plan={plan} onDay={takes && !viewOnly ? pickDay : null} />
		) : <YearCalendar year={year} manager={manager} ownOnly={ownOnly} onPick={(m) => (setMonth(m), setMode('month'))} />;
	return (
		<div className="hol">
			{slot ? createPortal(nav, slot) : nav}
			{takes && <Balances year={year} onAsk={() => setAsking(true)} picked={picked} />}
			{manager && <Tiles month={month} year={year} />}
			<div className="hol-main">
				<section className="hol-cal-card" aria-label={mode === 'month' ? monthTitle(month) : String(year)}>
					{calendar}
					<Legend manager={manager} ownOnly={ownOnly} picks={takes && !viewOnly} />
				</section>
				<div className="hol-side">
					{manager ? (
						<>
							<Waiting />
							<Festival year={year} />
							<OutToday />
						</>
					) : (
						<MyRequests />
					)}
				</div>
			</div>
			{asking && <RequestDialog plan={plan} setPlan={setPlan} onClose={() => setAsking(false)} />}
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
	const limit = yearDays(leaveRules(data), year).festival;
	const taken = takenThisMonth(month, leaves, data.members, team, daysOff);
	const waiting = leaves.filter((l) => mayDecideLeave(l, me, data)).length;
	return (
		<section className="hol-tiles" aria-label="This month">
			<div>
				<b>
					{set} of {limit}
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

// The month from Saturday: festival holidays, leave and requests per person, the weekly day off.
// The viewer's own leave days are outlined in their colour; working days from today on can be tapped
// to fill in Request leave (HOL-6); days before someone's leave year started (HOL-5B) are marked.
function MonthCalendar({ month, manager, ownOnly, plan, onDay }) {
	const { data, me, today } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const self = data.members[me.id] || me;
	const since = firstYearSince(self, month.slice(0, 4));
	const mine = leaves.filter((l) => l.member_id === me.id && (l.status === 'approved' || l.status === 'pending'));
	const cells = monthCells(month);
	return (
		<div className="hol-cal" role="grid" aria-label={`Holidays and leave in ${monthTitle(month)}`}>
			{WEEK.map((w) => (
				<span key={w} className="hol-wd" role="columnheader">
					{w}
				</span>
			))}
			{cells.map((d, i) => {
				if (!d) return <span key={'b' + i} />;
				const hol = holidayOn(d, daysOff);
				const weekly = !hol && dayOffKind(d, { weekly_off: null }, team, []) === 'weekly';
				const chips = hol || weekly ? [] : dayChips(d, leaves, data.members, me, manager).filter((c) => !ownOnly || c.tone !== 'out');
				const own = mine.find((l) => d >= l.from_date && d <= l.to_date);
				const ownType = own ? (own.type === 'sick' ? 'sick' : 'day') : null;
				const match = !manager && !!own && !hol && !weekly;
				const pre = since && d < since;
				const planned = plan && d >= plan.from && d <= plan.to && !hol && !weekly;
				const pickable = onDay && !hol && !weekly && !own && d >= today;
				const cls = ['hol-day', hol ? 'hol-h' : weekly ? 'hol-off' : '', d === today ? 'today' : '', match ? 'hl t-' + ownType : '', pre ? 'pre' : '', planned ? 'plan' : '', pickable ? 'pick' : ''].filter(Boolean).join(' ');
				const label = `${short(d)}${hol ? ': ' + hol.name : weekly ? ': weekly day off' : chips.length ? ': ' + chips.map((c) => c.label).join(', ') : ''}${pre ? ', before you joined' : ''}${planned ? ', planned' : ''}`;
				const body = (
					<>
						<span className="hol-dn">{+d.slice(8)}</span>
						{hol && <span className="hol-chip h">{hol.name}</span>}
						{weekly && <span className="hol-mute">Weekly off</span>}
						{pre && !hol && !weekly && <span className="hol-mute">Before you joined</span>}
						{chips.slice(0, 3).map((c) => (
							<span key={c.id} className={'hol-chip ' + c.tone} title={c.label}>
								{c.label}
							</span>
						))}
						{chips.length > 3 && <span className="hol-mute">+{chips.length - 3} more</span>}
						{planned && <span className="hol-chip plan">Picked</span>}
					</>
				);
				return pickable ? (
					<button key={d} type="button" role="gridcell" className={cls} aria-label={label} aria-pressed={!!planned} onClick={() => onDay(d)}>
						{body}
					</button>
				) : (
					<div key={d} role="gridcell" className={cls} aria-label={label}>
						{body}
					</div>
				);
			})}
		</div>
	);
}

// Plan a day off (HOL-4): the days picked on the calendar, how many count, what is left after,

// The twelve months small: festival holidays and leave as coloured days; a month opens on click.
function YearCalendar({ year, manager, ownOnly, onPick }) {
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
							const chips = hol || weekly ? [] : dayChips(d, leaves, data.members, me, manager).filter((c) => !ownOnly || c.tone !== 'out');
							const tone = hol ? 'h' : weekly ? 'off' : chips.some((c) => c.tone === 'you') ? 'you' : chips.length ? (chips.some((c) => c.tone === 'asked') ? 'asked' : 'casual') : '';
							return <i key={d} className={tone + (d === today ? ' today' : '')} />;
						})}
					</span>
				</button>
			))}
		</div>
	);
}

function Legend({ manager, ownOnly, picks }) {
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
					{!ownOnly && (
						<span>
							<i className="hol-chip out">Name out</i> a teammate is off (no reason shown)
						</span>
					)}
				</>
			)}
			{picks && (
				<span>
					<i className="hol-chip plan">Picked</i> tap days to plan leave, then Request leave
				</span>
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
	const limit = yearDays(leaveRules(data), year).festival;
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
					<button type="button" className="btn small primary" onClick={() => setAdding(true)} disabled={set >= limit}>
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
				{set} of {limit} days set{set < limit ? ` · ${limit - set} left to add` : ''} · Weekly day off: <b>{team.map((d) => WEEKDAYS[d]).join(', ') || 'none'}</b>
			</small>
			{adding && <AddHoliday year={year} onClose={() => setAdding(false)} />}
		</section>
	);
}

// + Add holiday (HOL-3): name, one day or a few days, the dates; the count against the year's festival days.
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
	const limit = yearDays(leaveRules(data), y || year).festival;
	const submit = async (e) => {
		e.preventDefault();
		if (!form.name.trim()) return setError('Give the holiday a name.');
		if (to.slice(0, 4) !== form.from.slice(0, 4)) return setError('A holiday must end in the year it starts.');
		if (after > limit) return setError(`That makes ${after} festival holiday days in ${y}; the limit is ${limit} a year.`);
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
					{plural(days, 'day')} off for everyone · nobody’s leave is used · {Math.min(after, 99)} of {limit} festival days set for {y} after this
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

const KINDS = [
	['day', 'Casual leave', 'Full-Time and Part-Time'],
	['sick', 'Sick leave', 'Full-Time and Part-Time'],
	['festival', 'Festival holidays', 'Most festival days that can be added in a year'],
];

// Leave days a year (design HOL-10, Super Admin): casual, sick and festival days with − / +; a
// change says what it does, starts this year or on Jan 1 next year, and is saved or undone.
function LeaveDays({ year }) {
	const { api, data, dispatch, me, toast, viewOnly } = usePortal();
	const rules = leaveRules(data);
	const [start, setStart] = useState(year);
	const was = yearDays(rules, start);
	const [f, setF] = useState(was);
	const [busy, setBusy] = useState(false);
	const admin = isAdmin(me) && !viewOnly;
	const changed = KINDS.filter(([k]) => +f[k] !== +was[k]);
	const later = rules.filter((r) => r.from_year > year);
	const put = (k, v) => setF({ ...f, [k]: Math.max(0, Math.min(MAX_LEAVE_DAYS, Math.round(+v || 0))) });
	const save = async () => {
		setBusy(true);
		try {
			const res = await api.put('settings/leave-days', { ...f, from_year: start });
			dispatch({ type: 'upsert', table: 'settings', row: res.setting });
			toast(start === year ? `Leave days saved for ${year}` : `Leave days saved from Jan 1, ${start}`);
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};
	const delta = changed.find(([k]) => k !== 'festival');
	return (
		<section className="dcard hol-days" aria-label="Leave days a year">
			<div className="dc-head">
				<span className="s-k">Leave days a year</span>
				<span className="muted">{admin ? 'Only the Super Admin can change these' : `${year}`}</span>
			</div>
			<div className="hol-days-k">
				{KINDS.map(([k, title, sub]) => (
					<div key={k} className={'hol-step t-' + k}>
						<b>
							<i className="bal-dot" aria-hidden="true" />
							{title}
						</b>
						<span className="hol-step-r">
							{admin && (
								<button type="button" className="btn small" aria-label={`Fewer ${title.toLowerCase()} days`} onClick={() => put(k, f[k] - 1)} disabled={f[k] <= 0}>
									−
								</button>
							)}
							<input type="number" min="0" max={MAX_LEAVE_DAYS} value={f[k]} readOnly={!admin} onChange={(e) => put(k, e.target.value)} aria-label={`${title} days a year`} />
							{admin && (
								<button type="button" className="btn small" aria-label={`More ${title.toLowerCase()} days`} onClick={() => put(k, f[k] + 1)} disabled={f[k] >= MAX_LEAVE_DAYS}>
									+
								</button>
							)}
							<span className="muted">days a year</span>
						</span>
						<small className="muted">
							{sub}
							{+f[k] !== +was[k] ? ` · was ${was[k]}` : ''}
						</small>
					</div>
				))}
			</div>
			{admin && (
				<div className={'hol-days-bar' + (changed.length ? ' on' : '')}>
					<span>
						{changed.length ? (
							<b>{changed.map(([k, title]) => `${title} ${was[k]} → ${f[k]}`).join(' · ')}.</b>
						) : (
							'Change a number to save it.'
						)}{' '}
						Starts
					</span>
					<div className="hol-seg" role="group" aria-label="Starts">
						<button type="button" aria-pressed={start === year} onClick={() => setStart(year)}>
							This year ({year})
						</button>
						<button type="button" aria-pressed={start === year + 1} onClick={() => setStart(year + 1)}>
							From Jan 1, {year + 1}
						</button>
					</div>
					<small className="muted hol-grow">
						{delta && start === year
							? `Everyone with leave gets ${Math.abs(f[delta[0]] - was[delta[0]])} ${f[delta[0]] > was[delta[0]] ? 'more' : 'fewer'} ${delta[1].toLowerCase()} days this year; people in their first year are prorated from their Effective from month.`
							: start === year
								? `Counts for all of ${year}.`
								: `${year} stays as it is.`}
					</small>
					<button type="button" className="btn" onClick={() => setF(was)} disabled={!changed.length}>
						Undo
					</button>
					<button type="button" className="btn primary" onClick={save} disabled={busy || !changed.length}>
						Save
					</button>
				</div>
			)}
			{later.map((r) => (
				<small key={r.from_year} className="muted">
					From Jan 1, {r.from_year}: {r.day} casual · {r.sick} sick · {r.festival} festival
				</small>
			))}
		</section>
	);
}

// What a person's Effective from means for `year`: "Oct – Dec · 3 months", "Full year" or "From …".
function countsFor(p, year) {
	const since = p.employment_since || '';
	if (!since || +since.slice(0, 4) < year) return ['Full year', false];
	if (+since.slice(0, 4) > year) return [`From ${short(since)}`, true];
	const months = 13 - +since.slice(5, 7);
	return months === 12 ? ['Full year', false] : [`${monthName(since.slice(0, 7)).slice(0, 3)} – Dec · ${plural(months, 'month')}`, true];
}

// Team → Settings → Holiday system · {year} (Super Admin): the leave days a year (HOL-10), then
// everyone's employment, Effective from (HOL-9A), the months it counts for and the days left.
export function HolidaySystem() {
	const { api, data, dispatch, me, toast, today, viewOnly } = usePortal();
	const year = +today.slice(0, 4);
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const rules = leaveRules(data);
	const days = yearDays(rules, year);
	const people = leavePeople(data).sort((a, b) => a.name.localeCompare(b.name));
	const withLeave = people.filter(hasLeave);
	const without = people.filter((p) => !hasLeave(p));
	const admin = isAdmin(me) && !viewOnly;
	const patch = async (p, body, done) => {
		try {
			dispatch({ type: 'upsert', table: 'members', row: await api.patch(`members/${p.id}`, body) });
			toast(done);
		} catch (err) {
			toast(err.message);
		}
	};
	const Pick = ({ p }) =>
		admin ? (
			<select className="hol-pick" value={employmentOf(p)} onChange={(e) => patch(p, { employment: e.target.value }, `${p.name} is now ${EMPLOYMENT[e.target.value]}`)} aria-label={`Employment of ${p.name}`}>
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
		<>
			<LeaveDays key={JSON.stringify(rules)} year={year} />
			<section className="dcard hol-settings" aria-label="Holiday system">
				<div className="dc-head">
					<span className="s-k">Holiday system · {year}</span>
				</div>
				<p className="muted hol-rule">
					Calendar year <b>Jan 1 – Dec 31</b> · everything starts again on Jan 1, {year + 1}. Full-Time and Part-Time employees get <b>{days.day} casual</b> and <b>{days.sick} sick</b> leave days a year, <b>counted from the month their leave starts</b>: someone who starts in October gets Oct – Dec only. Unused days are paid with December’s salary. Festival holidays ({days.festival} days) and the weekly day off are for everyone.
				</p>
				{withLeave.length > 0 && (
					<div className="hol-sys" role="table" aria-label={`Leave left in ${year}`}>
						<div className="hol-sys-r hol-sys-h" role="row">
							<span role="columnheader">Person</span>
							<span role="columnheader">Employment</span>
							<span role="columnheader">Effective from</span>
							<span role="columnheader">Leave counts for</span>
							<span role="columnheader">Casual</span>
							<span role="columnheader">Sick</span>
						</div>
						{withLeave.map((p) => {
							const b = balance(p, year, leaves, team, daysOff, rules);
							const [span, part] = countsFor(p, year);
							return (
								<div key={p.id} className={'hol-sys-r' + (part ? ' part' : '')} role="row">
									<span role="cell" className="hol-who">
										<Avatar person={p} small />
										<span className="hol-nm" title={p.name}>
											{p.name}
										</span>
									</span>
									<span role="cell">
										<Pick p={p} />
									</span>
									<span role="cell">
										{admin ? (
											<input
												type="date"
												className="hol-pick"
												value={p.employment_since || ''}
												onChange={(e) => patch(p, { employment_since: e.target.value }, e.target.value ? `${p.name}’s leave counts from ${short(e.target.value)}` : `${p.name}’s leave counts for the full year`)}
												aria-label={`Effective from for ${p.name}`}
											/>
										) : (
											<span>{p.employment_since ? short(p.employment_since) : '—'}</span>
										)}
									</span>
									<span role="cell" className={part ? 't-accent' : 'muted'}>
										{span}
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
				{admin && withLeave.length > 0 && <small className="muted">Changing someone to Full-Time or Part-Time sets Effective from to today; pick another date if they started earlier or later. Days count from that month to December, half days rounded up.</small>}
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
		</>
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


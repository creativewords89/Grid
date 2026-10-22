import { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { WEEK, dayChips, holidayOn, holidaysAhead, holidaysOf, monthCells, takenThisMonth, workingDays, yearMonths } from '../../lib/holidays.js';
import { mayDecideLeave, overBy, sortLeave } from '../../lib/leaveBoard.js';
import { addMonths } from '../../lib/pay.js';
import { ALLOWANCE, EMPLOYMENT, FESTIVAL_PER_YEAR, WEEKDAYS, balance, dayOffKind, employmentOf, festivalDays, firstYearSince, hasLeave, leaveDays, leavePeople, monthName, teamWeekly, whosOut } from '../../lib/people.js';
import Balances, { KIND } from './Balances.jsx';
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
// calendar, Waiting for you, Festival holidays, Out today); Team Members HOL-2 (My leave, calendar,
// upcoming holidays, their requests, the year). A Team Leader also gets their own leave card.
// ‹ month › and Month / Year sit in the tabs row (`slot`). Holiday system is in Admin settings.
export default function Holidays({ slot, scope }) {
	const { me, today, viewOnly } = usePortal();
	const [mode, setMode] = useState('month');
	const [month, setMonth] = useState(today.slice(0, 7));
	const [asking, setAsking] = useState(false);
	const [askKey, setAskKey] = useState(0);
	// The balance card shown (HOL-4): day (casual), sick, both, fest, or none; and days picked to plan.
	const [focus, setFocus] = useState('day');
	const [plan, setPlan] = useState(null);
	// A Team Leader sees their own leave (scope `mine`, design TL-B: My holidays) and the team's
	// (scope `team`: Team holidays) on separate tabs; others get one tab with their view.
	const manager = scope === 'mine' ? false : isManager(me);
	const takes = scope === 'team' ? false : me.role !== 'admin';
	const ownOnly = scope === 'mine';
	const ask = () => (setAskKey((k) => k + 1), setAsking(true));
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
			<MonthCalendar month={month} manager={manager} ownOnly={ownOnly} focus={takes ? focus : null} plan={plan} onDay={takes && !viewOnly ? pickDay : null} />
		) : <YearCalendar year={year} manager={manager} ownOnly={ownOnly} onPick={(m) => (setMonth(m), setMode('month'))} />;
	return (
		<div className="hol">
			{slot ? createPortal(nav, slot) : nav}
			{takes && <Balances year={year} focus={focus} setFocus={setFocus} onAsk={ask} />}
			{manager && <Tiles month={month} year={year} />}
			<div className="hol-main">
				<section className="hol-cal-card" aria-label={mode === 'month' ? monthTitle(month) : String(year)}>
					{calendar}
					<Legend manager={manager} ownOnly={ownOnly} focus={takes ? focus : null} />
				</section>
				<div className="hol-side">
					{takes && !viewOnly && <PlanBox plan={plan} type={focus === 'sick' ? 'sick' : 'day'} onClear={() => setPlan(null)} onAsk={ask} />}
					{manager ? (
						<>
							<Waiting />
							<Festival year={year} />
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
			<LeaveDialog key={askKey} open={asking} onClose={() => (setAsking(false), setPlan(null))} initial={plan ? { ...plan, type: focus === 'sick' ? 'sick' : 'day' } : null} />
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

// The month from Saturday: festival holidays, leave and requests per person, the weekly day off.
// With a balance card selected (HOL-4) the viewer's own days of that kind stand out and the rest
// fade; working days from today on can be picked to plan a day off; days before someone's leave
// year started (HOL-5) are marked.
function MonthCalendar({ month, manager, ownOnly, focus, plan, onDay }) {
	const { data, me, today } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const self = data.members[me.id] || me;
	const since = firstYearSince(self, month.slice(0, 4));
	const mine = leaves.filter((l) => l.member_id === me.id && (l.status === 'approved' || l.status === 'pending'));
	const cells = monthCells(month);
	const matches = (d) => {
		if (!d || !focus) return false;
		const hol = holidayOn(d, daysOff);
		if (focus === 'fest') return !!hol;
		const own = mine.find((l) => d >= l.from_date && d <= l.to_date);
		return !!own && !hol && dayOffKind(d, { weekly_off: null }, team, []) !== 'weekly' && (focus === 'both' || focus === (own.type === 'sick' ? 'sick' : 'day'));
	};
	// Fade the other days only when this month has some of the selected kind.
	const fade = cells.some(matches);
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
				const match = matches(d);
				const pre = since && d < since;
				const planned = plan && d >= plan.from && d <= plan.to && !hol && !weekly;
				const pickable = onDay && !hol && !weekly && !own && d >= today;
				const cls = ['hol-day', hol ? 'hol-h' : weekly ? 'hol-off' : '', d === today ? 'today' : '', fade && !match ? 'dim' : '', match ? 'hl t-' + (focus === 'fest' ? 'fest' : ownType) : '', pre ? 'pre' : '', planned ? 'plan' : '', pickable ? 'pick' : ''].filter(Boolean).join(' ');
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
						{planned && <span className="hol-chip plan">Planned</span>}
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
// and Request these days (the leave dialog, filled in).
function PlanBox({ plan, type, onClear, onAsk }) {
	const { data, me } = usePortal();
	const self = data.members[me.id] || me;
	if (!plan) {
		return (
			<section className="hol-box hol-plan" aria-label="Plan a day off">
				<h2>Plan a day off</h2>
				<p className="muted">Tap a day on the calendar (and another for a few days) to see what’s left before you ask.</p>
			</section>
		);
	}
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const n = Object.values(leaveDays(plan.from, plan.to, self, team, daysOff)).reduce((a, b) => a + b, 0);
	const year = +plan.from.slice(0, 4);
	const b = balance(self, year, leaves, team, daysOff)[type];
	const waiting = leaves.filter((l) => l.member_id === me.id && l.status === 'pending' && (l.type === 'sick' ? 'sick' : 'day') === type).reduce((a, l) => a + (+l.days || 0), 0);
	const after = b.left - waiting - n;
	return (
		<section className="hol-box hol-plan on" aria-label="Plan a day off">
			<h2>Plan a day off</h2>
			<div className="hol-kv">
				<span>
					{plan.from === plan.to ? short(plan.from) : `${short(plan.from)} – ${short(plan.to)}`} · {type === 'sick' ? 'sick' : 'casual'}
				</span>
				<b>{plural(n, 'day')}</b>
			</div>
			<div className="hol-kv">
				<span>{type === 'sick' ? 'Sick' : 'Casual'} left after</span>
				<b className={after < 0 ? 't-red' : 't-' + type}>{after < 0 ? `${-after} over · deducted` : `${after} of ${b.allowance}`}</b>
			</div>
			<div className="hol-acts">
				<button type="button" className="btn small primary" onClick={onAsk} disabled={!n}>
					Request these days
				</button>
				<button type="button" className="btn small" onClick={onClear}>
					Clear
				</button>
			</div>
		</section>
	);
}

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

function Legend({ manager, ownOnly, focus }) {
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
			{focus && <span>· {focus === 'fest' ? 'festival holidays' : KIND[focus].toLowerCase()} stand out, other days fade</span>}
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

// Team → Settings → Holiday system · {year} (Super Admin): the rules, everyone's days left this year
// and the employment picker.
export function HolidaySystem() {
	const { api, data, dispatch, me, toast, today, viewOnly } = usePortal();
	const year = +today.slice(0, 4);
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
		<section className="dcard hol-settings" aria-label="Holiday system">
			<div className="dc-head">
				<span className="s-k">Holiday system · {year}</span>
			</div>
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

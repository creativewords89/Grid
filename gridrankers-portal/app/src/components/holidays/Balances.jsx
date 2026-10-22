import { useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { festivalCounts } from '../../lib/holidays.js';
import { dayPay, money } from '../../lib/pay.js';
import { EMPLOYMENT, balance, employmentOf, firstYearSince, hasLeave, leaveDays, leaveRules, teamWeekly, yearDays } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day's pay of the viewer, from their pay (SPEC.md 6.19); 0 when it isn't loaded.
function useDayPay() {
	const { pay } = usePortal();
	const salary = pay && pay.state && pay.state.pay ? +pay.state.pay.salary : 0;
	return salary ? dayPay(salary) : 0;
}

// One ring (design HOL-8B2): the days left of the year's total, the name and what is used under it.
function Ring({ k, title, total, used, usedWord }) {
	const left = Math.max(0, total - used);
	const c = 2 * Math.PI * 34;
	return (
		<section className={'bal-ring t-' + k} aria-label={title}>
			<svg viewBox="0 0 86 86" aria-hidden="true">
				<circle cx="43" cy="43" r="34" className="bal-ring-bg" />
				<circle cx="43" cy="43" r="34" className="bal-ring-on" strokeDasharray={`${total ? (c * left) / total : 0} ${c}`} transform="rotate(-90 43 43)" />
			</svg>
			<span className="bal-ring-n">
				<b>{left}</b>
				<small>of {total} left</small>
			</span>
			<b className="bal-ring-t">{title}</b>
			<small className="muted">
				{used} {usedWord}
			</small>
		</section>
	);
}

// Festival holidays: the year's festival days for everyone (in a first year, the ones after
// `since`); used = the ones already passed.
function FestivalRing({ year, since }) {
	const { data, today } = usePortal();
	const team = teamWeekly(data);
	const fest = festivalCounts(year, rowsOf(data, 'days_off'), team, today, since);
	// A first year counts only the festival holidays after they joined.
	const total = since ? fest.total : yearDays(leaveRules(data), year).festival;
	return <Ring k="fest" title="Festival holidays" total={total} used={Math.min(total, fest.taken.reduce((a, n) => a + n, 0))} usedWord="passed" />;
}

// The viewer's numbers (design HOL-8B2): three rings — Casual leave, Sick leave, Festival holidays,
// days left of the year's total — then what December pays for the days not taken and + Request
// leave. Someone in their first year (HOL-5B) sees why their days are fewer.
export default function Balances({ year, onAsk, picked }) {
	const { data, me, today, viewOnly } = usePortal();
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const rules = leaveRules(data);
	const each = useDayPay();
	const kind = employmentOf(self);
	const lead = me.role === 'lead';
	const ask = !viewOnly && (
		<button type="button" className="btn primary" onClick={onAsk}>
			+ {hasLeave(self) ? (lead ? 'Take leave' : 'Request leave') : lead ? 'Take unpaid leave' : 'Request unpaid leave'}
			{picked ? ` · ${plural(picked, 'day')} picked` : ''}
		</button>
	);
	if (!hasLeave(self)) {
		return (
			<section className="hol-mine none" aria-label="My leave">
				<div className="hol-mine-txt">
					<span className="hol-badge no">{EMPLOYMENT[kind]}</span>
					<h2>You don’t have leave days</h2>
					<p className="muted">Leave days are for Full-Time and Part-Time employees. Any leave you take is unpaid. Festival holidays and the weekly day off are still days off for you.</p>
					{ask}
				</div>
				<FestivalRing year={year} />
			</section>
		);
	}
	const since = firstYearSince(self, year);
	const b = balance(self, year, rowsOf(data, 'leave'), team, daysOff, rules);
	const fest = festivalCounts(year, daysOff, team, today, since);
	const days = b.day.left + b.sick.left;
	return (
		<div className="bal">
			{since && <FirstYear since={since} year={year} kind={kind} full={yearDays(rules, year)} next={yearDays(rules, year + 1)} days={{ day: b.day.allowance, sick: b.sick.allowance, fest: fest.total }} />}
			<section className="bal-rings" aria-label="My leave">
				<Ring k="day" title="Casual leave" total={b.day.allowance} used={b.day.taken} usedWord="taken" />
				<Ring k="sick" title="Sick leave" total={b.sick.allowance} used={b.sick.taken} usedWord="taken" />
				<FestivalRing year={year} since={since} />
				<div className="bal-pay" role="region" aria-label="Your balance if not taken">
					<span className="muted">Not taken by December 31?</span>
					<b>+{each ? `${money(days * each)} BDT` : plural(days, 'day')}</b>
					<small className="muted">
						paid with December salary{each ? ` · ${b.day.left} casual + ${b.sick.left} sick × ${money(each)}` : ''}
					</small>
					{b.day.over + b.sick.over > 0 && <small className="t-red">{plural(b.day.over + b.sick.over, 'day')} over · deducted from salary</small>}
					{ask}
				</div>
			</section>
		</div>
	);
}

// HOL-5B: the first year counts from the day leave started — the year as a timeline with "You
// joined", one square per day off this year out of a full year's, and this year next to next year.
function FirstYear({ since, year, kind, days, full: all, next }) {
	const first = +since.slice(5, 7) - 1;
	const months = 12 - first;
	// The marker sits over the start of the joining month.
	const at = `${((first + (+since.slice(8) - 1) / 31) / 12) * 100}%`;
	const Meter = ({ k, label, got, full, how }) => (
		<div className="ft-meter">
			<div className="ft-meter-h">
				<b>{label}</b>
				<span className="muted">{how}</span>
				<span className="hol-grow" />
				<b className={'ft-got t-' + k}>{got}</b>
				<span className="muted">of {full} a full year</span>
			</div>
			<span className={'ft-sq t-' + k} aria-label={`${got} of ${full}`}>
				{Array.from({ length: full }, (_, n) => (
					<i key={n} className={n < got ? 'on' : ''} />
				))}
			</span>
		</div>
	);
	const half = (full) => `${full} × ${months}/12 = ${+((full * months) / 12).toFixed(2)}${(full * months) % 12 ? ` → ${Math.floor((full * months) / 12 + 0.5)}` : ''}`;
	return (
		<>
			<section className="ft" aria-label={`Your ${year}`}>
				<div className="ft-h">
					<b>Your {year} at GridRankers</b>
					<span className="hol-badge">{EMPLOYMENT[kind]}</span>
				</div>
				<p className="muted">Leave is for the months you’re here. Each square is one day you can take off.</p>
				<div className="ft-line">
					<span className="ft-pin" style={{ left: at }}>
						<b>You joined · {short(since)}</b>
					</span>
					<span className="ft-months">
						{MONTHS.map((m, i) => (
							<span key={m} className={i >= first ? 'on' : ''}>
								<i />
								{m}
							</span>
						))}
					</span>
				</div>
				<div className="ft-foot muted">
					<span>Jan 1 · {first ? 'not counted for you' : 'counted'}</span>
					<span>
						<b>
							{months} {months === 1 ? 'month' : 'months'} counted
						</b>{' '}
						· Dec 31
					</span>
				</div>
			</section>
			<section className="ft ft-meters" aria-label="Days this year">
				<Meter k="day" label="Casual leave" got={days.day} full={all.day} how={half(all.day)} />
				<Meter k="sick" label="Sick leave" got={days.sick} full={all.sick} how={half(all.sick)} />
				<Meter k="fest" label="Festival holidays" got={days.fest} full={all.festival} how={`only the ones after ${short(since)}`} />
			</section>
			<div className="ft-years">
				<div>
					<span className="hol-k">This year · {year}</span>
					<span>
						<b>{days.day}</b> casual · <b>{days.sick}</b> sick · <b>{days.fest}</b> festival
					</span>
					<small className="muted">Unused days are paid with December salary.</small>
				</div>
				<div className="next">
					<span className="hol-k">From Jan 1, {year + 1}</span>
					<span>
						<b>{next.day}</b> casual · <b>{next.sick}</b> sick · <b>{next.festival}</b> festival
					</span>
					<small className="muted">The full year, like everyone on the team.</small>
				</div>
			</div>
		</>
	);
}

// Request leave (HOL-8B2): a pop-up with only the type of leave, From – To (the days tapped on the
// calendar already filled in), a reason if there is one and Send request. The server counts and
// checks again.
export function RequestDialog({ plan, setPlan, onClose }) {
	const { api, data, dispatch, me, today, toast } = usePortal();
	const self = data.members[me.id] || me;
	const [type, setType] = useState('day');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const from = (plan && plan.from) || '';
	const to = (plan && plan.to) || from;
	const n = from ? Object.values(leaveDays(from, to < from ? from : to, self, teamWeekly(data), rowsOf(data, 'days_off'))).reduce((a, x) => a + x, 0) : 0;
	const lead = me.role === 'lead';
	const title = hasLeave(self) ? (lead ? 'Take leave' : 'Request leave') : lead ? 'Take unpaid leave' : 'Request unpaid leave';
	const set = (k, v) => {
		setError('');
		setPlan(k === 'from' ? { from: v, to: !to || to < v ? v : to } : { from: from || v, to: v });
	};
	const send = async (e) => {
		e.preventDefault();
		if (!from) return setError('Pick the first day.');
		if (!n) return setError('Those days are all days off already.');
		setBusy(true);
		try {
			const row = await api.post('leave', { type, from, to, reason: reason.trim() });
			dispatch({ type: 'upsert', table: 'leave', row });
			toast(lead ? 'Leave taken — approved straight away' : 'Leave requested — your Team Leaders will answer');
			setPlan(null);
			onClose();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="grpRequestLeave">
			<form className="bal-req" onSubmit={send} noValidate>
				<h2 id="grpRequestLeave">{title}</h2>
				<label>
					Type of leave
					<select value={type} onChange={(e) => setType(e.target.value)}>
						<option value="day">Casual leave</option>
						<option value="sick">Sick leave</option>
					</select>
				</label>
				<div className="bal-dates">
					<label>
						From
						<input type="date" value={from} min={today} onChange={(e) => set('from', e.target.value)} aria-label="From" />
					</label>
					<label>
						To
						<input type="date" value={to} min={from || today} onChange={(e) => set('to', e.target.value)} aria-label="To" />
					</label>
				</div>
				<label>
					Reason (optional)
					<input type="text" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy || !n}>
						{lead ? 'Take leave' : 'Send request'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

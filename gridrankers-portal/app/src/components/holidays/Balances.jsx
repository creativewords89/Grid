import { useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { festivalCounts, holidaysOf, monthCounts } from '../../lib/holidays.js';
import { dayPay, money } from '../../lib/pay.js';
import { EMPLOYMENT, FESTIVAL_PER_YEAR, balance, employmentOf, firstYearSince, hasLeave, leaveDays, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A day's pay of the viewer, from their pay (SPEC.md 6.19); 0 when it isn't loaded.
function useDayPay() {
	const { pay } = usePortal();
	const salary = pay && pay.state && pay.state.pay ? +pay.state.pay.salary : 0;
	return salary ? dayPay(salary) : 0;
}

// One balance card: total, taken and left, with a bar and a line under it.
function Card({ k, title, year, total, taken, foot }) {
	const left = Math.max(0, total - taken);
	return (
		<section className={'bal-card t-' + k} aria-label={title}>
			<span className="hol-k">
				<i className="bal-dot" aria-hidden="true" />
				{title} · {year}
			</span>
			<div className="bal-nums">
				<span>
					<b>{total}</b>
					<small>total</small>
				</span>
				<span>
					<b>{taken}</b>
					<small>taken</small>
				</span>
				<span className="left">
					<b>{left}</b>
					<small>left</small>
				</span>
			</div>
			<span className="bal-track" aria-hidden="true">
				<i style={{ width: `${total ? Math.min(100, Math.round((taken / total) * 100)) : 0}%` }} />
			</span>
			<span className="bal-foot">{foot}</span>
		</section>
	);
}

// Festival holidays: 13 a year for everyone; taken = the ones already passed (from `since` in a
// first year).
function FestivalCard({ year, since }) {
	const { data, today } = usePortal();
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const fest = festivalCounts(year, daysOff, team, today, since);
	const taken = Math.min(FESTIVAL_PER_YEAR, fest.taken.reduce((a, n) => a + n, 0));
	const next = holidaysOf(year, daysOff, team).find((o) => o.to_date >= today);
	return <Card k="fest" title="Festival holidays" year={year} total={FESTIVAL_PER_YEAR} taken={taken} foot={`Off for everyone${next ? ` · next: ${next.name}, ${short(next.from_date)}` : ''}`} />;
}

// The viewer's numbers (design HOL-6): Casual leave, Sick leave and Festival holidays — total,
// taken and left for the year, nothing to click. Festival holidays are 13 a year; taken = the
// ones already passed. Someone in their first year (HOL-5B) sees why their days are fewer.
export default function Balances({ year, onAsk }) {
	const { data, me, today, viewOnly } = usePortal();
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const kind = employmentOf(self);
	if (!hasLeave(self)) {
		return (
			<section className="hol-mine none" aria-label="My leave">
				<div className="hol-mine-txt">
					<span className="hol-badge no">{EMPLOYMENT[kind]}</span>
					<h2>You don’t have leave days</h2>
					<p className="muted">Leave days are for Full-Time and Part-Time employees. Any leave you take is unpaid. Festival holidays and the weekly day off are still days off for you.</p>
				</div>
				{!viewOnly && (
					<button type="button" className="btn primary" onClick={onAsk}>
						{me.role === 'lead' ? 'Take unpaid leave' : 'Request unpaid leave'}
					</button>
				)}
				<div className="bal-cards">
					<FestivalCard year={year} />
				</div>
			</section>
		);
	}
	const since = firstYearSince(self, year);
	const b = balance(self, year, leaves, team, daysOff);
	const fest = festivalCounts(year, daysOff, team, today, since);
	const reset = `Starts again on Jan 1, ${year + 1}`;
	const prorated = since ? ` · prorated since ${short(since)}` : '';
	return (
		<div className="bal">
			{since && <FirstYear since={since} year={year} kind={kind} days={{ day: b.day.allowance, sick: b.sick.allowance, fest: fest.total }} />}
			<div className="bal-cards" aria-label="My leave" role="region">
				<Card k="day" title="Casual leave" year={year} total={b.day.allowance} taken={b.day.taken} foot={b.day.over ? `${plural(b.day.over, 'day')} over · deducted from salary` : reset + prorated} />
				<Card k="sick" title="Sick leave" year={year} total={b.sick.allowance} taken={b.sick.taken} foot={b.sick.over ? `${plural(b.sick.over, 'day')} over · deducted from salary` : reset + prorated} />
				<FestivalCard year={year} since={since} />
			</div>
		</div>
	);
}

// HOL-5B: the first year counts from the day leave started — the year as a timeline with "You
// joined", one square per day off this year out of a full year's, and this year next to next year.
function FirstYear({ since, year, kind, days }) {
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
				<Meter k="day" label="Casual leave" got={days.day} full={10} how={half(10)} />
				<Meter k="sick" label="Sick leave" got={days.sick} full={14} how={half(14)} />
				<Meter k="fest" label="Festival holidays" got={days.fest} full={FESTIVAL_PER_YEAR} how={`only the ones after ${short(since)}`} />
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
						<b>10</b> casual · <b>14</b> sick · <b>{FESTIVAL_PER_YEAR}</b> festival
					</span>
					<small className="muted">The full year, like everyone on the team.</small>
				</div>
			</div>
		</>
	);
}

// Your balance if not taken (HOL-6): the casual and sick days left in money, paid with December
// salary when nothing more is taken.
export function BalanceBox({ year }) {
	const { data, me } = usePortal();
	const self = data.members[me.id] || me;
	const each = useDayPay();
	if (!hasLeave(self)) return null;
	const b = balance(self, year, rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'));
	const days = b.day.left + b.sick.left;
	const amount = (n) => (each ? `${money(n * each)} BDT` : plural(n, 'day'));
	return (
		<section className="hol-box bal-money" aria-label="Your balance if not taken">
			<h2>Your balance if not taken</h2>
			<p className="muted">Unused days are paid with December salary{each ? ` (1 day = ${money(each)} BDT)` : ''}.</p>
			<div className="hol-kv">
				<span>Casual · {plural(b.day.left, 'day')} left</span>
				<b>{amount(b.day.left)}</b>
			</div>
			<div className="hol-kv">
				<span>Sick · {plural(b.sick.left, 'day')} left</span>
				<b>{amount(b.sick.left)}</b>
			</div>
			<div className="bal-total">
				<span>With December salary if nothing more is taken</span>
				<b>{each ? money(days * each) : days}</b>
			</div>
		</section>
	);
}

// Request leave (HOL-6): type, From – To (or the days tapped on the calendar), the days counted,
// what is left after and the December pay-out after; Send request. The server counts and checks again.
export function RequestBox({ plan, setPlan }) {
	const { api, data, dispatch, me, today, toast } = usePortal();
	const self = data.members[me.id] || me;
	const each = useDayPay();
	const [type, setType] = useState('day');
	const [reason, setReason] = useState('');
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const from = (plan && plan.from) || '';
	const to = (plan && plan.to) || from;
	const n = from ? Object.values(leaveDays(from, to < from ? from : to, self, team, daysOff)).reduce((a, x) => a + x, 0) : 0;
	const paid = hasLeave(self);
	const year = +(from || today).slice(0, 4);
	const b = balance(self, year, leaves, team, daysOff);
	const waiting = monthCounts(self, year, leaves, team, daysOff, [type]).waiting.reduce((a, x) => a + x, 0);
	const left = b[type].left - waiting - n;
	const unused = Math.max(0, b.day.left - (type === 'day' ? waiting + n : 0)) + Math.max(0, b.sick.left - (type === 'sick' ? waiting + n : 0));
	const lead = me.role === 'lead';
	const set = (k, v) => {
		setError('');
		setPlan(k === 'from' ? { from: v, to: !to || to < v ? v : to } : { from: from || v, to: v });
	};
	const send = async () => {
		if (!from) return setError('Pick the first day.');
		if (!n) return setError('Those days are all days off already.');
		setBusy(true);
		try {
			const row = await api.post('leave', { type, from, to, reason });
			dispatch({ type: 'upsert', table: 'leave', row });
			toast(lead ? 'Leave taken — approved straight away' : 'Leave requested — your Team Leaders will answer');
			setPlan(null);
			setReason('');
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="hol-box hol-plan on" aria-label="Request leave">
			<h2>{paid ? (lead ? 'Take leave' : 'Request leave') : lead ? 'Take unpaid leave' : 'Request unpaid leave'}</h2>
			<div className="hol-seg" role="group" aria-label="Leave type">
				<button type="button" aria-pressed={type === 'day'} onClick={() => setType('day')}>
					Casual
				</button>
				<button type="button" aria-pressed={type === 'sick'} onClick={() => setType('sick')}>
					Sick
				</button>
			</div>
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
			<small className="muted">or tap the days on the calendar</small>
			<input className="bal-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} placeholder="Reason (optional)" aria-label="Reason (optional)" />
			<div className="hol-kv">
				<span>Days counted</span>
				<b>{n}</b>
			</div>
			{paid && (
				<div className="hol-kv">
					<span>{type === 'sick' ? 'Sick' : 'Casual'} left after</span>
					<b className={left < 0 ? 't-red' : 't-' + type}>{left < 0 ? `${-left} over · deducted` : `${left} of ${b[type].allowance}`}</b>
				</div>
			)}
			{paid && each > 0 && (
				<div className="hol-kv">
					<span>December pay-out after</span>
					<b className="t-pay">{money(unused * each)} BDT</b>
				</div>
			)}
			<p className="err" role="alert">
				{error}
			</p>
			<button type="button" className="btn primary" onClick={send} disabled={busy || !n}>
				{lead ? 'Take leave' : 'Send request'}
			</button>
		</section>
	);
}

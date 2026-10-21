import { useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { festivalCounts, holidaysOf, monthCounts, runsOf } from '../../lib/holidays.js';
import { dayPay, money } from '../../lib/pay.js';
import { EMPLOYMENT, FESTIVAL_PER_YEAR, allowance, balance, employmentOf, firstYearSince, hasLeave, monthName, teamWeekly } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import { leaveActions, useLeaveAction } from '../team/leaveParts.jsx';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const range = (from, to) => (from === to ? short(from) : `${short(from)} – ${short(to)}`);
export const KIND = { day: 'Casual leave', sick: 'Sick leave', both: 'Casual and sick leave', fest: 'Festival holidays' };

// The ring of a balance card: days left of the year's allowance.
function Ring({ left, total, tone }) {
	const r = 34;
	const c = 2 * Math.PI * r;
	return (
		<svg className="bal-ring" width="78" height="78" viewBox="0 0 86 86" aria-hidden="true">
			<circle cx="43" cy="43" r={r} fill="none" className="bal-track" strokeWidth="10" />
			<circle cx="43" cy="43" r={r} fill="none" className={'bal-arc ' + tone} strokeWidth="10" strokeLinecap="round" strokeDasharray={`${total ? (c * left) / total : 0} ${c}`} transform="rotate(-90 43 43)" />
			<text x="43" y="42" textAnchor="middle" className="bal-ring-n">
				{left}
			</text>
			<text x="43" y="58" textAnchor="middle" className="bal-ring-s">
				of {total} left
			</text>
		</svg>
	);
}

// The viewer's balances (design HOL-4): Casual, Sick and Festival cards; the selected one opens its
// month-by-month detail below. Someone in their first year (HOL-5) sees why their days are fewer.
export default function Balances({ year, focus, setFocus, onAsk }) {
	const { data, me, today, viewOnly } = usePortal();
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const kind = employmentOf(self);
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
	const since = firstYearSince(self, year);
	const b = balance(self, year, leaves, team, daysOff);
	const pending = monthCounts(self, year, leaves, team, daysOff, ['day', 'sick']).days.filter((d) => d.status === 'pending');
	const waitingOf = (type) => pending.filter((d) => d.type === type).length;
	const fest = festivalCounts(year, daysOff, team, today, since);
	const festLeft = fest.waiting.reduce((a, n) => a + n, 0);
	const next = holidaysOf(year, daysOff, team).find((o) => o.to_date >= today);
	const pick = (k) => setFocus(focus === k ? null : k);
	const Card = ({ k, title, left, total, lines, note }) => (
		<button type="button" className={'bal-card t-' + k + (focus === k || (focus === 'both' && k !== 'fest') ? ' on' : '')} aria-pressed={focus === k} onClick={() => pick(k)}>
			<Ring left={left} total={total} tone={k} />
			<span className="bal-txt">
				<span className="hol-k">
					{title} · {year}
				</span>
				<b className="bal-big">{plural(left, 'day')} left</b>
				{lines.map((l) => (
					<small key={l}>{l}</small>
				))}
				{note && <span className={'bal-note t-' + k}>{note}</span>}
			</span>
			<span className="bal-see">{focus === k ? 'Showing ▾' : 'See days ›'}</span>
		</button>
	);
	const prorated = since ? `Prorated · since ${short(since)}` : '';
	return (
		<section className="bal" aria-label="My leave">
			{since && <FirstYear since={since} year={year} kind={kind} days={{ day: b.day.allowance, sick: b.sick.allowance, fest: fest.total }} />}
			<div className="bal-head">
				{!since && <span className="hol-badge">{EMPLOYMENT[kind]}</span>}
				{!since && (
					<span className="muted">
						<b>{year}</b> · Jan 1 – Dec 31 · starts again on Jan 1, {year + 1}
					</span>
				)}
				<span className="hol-grow" />
				{ask}
			</div>
			<div className="bal-cards">
				<Card k="day" title="Casual leave" left={b.day.left} total={b.day.allowance} lines={[`${b.day.taken} taken${waitingOf('day') ? ` · ${waitingOf('day')} waiting` : ''}${b.day.over ? ` · ${b.day.over} over` : ''}`, 'Unused days paid with December salary']} note={prorated} />
				<Card k="sick" title="Sick leave" left={b.sick.left} total={b.sick.allowance} lines={[`${b.sick.taken} taken${waitingOf('sick') ? ` · ${waitingOf('sick')} waiting` : ''}${b.sick.over ? ` · ${b.sick.over} over` : ''}`, `Resets on Jan 1, ${year + 1}`]} note={prorated} />
				<Card
					k="fest"
					title="Festival holidays"
					left={festLeft}
					total={since ? fest.total : FESTIVAL_PER_YEAR}
					lines={[`${fest.total - festLeft} passed${next ? ` · next: ${next.name}, ${short(next.from_date)}` : ''}`, 'Off for everyone']}
					note={since ? `${FESTIVAL_PER_YEAR - fest.total > 0 ? `${FESTIVAL_PER_YEAR - fest.total} were before you joined` : ''}` : ''}
				/>
			</div>
			{focus && <Detail year={year} focus={focus} setFocus={setFocus} since={since} />}
		</section>
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

// The selected card's year, month by month: day blocks per month (approved solid, waiting
// dashed), the running total against the allowance (red above it: deducted), the selected month's
// days and the December pay-out.
function Detail({ year, focus, setFocus, since }) {
	const { data, me, today, pay } = usePortal();
	const act = useLeaveAction();
	const self = data.members[me.id] || me;
	const team = teamWeekly(data);
	const daysOff = rowsOf(data, 'days_off');
	const leaves = rowsOf(data, 'leave');
	const thisYear = +today.slice(0, 4);
	const now = year === thisYear ? +today.slice(5, 7) - 1 : year < thisYear ? 11 : -1;
	const [picked, setPicked] = useState(Math.max(0, now));
	const fest = focus === 'fest';
	const types = focus === 'both' ? ['day', 'sick'] : [focus];
	const counts = fest ? festivalCounts(year, daysOff, team, today, since) : monthCounts(self, year, leaves, team, daysOff, types);
	const limit = fest ? (since ? counts.total : FESTIVAL_PER_YEAR) : types.reduce((a, t) => a + allowance(self, t, year), 0);
	const taken = counts.taken.reduce((a, n) => a + n, 0);
	const waiting = counts.waiting.reduce((a, n) => a + n, 0);
	const free = Math.max(0, limit - taken - waiting);
	const salary = pay && pay.state && pay.state.pay ? +pay.state.pay.salary : 0;
	const each = salary ? dayPay(salary) : 0;
	const runs = fest ? [] : runsOf(counts.days);
	const inMonth = (r) => +r.from.slice(5, 7) - 1 === picked || +r.to.slice(5, 7) - 1 === picked;
	const holidays = fest ? holidaysOf(year, daysOff, team).filter((o) => +o.from_date.slice(5, 7) - 1 === picked || +o.to_date.slice(5, 7) - 1 === picked) : [];
	const title = fest ? 'Festival holidays' : KIND[focus];

	return (
		<section className={'bal-detail t-' + focus} aria-label={`${title} in ${year}`}>
			<div className="bal-d-main">
				<div className="bal-d-h">
					<b>{title} · month by month</b>
					<span className="hol-grow" />
					{!fest && (
						<div className="hol-seg" role="group" aria-label="Leave type">
							{[
								['day', 'Casual'],
								['sick', 'Sick'],
								['both', 'Both'],
							].map(([k, l]) => (
								<button key={k} type="button" aria-pressed={focus === k} onClick={() => setFocus(k)}>
									{l}
								</button>
							))}
						</div>
					)}
				</div>
				<div className="bal-tiles">
					<div>
						<b>{taken}</b>
						<span>{fest ? 'passed' : 'taken'}</span>
					</div>
					<div className="w">
						<b>{waiting}</b>
						<span>{fest ? 'still to come' : 'waiting'}</span>
					</div>
					{!fest && (
						<div className="f">
							<b>{free}</b>
							<span>free after it</span>
						</div>
					)}
					{!fest && (
						<div className="p">
							<b>{each ? money(free * each) : free}</b>
							<span>{each ? 'BDT paid in December if unused' : 'days paid in December if unused'}</span>
						</div>
					)}
				</div>
				<MonthChart taken={counts.taken} waiting={counts.waiting} limit={limit} now={now} picked={picked} onPick={setPicked} fest={fest} since={since} />
				<p className="bal-legend">
					<span>
						<i className="sq" /> {fest ? 'holiday day passed' : '1 approved day'}
					</span>
					<span>
						<i className="sq w" /> {fest ? 'to come' : 'waiting'}
					</span>
					<span>
						<i className="ln" /> running total
					</span>
					{!fest && (
						<span>
							<i className="ln lim" /> yearly allowance
						</span>
					)}
					<span>· tap a month to see its days</span>
				</p>
			</div>
			<div className="bal-d-side">
				<div className="bal-month">
					<div className="bal-month-h">
						<b>
							{monthName(`${year}-${String(picked + 1).padStart(2, '0')}`)} · {plural(counts.taken[picked] + counts.waiting[picked], 'day')}
						</b>
						<span className="hol-k">Selected month</span>
					</div>
					{fest
						? holidays.map((o) => (
								<div key={o.id} className={'bal-run' + (o.to_date < today ? '' : ' w')}>
									<span>{range(o.from_date, o.to_date)}</span>
									<span>{o.name}</span>
								</div>
							))
						: runs.filter(inMonth).map((r) => (
								<div key={r.leave.id + r.from} className={'bal-run' + (r.status === 'pending' ? ' w' : '')}>
									<span>
										{range(r.from, r.to)}
										{focus === 'both' ? ` · ${r.type === 'sick' ? 'sick' : 'casual'}` : ''}
										{r.leave.reason ? ` · “${r.leave.reason}”` : ''}
									</span>
									<span className={r.status === 'pending' ? 't-amber' : 't-green'}>
										{plural(r.n, 'day')} · {r.status === 'pending' ? 'waiting' : 'approved'}
										{r.status === 'pending' && leaveActions(r.leave, me, self).includes('cancel') && (
											<>
												{' · '}
												<button type="button" className="linkbtn" onClick={() => act(r.leave, 'cancel')}>
													Cancel
												</button>
											</>
										)}
									</span>
								</div>
							))}
					{(fest ? holidays.length : runs.filter(inMonth).length) === 0 && <p className="muted">Nothing this month.</p>}
				</div>
				{!fest && runs.filter((r) => !inMonth(r)).length > 0 && (
					<div className="bal-other">
						<span className="hol-k">Other months</span>
						{runs
							.filter((r) => !inMonth(r))
							.map((r) => (
								<div key={r.leave.id + r.from} className="hol-kv">
									<span>{range(r.from, r.to)}</span>
									<span className="muted">
										{plural(r.n, 'day')} · {r.status === 'pending' ? 'waiting' : 'approved'}
									</span>
								</div>
							))}
					</div>
				)}
				{!fest && (
					<p className="bal-pay">
						{each ? (
							<>
								If nothing else is taken: <b>
									{free} × {money(each)} = {money(free * each)} BDT
								</b>{' '}
								with December salary. Going past {limit}: each extra day is <b className="t-red">− {money(each)} BDT</b> in the month you take it.
							</>
						) : (
							<>
								Unused days are paid with December salary; days past {limit} are deducted in the month you take them.
							</>
						)}
					</p>
				)}
			</div>
		</section>
	);
}

// Jan–Dec: a block per day (solid, or dashed when waiting / still to come), the running total and
// the allowance line with the "deducted" zone above it. A month opens when tapped.
export function MonthChart({ taken, waiting, limit, now, picked, onPick, fest, since }) {
	const W = 640;
	const H = 230;
	const [left, right, top, bottom] = [34, 14, 18, 40];
	const cw = (W - left - right) / 12;
	let run = 0;
	const totals = taken.map((t, i) => (run += t + waiting[i]));
	const ymax = Math.max(limit, run, 4) + 1;
	const py = (v) => top + (H - top - bottom) * (1 - v / ymax);
	const bw = Math.min(26, cw - 14);
	const first = since ? +since.slice(5, 7) - 1 : 0;
	const upto = now < 0 ? -1 : now;
	const pts = totals.slice(first, upto + 1).map((v, k) => [left + (first + k) * cw + cw / 2, py(v)]);
	const ticks = [0, Math.round(limit / 2), limit].filter((v, i, a) => a.indexOf(v) === i);
	return (
		<div className="bal-chart">
			<svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Days per month, running total ${run} of ${limit}`}>
				{!fest && <rect x={left} y={top} width={W - left - right} height={Math.max(0, py(limit) - top)} className="bal-over" />}
				{!fest && (
					<text x={W - right - 4} y={top + 12} textAnchor="end" className="bal-over-t">
						Over the allowance → deducted
					</text>
				)}
				{ticks.map((v) => (
					<g key={v}>
						<line x1={left} x2={W - right} y1={py(v)} y2={py(v)} className="bal-grid" />
						<text x={left - 8} y={py(v) + 4} textAnchor="end" className="bal-axis">
							{v}
						</text>
					</g>
				))}
				<line x1={left} x2={W - right} y1={py(limit)} y2={py(limit)} className={'bal-limit' + (fest ? ' fest' : '')} />
				<text x={left + 4} y={py(limit) - 5} className={'bal-limit-t' + (fest ? ' fest' : '')}>
					{fest ? `${limit} festival days` : `Allowance ${limit}`}
				</text>
				{MONTHS.map((m, i) => {
					const x = left + i * cw;
					const n = taken[i] + waiting[i];
					const before = i < first;
					return (
						<g
							key={m}
							className={'bal-col' + (i === picked ? ' picked' : '') + (before ? ' before' : '')}
							role="button"
							tabIndex={0}
							aria-label={`${m}: ${n} ${n === 1 ? 'day' : 'days'}`}
							aria-pressed={i === picked}
							onClick={() => onPick(i)}
							onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(i))}
						>
							<rect x={x + 2} y={py(limit) + 2} width={cw - 4} height={H - bottom + 22 - py(limit) - 2} rx="8" className="bal-hit" />
							{Array.from({ length: n }, (_, k) => (
								<rect key={k} x={x + (cw - bw) / 2} y={py(k + 1) + 1} width={bw} height={Math.max(2, py(k) - py(k + 1) - 2)} rx="3" className={k < taken[i] ? 'bal-day' : 'bal-day w'} />
							))}
							{n > 0 && (
								<text x={x + (cw + bw) / 2 + 4} y={py(n) + 9} className="bal-n">
									{n}
								</text>
							)}
							<text x={x + cw / 2} y={H - bottom + 16} textAnchor="middle" className={'bal-m' + (i <= upto ? ' past' : '')}>
								{m}
							</text>
							{i === now && (
								<text x={x + cw / 2} y={H - bottom + 30} textAnchor="middle" className="bal-now">
									NOW
								</text>
							)}
						</g>
					);
				})}
				{pts.length > 0 && <path d={pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x},${y}`).join(' ')} className="bal-run-ln" />}
				{pts.map(([x, y]) => (
					<circle key={x} cx={x} cy={y} r="3" className="bal-pt" />
				))}
				{pts.length > 0 && upto < 11 && <line x1={pts[pts.length - 1][0]} y1={pts[pts.length - 1][1]} x2={left + 11 * cw + cw / 2} y2={py(run)} className="bal-ahead" />}
				{pts.length > 0 && (
					<text x={pts[pts.length - 1][0] - 10} y={pts[pts.length - 1][1] - 9} textAnchor="end" className="bal-so-far">
						{totals[upto] ?? run} of {limit} {fest ? 'so far' : 'used so far'}
					</text>
				)}
			</svg>
		</div>
	);
}

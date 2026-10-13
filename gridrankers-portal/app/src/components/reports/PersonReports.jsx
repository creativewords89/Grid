import { useEffect, useMemo, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { ROLE } from '../../lib/roles.js';
import { dayTitle, monthDays, shiftMonth } from '../../lib/reports.js';
import Avatar from '../Avatar.jsx';
import { EntryRow, Notes } from './parts.jsx';

// One person's reports (SPEC.md 6.18, design DR-C): a bar of the month's days on top (a blue dot
// when there is a report, ‹ › for other months), and the chosen day's report below.
export default function PersonReports({ memberId, onBack, backLabel }) {
	const { api, data, reports } = usePortal();
	const today = (reports.state && reports.state.today) || new Date().toISOString().slice(0, 10);
	const [month, setMonth] = useState(today.slice(0, 7));
	const [res, setRes] = useState(null);
	const [day, setDay] = useState(null);
	const [error, setError] = useState('');
	const bar = useRef(null);
	const person = data.members[memberId];

	useEffect(() => {
		let live = true;
		setRes(null);
		api
			.get('daily-reports', { member: memberId, month })
			.then((r) => live && setRes(r))
			.catch((err) => live && setError(err.message));
		return () => {
			live = false;
		};
	}, [api, memberId, month]);

	const byDay = useMemo(() => {
		const map = {};
		(res ? res.reports : []).forEach((r) => {
			map[r.day] = r;
		});
		return map;
	}, [res]);
	const days = monthDays(month);
	// The chosen day: as picked, else the latest day with a report, else today (this month) or the 1st.
	const withReport = days.filter((d) => byDay[d.day]).map((d) => d.day);
	const shown = day && day.startsWith(month) ? day : withReport.length ? withReport[withReport.length - 1] : today.startsWith(month) ? today : days[0].day;
	const report = byDay[shown];

	// Keep the chosen day in view on the bar.
	useEffect(() => {
		const el = bar.current && bar.current.querySelector('[aria-pressed="true"]');
		if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', inline: 'center' });
	}, [shown, res]);

	return (
		<div className="dr-person">
			<button type="button" className="linkbtn dr-back" onClick={onBack}>
				‹ {backLabel}
			</button>
			{person && (
				<div className="dr-person-h">
					<Avatar person={person} big />
					<div>
						<h2>{person.name}</h2>
						<small>{ROLE[person.role]}</small>
					</div>
				</div>
			)}
			<div className="dr-daybar">
				<div className="dr-daybar-h">
					<b>{new Date(+month.slice(0, 4), +month.slice(5) - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</b>
					<button type="button" className="dr-nav" aria-label="Previous month" onClick={() => (setMonth(shiftMonth(month, -1)), setDay(null))}>
						‹
					</button>
					<button type="button" className="dr-nav" aria-label="Next month" onClick={() => (setMonth(shiftMonth(month, 1)), setDay(null))} disabled={month >= today.slice(0, 7)}>
						›
					</button>
				</div>
				<div className="dr-days" ref={bar} role="group" aria-label="Days">
					{days.map((d) => (
						<button key={d.day} type="button" className={'dr-d' + (byDay[d.day] ? ' has' : '') + (d.day > today ? ' future' : '')} aria-pressed={d.day === shown} aria-label={`${dayTitle(d.day)}${byDay[d.day] ? ', has a report' : ''}`} disabled={d.day > today} onClick={() => setDay(d.day)}>
							<small>{d.letter}</small>
							<b>{d.n}</b>
							<i aria-hidden="true" />
						</button>
					))}
				</div>
			</div>
			{error ? (
				<p className="err">{error}</p>
			) : !res ? (
				<p className="empty">Loading…</p>
			) : (
				<section className="dr-dayreport" aria-label={`Report of ${dayTitle(shown)}`}>
					<h3>{dayTitle(shown)}</h3>
					{report ? (
						<>
							<ul className="dr-list read">
								{report.entries.map((e) => (
									<EntryRow key={e.id} entry={e} />
								))}
							</ul>
							<Notes report={report} />
							{!report.sent_at && <p className="muted dr-draft">Draft — not sent yet.</p>}
						</>
					) : (
						<p className="muted dr-none">No report this day.</p>
					)}
				</section>
			)}
		</div>
	);
}

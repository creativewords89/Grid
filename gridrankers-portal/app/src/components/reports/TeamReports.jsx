import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { ROLE } from '../../lib/roles.js';
import { STATE, dayTitle, nextDay, summary, teamCounts } from '../../lib/reports.js';
import Avatar from '../Avatar.jsx';
import { sentTime } from './DailyReports.jsx';
import { EntryRow, Notes } from './parts.jsx';

const FILTERS = [
	['all', 'All'],
	['sent', 'Sent'],
	['not_sent', 'Not sent'],
	['away', 'On leave'],
];

// Team tab (SPEC.md 6.18, design DR-B): pick a day with ‹ ›, "3 of 4 sent", and a card per person
// with what they wrote — Late, Not sent (Remind) or On leave. The server decides who is listed:
// the Super Admin sees everyone, a Team Leader Team Members and the other Team Leaders.
export default function TeamReports({ onOpenPerson }) {
	const { api, data, me, toast, viewOnly, reports } = usePortal();
	const today = (reports.state && reports.state.today) || null;
	const [day, setDay] = useState(today);
	const [res, setRes] = useState(null);
	const [filter, setFilter] = useState('all');
	const [error, setError] = useState('');

	useEffect(() => {
		let live = true;
		setRes(null);
		api
			.get('daily-reports/team', day ? { day } : undefined)
			.then((r) => {
				if (!live) return;
				setRes(r);
				if (!day) setDay(r.day);
			})
			.catch((err) => live && setError(err.message));
		return () => {
			live = false;
		};
	}, [api, day]);

	const remind = async (p) => {
		try {
			await api.post('daily-reports/remind', { member_id: p.member_id, day: res.day });
			toast(`Reminder sent to ${data.members[p.member_id] ? data.members[p.member_id].name : 'them'}`);
		} catch (err) {
			toast(err.message);
		}
	};

	if (error) return <p className="err">{error}</p>;
	const shownDay = (res && res.day) || day;
	const people = res ? res.people.filter((p) => p.state !== 'none' && data.members[p.member_id]) : [];
	const counts = teamCounts(people);
	const shown = people.filter((p) => filter === 'all' || (filter === 'sent' ? p.state === 'sent' || p.state === 'late' : filter === 'away' ? p.state === 'leave' || p.state === 'day_off' : p.state === filter));
	const atToday = res && shownDay >= res.today;

	return (
		<div className="dr-team">
			<div className="dr-dayrow">
				<button type="button" className="dr-nav" aria-label="Previous day" onClick={() => setDay(nextDay(shownDay, -1))} disabled={!shownDay}>
					‹
				</button>
				<b className="dr-day">{shownDay ? dayTitle(shownDay) : ''}</b>
				<button type="button" className="dr-nav" aria-label="Next day" onClick={() => setDay(nextDay(shownDay, 1))} disabled={!shownDay || atToday}>
					›
				</button>
			</div>
			{!res ? (
				<p className="empty">Loading…</p>
			) : (
				<>
					<div className="dr-count">
						<b>
							{counts.sent} of {counts.owed}
						</b>{' '}
						sent
						<span className="dr-bar" aria-hidden="true">
							<i style={{ width: counts.owed ? Math.round((counts.sent / counts.owed) * 100) + '%' : 0 }} />
						</span>
						<span className="muted">
							{counts.late ? `${counts.late} late · ` : ''}
							{counts.missing} not sent
						</span>
					</div>
					<div className="dr-filters" role="group" aria-label="Show">
						{FILTERS.map(([k, label]) => (
							<button key={k} type="button" className="ra-chip" aria-pressed={filter === k} onClick={() => setFilter(k)}>
								{label}
							</button>
						))}
					</div>
					{shown.length === 0 && <p className="empty">Nobody here for this day.</p>}
					<div className="dr-cards">
					{shown.map((p) => {
						const person = data.members[p.member_id];
						const st = STATE[p.state] || STATE.none;
						const r = p.report;
						return (
							<article key={p.member_id} className={'dr-card st-' + p.state} aria-label={`Report of ${person.name}`}>
								<div className="dr-card-h">
									<Avatar person={person} />
									<button type="button" className="dr-who" onClick={() => onOpenPerson(p.member_id)} title="Open their reports">
										<b>{person.name}</b>
										<small>
											{ROLE[person.role]}
											{r ? ` · ${summary(r.entries)}` : ''}
										</small>
									</button>
									<span className={'dr-badge ' + st.tone}>{p.state === 'sent' ? `Sent ${sentTime(r.sent_at)}` : p.state === 'late' ? `Late · ${sentTime(r.sent_at)}` : st.text}</span>
									{p.state === 'not_sent' && person.id !== me.id && (
										<button type="button" className="btn small" onClick={() => remind(p)} disabled={viewOnly}>
											Remind
										</button>
									)}
								</div>
								{r && (
									<ul className="dr-list read">
										{r.entries.map((e) => (
											<EntryRow key={e.id} entry={e} />
										))}
									</ul>
								)}
								<Notes report={r} />
							</article>
						);
					})}
					</div>
				</>
			)}
		</div>
	);
}

import { useState } from 'react';
import { usePortal } from '../context.js';
import { hoursPeople, weekHours } from '../lib/hours.js';
import { fmtMinutes } from '../lib/reports.js';
import { hostOf } from '../lib/site.js';
import { rowsOf } from '../lib/store.js';
import { addDays } from '../lib/timer.js';
import Avatar from './Avatar.jsx';
import TimeTab from './team/TimeTab.jsx';

// The tracker portal (SPEC.md 6.22): Hours (who you may see, a week each), a person's Time, and a
// note that profiles, leave and pay are on the main portal. No projects, boards, reports or pay.
export default function TrackerPortal({ onSignOut, extraTabs = [] }) {
	const { data, me, today, config } = usePortal();
	const main = config.site.mainUrl;
	const mainHost = hostOf(main);
	const tracks = me.role !== 'admin';
	const [tab, setTab] = useState(tracks && me.role === 'member' ? 'mine' : 'hours');
	const [person, setPerson] = useState(null);

	const tabs = [
		...(me.role !== 'member' ? [{ id: 'hours', label: 'Hours' }] : []),
		...(tracks ? [{ id: 'mine', label: 'My time' }] : []),
		...extraTabs.map((t) => ({ id: t.id, label: t.label })),
	];
	const open = (p) => (setPerson(p), setTab('person'));
	const extra = extraTabs.find((t) => t.id === tab);

	return (
		<div className="trk">
			<header className="trk-top">
				<div className="trk-brand">
					<b>GridRankers</b> <span>Tracker</span>
				</div>
				<p className="trk-note">
					Profiles, leave and pay are on{' '}
					<a href={main} target="_blank" rel="noopener noreferrer">
						{mainHost}
					</a>
				</p>
				<span className="trk-me">
					<Avatar person={me} /> {me.name}
				</span>
				<button type="button" className="btn small" onClick={onSignOut}>
					Sign out
				</button>
			</header>
			<nav className="trk-tabs" role="tablist" aria-label="Tracker">
				{tabs.map((t) => (
					<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={'trk-tab' + (tab === t.id ? ' on' : '')} onClick={() => (setTab(t.id), setPerson(null))}>
						{t.label}
					</button>
				))}
			</nav>
			<section className="trk-body" aria-label="Content">
				{tab === 'hours' && <Hours data={data} me={me} today={today} mainHost={mainHost} onOpen={open} />}
				{tab === 'mine' && <TimeTab key={me.id} person={me} />}
				{tab === 'person' && person && (
					<>
						<button type="button" className="linkbtn" onClick={() => (setTab('hours'), setPerson(null))}>
							‹ Hours
						</button>
						<h2 className="trk-who">{person.name}</h2>
						<TimeTab key={person.id} person={person} />
					</>
				)}
				{extra && extra.render()}
			</section>
		</div>
	);
}

// A week of tracked time per person: each day, the total, and what isn't on the main portal.
function Hours({ data, me, today, mainHost, onOpen }) {
	const [to, setTo] = useState(today);
	const people = hoursPeople(data.members, me);
	const { days, rows } = weekHours(rowsOf(data, 'time_entries'), people, to);
	const fmtDay = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
	const fmt = (m) => (m ? fmtMinutes(m) : '–');

	return (
		<div className="dcard trk-hours">
			<div className="tt-head">
				<h3>Hours</h3>
				<div className="tt-nav">
					<button type="button" className="btn small ghost" aria-label="Earlier week" onClick={() => setTo(addDays(to, -7))}>
						‹
					</button>
					<span>
						{fmtDay(days[0])} – {fmtDay(days[6])}
					</span>
					<button type="button" className="btn small ghost" aria-label="Later week" disabled={to >= today} onClick={() => setTo(addDays(to, 7) > today ? today : addDays(to, 7))}>
						›
					</button>
				</div>
			</div>
			{!rows.length ? (
				<p className="empty">Nobody tracks time here yet. People are copied from {mainHost} every 5 minutes.</p>
			) : (
				<div className="trk-scroll">
					<table className="trk-table">
						<thead>
							<tr>
								<th scope="col">Person</th>
								{days.map((d) => (
									<th key={d} scope="col">
										{fmtDay(d)}
									</th>
								))}
								<th scope="col">Total</th>
								<th scope="col">On {mainHost}</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((r) => (
								<tr key={r.person.id}>
									<th scope="row">
										<button type="button" className="linkbtn trk-person" onClick={() => onOpen(r.person)}>
											<Avatar person={r.person} /> {r.person.name}
										</button>
									</th>
									{days.map((d) => (
										<td key={d}>{fmt(r.days[d])}</td>
									))}
									<td>
										<b>{fmt(r.total)}</b>
									</td>
									<td>
										{r.refused ? <span className="tt-flag trk-refused">{r.refused} refused</span> : null} {r.waiting ? <span className="tt-src">{r.waiting} waiting</span> : null}
										{!r.refused && !r.waiting ? <span className="trk-ok">✓</span> : null}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}

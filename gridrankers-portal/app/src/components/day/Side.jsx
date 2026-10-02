import { useMemo } from 'react';
import { usePortal } from '../../context.js';
import { shoutouts } from '../../lib/day.js';
import { short } from '../../lib/format.js';
import { teamWeekly, whosOut } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';

const STAR = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
	</svg>
);

const backText = (back, today) => {
	const days = Math.round((Date.parse(back) - Date.parse(today)) / 86400000);
	return days === 1 ? 'back tomorrow' : `back ${new Date(back + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })} ${short(back)}`;
};

// Who's out today (SPEC.md 6.10): day off or on leave — never the leave type or reason.
export function WhosOut() {
	const { data, me, today } = usePortal();
	const list = useMemo(() => {
		const people = rowsOf(data, 'members').filter((m) => m.active);
		return whosOut(today, people, rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'), me.id);
	}, [data, me.id, today]);

	return (
		<section className="md-card" aria-labelledby="woTitle">
			<h2 id="woTitle">Who’s out today</h2>
			{list.length === 0 ? (
				<p className="muted">Everyone is in today.</p>
			) : (
				<ul className="wo-list">
					{list.map((o) => (
						<li key={o.member.id}>
							<Avatar person={o.member} />
							<span className="wo-who">
								<b>{o.member.name}</b>
								<small>{backText(o.back, today)}</small>
							</span>
							<span className={'mp-flag ' + (o.why === 'leave' ? 'f-teal' : 'f-amber')}>{o.why === 'leave' ? 'On leave' : 'Day off'}</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}

const ago = (iso) => {
	const days = Math.floor((Date.now() - Date.parse(String(iso).replace(' ', 'T') + 'Z')) / 86400000);
	return days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};

// Shout-outs (Team Members): the 3 latest of the last 30 days.
export function Shoutouts() {
	const { data, me } = usePortal();
	const list = shoutouts(data).slice(0, 3);

	return (
		<section className="md-card md-grow" aria-labelledby="soTitle">
			<div className="md-h">
				<h2 id="soTitle">Shout-outs</h2>
				<span className="muted">Last 30 days</span>
			</div>
			{list.length === 0 ? (
				<div className="md-empty">
					<span className="so-star">{STAR}</span>
					<b>No shout-outs yet</b>
					<span>When a Team Leader praises someone’s work, it shows here.</span>
				</div>
			) : (
				<div className="so-list">
					{list.map((p) => {
						const by = data.members[p.created_by];
						const to = data.members[p.to_member];
						return (
							<div key={p.id} className="so-tile">
								<div className="so-head">
									<Avatar person={by} small />
									<span>
										<b>{by ? by.name : 'Team Leader'}</b> → <b>{p.to_member === me.id ? 'you' : to ? to.name : '—'}</b>
									</span>
									<small>{ago(p.created_at)}</small>
								</div>
								<p>
									<span className="so-star">{STAR}</span>
									{p.body}
								</p>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

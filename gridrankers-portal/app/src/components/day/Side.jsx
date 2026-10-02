import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { notices } from '../../lib/day.js';
import { short } from '../../lib/format.js';
import { dayOffName, teamWeekly, whosOut } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';

const STAR = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
	</svg>
);

const MEGA = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
		<path d="M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6" />
	</svg>
);

const backText = (back, today) => {
	const days = Math.round((Date.parse(back) - Date.parse(today)) / 86400000);
	return days === 1 ? 'back tomorrow' : `back ${new Date(back + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })} ${short(back)}`;
};

const FACES = 8;
const NAMES = 3;
const PAGE = 20;

function OutRow({ o, today }) {
	return (
		<li>
			<Avatar person={o.member} />
			<span className="wo-who">
				<b>{o.member.name}</b>
				<small>{backText(o.back, today)}</small>
			</span>
			<span className={'mp-flag ' + (o.why === 'leave' ? 'f-teal' : 'f-amber')}>{o.why === 'leave' ? 'On leave' : 'Day off'}</span>
		</li>
	);
}

// "See all": everyone out today, searchable, 20 per page.
function OutList({ list, today, onClose }) {
	const [q, setQ] = useState('');
	const [f, setF] = useState('all');
	const [page, setPage] = useState(0);
	const leave = list.filter((o) => o.why === 'leave').length;
	const shown = list.filter((o) => (f === 'all' || o.why === f) && o.member.name.toLowerCase().includes(q.trim().toLowerCase()));
	const pages = Math.max(1, Math.ceil(shown.length / PAGE));
	const at = Math.min(page, pages - 1);
	const chips = [
		['all', 'All', list.length],
		['leave', 'On leave', leave],
		['day_off', 'Day off', list.length - leave],
	];
	return (
		<Modal open onClose={onClose} labelledBy="woAll" className="ap-dlg">
			<h2 id="woAll">Who’s out today · {list.length}</h2>
			<input className="search" type="search" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />
			<div className="ra-chips" role="group" aria-label="Filter">
				{chips.map(([k, l, n]) => (
					<button key={k} type="button" className="ra-chip" aria-pressed={f === k} onClick={() => (setF(k), setPage(0))}>
						{l} {n}
					</button>
				))}
			</div>
			<ul className="wo-list">
				{shown.slice(at * PAGE, at * PAGE + PAGE).map((o) => (
					<OutRow key={o.member.id} o={o} today={today} />
				))}
			</ul>
			{shown.length === 0 && <p className="muted">Nobody matches.</p>}
			<div className="dlg-acts">
				{pages > 1 && (
					<span className="mp-pages">
						<button type="button" className="pg" disabled={at === 0} onClick={() => setPage(at - 1)}>
							‹ Previous
						</button>
						<span className="muted">
							Page {at + 1} of {pages}
						</span>
						<button type="button" className="pg" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>
							Next ›
						</button>
					</span>
				)}
				<button type="button" className="btn" onClick={onClose}>
					Close
				</button>
			</div>
		</Modal>
	);
}

// Who's out today (SPEC.md 6.10): day off or on leave — never the leave type or reason. Up to 3
// people by name; more as faces + counts with See all; one line when the whole team is off.
export function WhosOut() {
	const { data, me, today } = usePortal();
	const [all, setAll] = useState(false);
	const people = useMemo(() => rowsOf(data, 'members').filter((m) => m.active), [data]);
	const list = useMemo(() => whosOut(today, people, rowsOf(data, 'leave'), teamWeekly(data), rowsOf(data, 'days_off'), me.id), [data, people, me.id, today]);
	const others = people.filter((m) => m.id !== me.id).length;
	const holiday = dayOffName(today, rowsOf(data, 'days_off'));
	const everyone = list.length > 0 && (holiday || list.length === others);
	const leave = list.filter((o) => o.why === 'leave').length;
	const back = list.map((o) => o.back).sort()[0];

	let body;
	if (list.length === 0) {
		body = <p className="muted">Everyone is in today.</p>;
	} else if (everyone) {
		body = (
			<div className="wo-all">
				<b>Everyone is off today</b>
				<span>
					{holiday || 'Day off'}
					{back ? ` · back on ${new Date(back + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })} ${short(back)}` : ''}
				</span>
			</div>
		);
	} else if (list.length <= NAMES) {
		body = (
			<ul className="wo-list">
				{list.map((o) => (
					<OutRow key={o.member.id} o={o} today={today} />
				))}
			</ul>
		);
	} else {
		body = (
			<>
				<div className="wo-faces" aria-label={list.map((o) => o.member.name).join(', ')}>
					{list.slice(0, FACES).map((o) => (
						<Avatar key={o.member.id} person={o.member} />
					))}
					{list.length > FACES && <span className="wo-more">+{list.length - FACES}</span>}
				</div>
				<div className="wo-counts">
					{leave > 0 && <span className="mp-flag f-teal">{leave} on leave</span>}
					{list.length - leave > 0 && <span className="mp-flag f-amber">{list.length - leave} day off</span>}
				</div>
			</>
		);
	}

	return (
		<section className="md-card" aria-labelledby="woTitle">
			<div className="md-h">
				<h2 id="woTitle">Who’s out today</h2>
				{list.length > NAMES && (
					<button type="button" className="linkbtn" onClick={() => setAll(true)}>
						See all {list.length}
					</button>
				)}
			</div>
			{body}
			{all && <OutList list={list} today={today} onClose={() => setAll(false)} />}
		</section>
	);
}

const when = (iso) => {
	const t = Date.parse(String(iso).replace(' ', 'T') + 'Z');
	const days = Math.floor((Date.now() - t) / 86400000);
	return days <= 0 ? `Today, ${new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` : days === 1 ? 'Yesterday' : new Date(t).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

const TAG = { you: ['To you', 'f-blue'], all: ['Everyone', 'f-green'], shout: ['Shout-out', 'f-amber'] };

function NoticeCard({ n }) {
	const [label, cls] = TAG[n.tag];
	return (
		<div className={'nc-card' + (n.tag === 'shout' ? ' nc-shout' : '')}>
			<div className="so-head">
				<Avatar person={n.from} small />
				<span>
					<b>{n.from ? n.from.name : 'Team Leader'}</b> → <b>{n.to}</b>
				</span>
				<span className={'mp-flag ' + cls}>{label}</span>
			</div>
			{n.post.title && <b className="nc-title">{n.post.title}</b>}
			<p>
				<span className={n.tag === 'shout' ? 'so-star' : 'nc-ico'}>{n.tag === 'shout' ? STAR : MEGA}</span>
				{n.post.body}
			</p>
			<small className="muted">{when(n.post.created_at)}</small>
		</div>
	);
}

// Notices (SPEC.md 6.10): notices to everyone, notices to me and shout-outs, newest first.
export function Notices() {
	const { data, me, today } = usePortal();
	const [all, setAll] = useState(false);
	const list = useMemo(() => notices(data, me, today), [data, me, today]);

	return (
		<section className="md-card md-grow" aria-labelledby="ncTitle">
			<div className="md-h">
				<h2 id="ncTitle">Notices</h2>
				{list.length > NAMES && (
					<button type="button" className="linkbtn" onClick={() => setAll(true)}>
						View all {list.length}
					</button>
				)}
			</div>
			{list.length === 0 ? (
				<div className="md-empty">
					<span className="nc-ico">{MEGA}</span>
					<b>No notices yet</b>
					<span>Notices and shout-outs from your Team Leaders show here.</span>
				</div>
			) : (
				<div className="so-list">
					{list.slice(0, NAMES).map((n) => (
						<NoticeCard key={n.post.id} n={n} />
					))}
				</div>
			)}
			<Modal open={all} onClose={() => setAll(false)} labelledBy="ncAll" className="ap-dlg">
				<h2 id="ncAll">Notices</h2>
				<div className="so-list">
					{list.map((n) => (
						<NoticeCard key={n.post.id} n={n} />
					))}
				</div>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={() => setAll(false)}>
						Close
					</button>
				</div>
			</Modal>
		</section>
	);
}

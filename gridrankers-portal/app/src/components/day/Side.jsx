import { useMemo, useState } from 'react';
import { usePortal } from '../../context.js';
import { approvals, dismissedKeys } from '../../lib/day.js';
import { isManager } from '../../lib/roles.js';
import { ApprovalItem } from './Approvals.jsx';
import { SetupReminders } from './CycleSetup.jsx';
import { FILTERS, PAGE_SIZE, ago, countsOf, feedOf } from '../../lib/feed.js';
import { useDismiss } from './DayHeader.jsx';
import { short } from '../../lib/format.js';
import { dayOffName, teamWeekly, whosOut } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';



const backText = (back, today) => {
	const days = Math.round((Date.parse(back) - Date.parse(today)) / 86400000);
	return days === 1 ? 'Back tomorrow' : `Back ${new Date(back + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short' })} ${short(back)}`;
};

const FACES = 8;
const NAMES = 3;
const PAGE = 10;

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

const SEARCH = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
		<path d="M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14M20 20l-4-4" />
	</svg>
);

// "See all": everyone out today, searchable, 10 per page. The filter shows only when people
// are out for both reasons.
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
		<Modal open onClose={onClose} labelledBy="woAll" className="list-dlg">
			<div className="ld-head">
				<h2 id="woAll">Who’s out today</h2>
				<span className="ld-count">{list.length}</span>
				<button type="button" className="ld-x" aria-label="Close" onClick={onClose}>
					✕
				</button>
			</div>
			<div className="ld-tools">
				<label className="ld-search">
					{SEARCH}
					<input type="search" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => (setQ(e.target.value), setPage(0))} />
				</label>
				{leave > 0 && leave < list.length && (
					<div className="ld-seg" role="group" aria-label="Filter">
						{chips.map(([k, l, n]) => (
							<button key={k} type="button" aria-pressed={f === k} onClick={() => (setF(k), setPage(0))}>
								{l} <span>{n}</span>
							</button>
						))}
					</div>
				)}
			</div>
			<div className="ld-body">
				{shown.length === 0 ? (
					<p className="ld-empty">Nobody matches “{q.trim()}”.</p>
				) : (
					<ul className="wo-list ld-list">
						{shown.slice(at * PAGE, at * PAGE + PAGE).map((o) => (
							<OutRow key={o.member.id} o={o} today={today} />
						))}
					</ul>
				)}
			</div>
			<div className="ld-foot">
				<span className="muted">
					{pages > 1 ? `${at * PAGE + 1}–${Math.min(shown.length, at * PAGE + PAGE)} of ${shown.length}` : `${shown.length} ${shown.length === 1 ? 'person' : 'people'}`}
				</span>
				<span className="ld-pages">
					{pages > 1 && (
						<>
							<button type="button" className="pg" aria-label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)}>
								‹
							</button>
							<button type="button" className="pg" aria-label="Next page" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>
								›
							</button>
						</>
					)}
					<button type="button" className="btn" onClick={onClose}>
						Close
					</button>
				</span>
			</div>
		</Modal>
	);
}

// Who's out today (SPEC.md 6.10): day off or on leave — never the leave type or reason. Up to 3
// people by name; more as faces + counts with See all; one line when the whole team is off.
export function WhosOut({ bare = false }) {
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

	// `bare`: one half of the Today card (design NF-A) instead of its own card.
	const Box = bare ? 'div' : 'section';
	return (
		<Box className={bare ? 'td-half' : 'md-card'} aria-labelledby="woTitle">
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
		</Box>
	);
}

// Notifications (SPEC.md 6.10, design NF-A): everything that matters to me in one feed, newest
// first, with filters, unread dots, Mark all read and pages of PAGE_SIZE. Read state is shared with
// the bell (`seen:` keys).
// Waiting items shown above the feed on its first page; the rest under To approve.
const WAIT_SHOWN = 3;
const at0 = (page) => page === 0;

export function Notifications() {
	const { data, me, today, setProject, setSearch, setView, viewOnly } = usePortal();
	const dismiss = useDismiss();
	const [filter, setFilter] = useState('all');
	const [page, setPage] = useState(0);
	const items = useMemo(() => feedOf(data, me, today), [data, me, today]);
	// Team Leaders and the Super Admin: what waits for their answer sits on top (design NF-C).
	const waiting = useMemo(() => (isManager(me) ? approvals(data, me) : []), [data, me]);
	const seen = dismissedKeys(data, me);
	const unread = items.filter((i) => !seen.has('seen:' + i.key));
	const counts = { ...countsOf(items), approve: waiting.length };
	const approving = filter === 'approve';
	const shown = approving ? waiting : filter === 'all' ? items : items.filter((i) => i.cat === filter);
	const topWaiting = filter === 'all' && at0(page) ? waiting.slice(0, WAIT_SHOWN) : [];
	const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
	const at = Math.min(page, pages - 1);
	const read = (keys) => !viewOnly && keys.length && dismiss(keys.map((k) => 'seen:' + k));
	const open = (i) => {
		if (!seen.has('seen:' + i.key)) read([i.key]);
		setProject(i.open.project_id);
		setSearch(i.open.title);
		setView(i.open.tab);
	};

	return (
		<section className="md-card md-grow nf" aria-labelledby="nfTitle">
			<div className="md-h">
				<h2 id="nfTitle">Notifications</h2>
				{unread.length > 0 && <span className="nf-new">{unread.length} new</span>}
				{unread.length > 0 && !viewOnly && (
					<button type="button" className="linkbtn nf-all" onClick={() => read(unread.map((i) => i.key))}>
						Mark all read
					</button>
				)}
			</div>
			<div className="nf-chips" role="group" aria-label="Show">
				{(waiting.length || isManager(me) ? [FILTERS[0], ['approve', 'To approve'], ...FILTERS.slice(1)] : FILTERS).map(([k, label]) => (
					<button key={k} type="button" className={k === 'approve' ? 'nf-chip-wait' : undefined} aria-pressed={filter === k} onClick={() => (setFilter(k), setPage(0))}>
						{label} {counts[k] > 0 && <span>{counts[k]}</span>}
					</button>
				))}
			</div>
			{/* New cycle setup reminders (SPEC.md 6.11): under the filters, with what waits for you. */}
			{(filter === 'all' || filter === 'approve') && at0(page) && <SetupReminders />}
			{topWaiting.length > 0 && (
				<div className="nf-wait" aria-labelledby="nfWait">
					<h3 id="nfWait">Waiting for you · {waiting.length}</h3>
					{topWaiting.map((i) => (
						<ApprovalItem key={i.kind + i.id} item={i} />
					))}
					{waiting.length > WAIT_SHOWN && (
						<button type="button" className="linkbtn nf-more" onClick={() => (setFilter('approve'), setPage(0))}>
							+ {waiting.length - WAIT_SHOWN} more waiting for you
						</button>
					)}
				</div>
			)}
			{topWaiting.length > 0 && shown.length > 0 && <h3 className="nf-latest">Latest</h3>}
			{approving ? (
				shown.length === 0 ? (
					<div className="nf-wait">
						<div className="md-empty">
							<b>Nothing waiting for you</b>
							<span>Leave requests, finished tasks to check and requests to undo or untick show here.</span>
						</div>
					</div>
				) : (
					<div className="nf-wait">
						{shown.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE).map((i) => (
							<ApprovalItem key={i.kind + i.id} item={i} />
						))}
					</div>
				)
			) : shown.length === 0 ? (
				<div className="md-empty">
					<b>{filter === 'all' ? 'Nothing new' : 'Nothing here'}</b>
					<span>New tasks, reviews, leave answers, events and messages for you show here.</span>
				</div>
			) : (
				<ul className="nf-list">
					{shown.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE).map((i) => {
						const isNew = !seen.has('seen:' + i.key);
						return (
							<li key={i.key} className={'nf-item' + (isNew ? ' new' : '')}>
								<span className="nf-dot" aria-label={isNew ? 'Unread' : undefined} />
								<span className={'nf-ic t-' + i.tone} aria-hidden="true">
									{i.icon}
								</span>
								<span className="nf-body">
									<span className="nf-top">
										<b>{i.title}</b>
										<small>{ago(i.at)}</small>
									</span>
									{i.open && (
										<button type="button" className="linkbtn nf-open" onClick={() => open(i)}>
											Open task ›
										</button>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{pages > 1 && (
				<div className="nf-pages">
					<span className="muted">
						{at * PAGE_SIZE + 1}–{Math.min(shown.length, at * PAGE_SIZE + PAGE_SIZE)} of {shown.length}
					</span>
					<button type="button" className="pg" aria-label="Previous page" disabled={at === 0} onClick={() => setPage(at - 1)}>
						‹
					</button>
					<button type="button" className="pg" aria-label="Next page" disabled={at === pages - 1} onClick={() => setPage(at + 1)}>
						›
					</button>
				</div>
			)}
		</section>
	);
}

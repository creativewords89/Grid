import { useEffect, useMemo, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { bellItems, strips } from '../../lib/day.js';
import { weekdayDate } from '../../lib/format.js';
import { firstName, greeting } from '../../lib/people.js';
import { ROLE, isManager } from '../../lib/roles.js';
import Avatar from '../Avatar.jsx';

const ICON = {
	announcement: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
	dayoff: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
	birthday: 'M4 21h16M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0M12 12V8',
	leave: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12.5l2.5 2.5L16 9.5',
	review: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12.5l2.5 2.5L16 9.5',
};

// Marks keys as dismissed (per person, SPEC.md 6.9).
export function useDismiss() {
	const { api, dispatch, toast } = usePortal();
	return async (keys) => {
		try {
			for (const key of keys) dispatch({ type: 'upsert', table: 'dismissals', row: await api.post('notifications/dismiss', { key }) });
		} catch (err) {
			toast(err.message);
		}
	};
}

function Bell() {
	const { data, me, today } = usePortal();
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	const dismiss = useDismiss();
	const items = useMemo(() => bellItems(data, me, today), [data, me, today]);
	const unread = items.filter((i) => i.unread);

	useEffect(() => {
		if (!open) return undefined;
		const close = (e) => {
			if (e.type === 'keydown' ? e.key === 'Escape' : !ref.current || !ref.current.contains(e.target)) setOpen(false);
		};
		document.addEventListener('mousedown', close);
		document.addEventListener('keydown', close);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('keydown', close);
		};
	}, [open]);

	const toggle = () => {
		setOpen(!open);
		// Opening the list marks everything in it as read.
		if (!open && unread.length) dismiss(unread.map((i) => 'seen:' + i.key));
	};

	return (
		<div className="md-bell" ref={ref}>
			<button type="button" className="md-bell-btn" aria-label={`Notifications${unread.length ? `, ${unread.length} new` : ''}`} aria-expanded={open} onClick={toggle}>
				<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
					<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15zM10 20a2 2 0 0 0 4 0" />
				</svg>
				{unread.length > 0 && <span className="md-badge">{unread.length}</span>}
			</button>
			{open && (
				<div className="md-pop" role="dialog" aria-label="Notifications">
					<h2>Notifications</h2>
					{items.length === 0 ? (
						<p className="empty">Nothing new.</p>
					) : (
						<ul>
							{items.map((i) => (
								<li key={i.key} className={i.unread ? 'new' : ''}>
									<b>{i.text}</b>
									{i.sub && <span>{i.sub}</span>}
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

// Greeting, date, bell, user chip and the message strips (SPEC.md 7.0).
export default function DayHeader({ onSignOut }) {
	const { data, me, today, setView, setTeamPerson, setProject, setSearch } = usePortal();
	const dismiss = useDismiss();
	const list = useMemo(() => strips(data, me, today), [data, me, today]);

	const act = (s) => {
		if (s.kind === 'review') {
			setProject(s.review.project_id);
			setSearch(s.review.title);
			setView(s.review.tab);
			return;
		}
		dismiss([s.key]);
	};

	return (
		<header className="md-top" aria-label="Today">
			<div className="md-row">
				<div className="md-hello">
					<h1>
						{greeting()}, {firstName(me.name)}
					</h1>
					<span>{weekdayDate(today)}</span>
				</div>
				<Bell />
				<div className="md-me">
					<button type="button" className="me-btn" title={isManager(me) ? 'Open the team page' : 'Open my page'} onClick={() => (setTeamPerson('all'), setView('team'))}>
						<Avatar person={me} />
						<b>{me.name}</b>
						<span className={'role r-' + me.role}>{ROLE[me.role]}</span>
					</button>
					<button type="button" className="btn small ghost" onClick={onSignOut}>
						Sign out
					</button>
				</div>
			</div>
			{list.map((s) => (
				<div key={s.key} className={'md-strip t-' + s.tone} role="status">
					<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
						<path d={ICON[s.kind]} />
					</svg>
					<p>
						<b>{s.title}</b> {s.text}
						{s.meta && <span className="md-meta"> · {s.meta}</span>}
					</p>
					<button type="button" className="md-strip-x" onClick={() => act(s)}>
						{s.ok || 'Dismiss'}
					</button>
				</div>
			))}
		</header>
	);
}

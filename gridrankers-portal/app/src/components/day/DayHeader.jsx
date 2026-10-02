import { useEffect, useMemo, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { bellItems, strips } from '../../lib/day.js';
import { weekdayDate } from '../../lib/format.js';
import { MEMBER_TAB_KEY, greeting } from '../../lib/people.js';
import { ROLE } from '../../lib/roles.js';
import Avatar from '../Avatar.jsx';

const ICON = {
	announcement: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1zM15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12',
	dayoff: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
	birthday: 'M4 21h16M5 21v-7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v7M5 16c1.5 1 3 1 4.5 0s3-1 4.5 0 3 1 4.5 0M12 12V8',
	leave: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12.5l2.5 2.5L16 9.5',
	review: 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18M8 12.5l2.5 2.5L16 9.5',
	profile: 'M12 4a4 4 0 1 0 0 8a4 4 0 1 0 0-8M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
};

// Weather icons (Open-Meteo kinds, SPEC.md 6.10).
const SKY = {
	sun: 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
	'cloud-sun': 'M8 4v1.5M3.5 8H5M4.9 4.9l1 1M12 8.5A4 4 0 0 0 5 9.5M7 19h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 19z',
	cloud: 'M7 19h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 19z',
	rain: 'M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM8 18l-1 3M12 18l-1 3M16 18l-1 3',
	snow: 'M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM8 19h.01M12 20h.01M16 19h.01',
	storm: 'M7 15h10a4 4 0 0 0 .5-8 5.5 5.5 0 0 0-10.6 1.5A3.3 3.3 0 0 0 7 15zM12 15l-2 4h3l-2 3',
	fog: 'M4 10h16M6 14h12M8 18h8',
};

// Today's weather for my city (GET /weather); nothing when there's no city or no answer.
function Weather() {
	const { api, data, me } = usePortal();
	const city = (data.members[me.id] || me).location || '';
	const [w, setW] = useState(null);
	useEffect(() => {
		let gone = false;
		setW(null);
		if (city) {
			api
				.get('weather')
				.then((r) => !gone && r && r.available && setW(r))
				.catch(() => {});
		}
		return () => {
			gone = true;
		};
	}, [api, city]);
	if (!w) return null;
	return (
		<span className="md-wx" title={`Today in ${w.city}`}>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
				<path d={SKY[w.icon] || SKY.cloud} />
			</svg>
			<b>{w.temp}°</b> {w.text} in {w.city}
			{w.max !== null && w.min !== null && (
				<span className="muted">
					{' '}
					· {w.max}° / {w.min}°
				</span>
			)}
		</span>
	);
}

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

// The message band, greeting, date, bell and user chip (SPEC.md 7.0).
export default function DayHeader({ onSignOut }) {
	const { data, me, today, setView, setTeamPerson, setProject, setSearch } = usePortal();
	const dismiss = useDismiss();
	const list = useMemo(() => strips(data, me, today), [data, me, today]);
	const [shown, setShown] = useState(0);

	const act = (s) => {
		if (s.kind === 'profile') {
			try {
				window.sessionStorage.setItem(MEMBER_TAB_KEY, 'profile');
			} catch (e) {
				/* opens on the first tab */
			}
			setTeamPerson(me.id);
			setView('team');
			return;
		}
		if (s.kind === 'review') {
			setProject(s.review.project_id);
			setSearch(s.review.title);
			setView(s.review.tab);
			return;
		}
		dismiss([s.key]);
	};

	// One message at a time (SPEC.md 7.0): the others stay in the page, hidden, behind ‹ ›.
	const at = Math.min(shown, Math.max(0, list.length - 1));
	const move = (step) => setShown((at + step + list.length) % list.length);

	return (
		<header className="md-top" aria-label="Today">
			{list.length > 0 && (
				<div className="md-band">
					{list.map((s, i) => (
						<div key={s.key} className={'md-strip t-' + s.tone} role="status" hidden={i !== at}>
							<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
								<path d={ICON[s.kind]} />
							</svg>
							<p>
								<b>{s.title}</b> {s.text}
								{s.meta && <span className="md-meta"> · {s.meta}</span>}
							</p>
							{list.length > 1 && (
								<span className="md-pager">
									<button type="button" aria-label="Previous message" onClick={() => move(-1)}>
										‹
									</button>
									{i + 1} of {list.length}
									<button type="button" aria-label="Next message" onClick={() => move(1)}>
										›
									</button>
								</span>
							)}
							<button type="button" className="md-strip-x" onClick={() => act(s)}>
								{s.ok || 'Dismiss'}
							</button>
						</div>
					))}
				</div>
			)}
			<div className="md-row">
				<div className="md-hello">
					<h1>
						{greeting()}, {me.name}
					</h1>
					<span className="md-date">
						{weekdayDate(today)}
						<Weather />
					</span>
				</div>
				<Bell />
				<div className="md-me">
					<button type="button" className="me-btn" title="Open my page" onClick={() => (setTeamPerson(me.id), setView('team'))}>
						<Avatar person={me} />
						<b>{me.name}</b>
						<span className={'role r-' + me.role}>{ROLE[me.role]}</span>
					</button>
					<button type="button" className="btn small ghost" onClick={onSignOut}>
						Sign out
					</button>
				</div>
			</div>
		</header>
	);
}

import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { short, toDate } from '../../lib/format.js';
import { assignedFor, daysIn, fmtDur, inRange, perfRange, perfShift, perfStats, periodWord, personEvents } from '../../lib/perf.js';
import { ROLE, initials, isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import { ReviewsOfWork } from '../review/ReviewLists.jsx';
import Calendar from './Calendar.jsx';
import { AssignedList, BarChart, LogWorkDialog, PeriodHead, ProjectMix, SetCodeDialog, dayLabel } from './parts.jsx';
import { downloadReport } from './pdf.js';

export const trend = (a, b) =>
	a === b ? <span className="tr eq">same as previous</span> : a > b ? <span className="tr up">▲ {a - b} vs previous</span> : <span className="tr down">▼ {b - a} vs previous</span>;

const greeting = () => {
	const h = new Date().getHours();
	return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

// Crops an image file to a 160 px square JPEG data URL (reference pickPhoto).
function cropPhoto(file) {
	return new Promise((resolve, reject) => {
		if (file.size > 8 * 1024 * 1024) return reject(new Error('That image is too large (8 MB max).'));
		const fr = new FileReader();
		fr.onload = () => {
			const img = new Image();
			img.onload = () => {
				const S = 160;
				const c = document.createElement('canvas');
				c.width = c.height = S;
				const side = Math.min(img.width, img.height);
				c.getContext('2d').drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, S, S);
				resolve(c.toDataURL('image/jpeg', 0.8));
			};
			img.onerror = () => reject(new Error("That file isn't an image."));
			img.src = fr.result;
		};
		fr.readAsDataURL(file);
	});
}

function Profile({ person, self }) {
	const { api, dispatch, toast, confirm, me, setView } = usePortal();
	const admin = isAdmin(me);
	const canEdit = self || admin;
	const [f, setF] = useState({ name: person.name, title: person.title || '', email: person.email || '', phone: person.phone || '', address: person.address || '', drive_url: person.drive_url || '', notes: person.notes || '', role: person.role });
	const [codeFor, setCodeFor] = useState(null);
	const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

	const save = async (changes, msg) => {
		try {
			const row = await api.patch(`members/${person.id}`, changes);
			dispatch({ type: 'upsert', table: 'members', row });
			toast(msg || 'Profile saved');
		} catch (err) {
			toast(err.message);
		}
	};
	const submit = (e) => {
		e.preventDefault();
		const { role, ...profile } = f;
		save(admin && role !== person.role ? { ...profile, role } : profile);
	};
	const pick = () => {
		const inp = document.createElement('input');
		inp.type = 'file';
		inp.accept = 'image/*';
		inp.onchange = async () => {
			const file = inp.files && inp.files[0];
			if (!file) return;
			try {
				save({ photo: await cropPhoto(file) }, 'Photo updated');
			} catch (err) {
				toast(err.message);
			}
		};
		inp.click();
	};
	const remove = async () => {
		const ok = await confirm({ title: `Remove ${person.name}?`, message: 'They leave the team and are signed out. Past activity stays.', ok: 'Remove', danger: true });
		if (!ok) return;
		try {
			await api.del(`members/${person.id}`);
			dispatch({ type: 'upsert', table: 'members', row: { ...person, active: 0 } });
			toast(`${person.name} removed`);
			setView('team');
		} catch (err) {
			toast(err.message);
		}
	};
	const field = (k, label, type, ph) => (
		<label>
			{label}
			<input type={type || 'text'} value={f[k]} onChange={set(k)} placeholder={ph || ''} disabled={!canEdit} />
		</label>
	);

	return (
		<div className="set-grid">
			<form className="dcard" onSubmit={submit}>
				<div className="dc-head">
					<span className="s-k">{self ? 'My profile' : 'Profile'}</span>
				</div>
				<div className="pf-top">
					<div className="pf-photo">
						{person.photo ? (
							<img src={person.photo} alt="" />
						) : (
							<span className="av big" style={{ background: person.color }}>
								{initials(person.name)}
							</span>
						)}
						{canEdit && (
							<div className="pf-pbtns">
								<button type="button" className="btn small" onClick={pick}>
									{person.photo ? 'Change photo' : 'Add photo'}
								</button>
								{person.photo && (
									<button type="button" className="linkbtn danger" onClick={() => save({ photo: '' }, 'Photo removed')}>
										Remove
									</button>
								)}
							</div>
						)}
					</div>
					<div className="pf-fields">
						{field('name', 'Full name')}
						{field('title', 'Job title', 'text', 'e.g. SEO specialist')}
						{field('email', 'Email', 'email')}
						{field('phone', 'Phone', 'tel')}
						{field('address', 'Address')}
						{field('drive_url', 'Google Drive link', 'url', 'https://drive.google.com/…')}
						<label className="wide">
							Notes
							<textarea value={f.notes} onChange={set('notes')} maxLength={500} disabled={!canEdit} placeholder="Anything useful for the team" />
						</label>
						{admin && !self ? (
							<label>
								Access level
								<select value={f.role} onChange={set('role')}>
									{Object.entries(ROLE).map(([k, v]) => (
										<option key={k} value={k}>
											{v}
										</option>
									))}
								</select>
							</label>
						) : (
							<label>
								Access level
								<input value={ROLE[person.role]} disabled />
							</label>
						)}
					</div>
				</div>
				{canEdit && (
					<div className="pf-save">
						<button type="submit" className="btn primary">
							Save profile
						</button>
					</div>
				)}
			</form>
			{admin && (
				<section className="dcard">
					<div className="dc-head">
						<span className="s-k">Sign-in</span>
					</div>
					<div className="sched-ed codes">
						<span className={'att ' + (person.role === 'admin' ? 'b-work' : person.has_code ? 'b-work' : 'lv-sick')}>{person.role === 'admin' ? 'WordPress login' : person.has_code ? 'Active' : 'No sign-in yet'}</span>
						{self ? (
							<span className="muted">You sign in with WordPress.</span>
						) : person.role !== 'admin' ? (
							<button type="button" className="btn small" onClick={() => setCodeFor(person)}>
								Set code
							</button>
						) : null}
						{!self && (
							<button type="button" className="linkbtn danger" onClick={remove}>
								Remove from team
							</button>
						)}
					</div>
				</section>
			)}
			{codeFor && <SetCodeDialog member={codeFor} onClose={() => setCodeFor(null)} />}
		</div>
	);
}

const KIND = {
	assigned: ['Assigned', '＋', 'k-as'],
	completed: ['Completed', '✓', 'k-dn'],
	logged: ['Logged work', '✎', 'k-lg'],
	added: ['Added', '＋', 'k-ad'],
	changed: ['Changed', '↻', 'k-ch'],
	status: ['Status', '⇄', 'k-ch'],
	progress: ['Progress', '▲', 'k-ch'],
	deleted: ['Deleted', '✕', 'k-dl'],
	restored: ['Restored', '↺', 'k-dn'],
	project: ['Project', '◆', 'k-ch'],
};

function ActivityFeed({ pid }) {
	const { api, data } = usePortal();
	const [audit, setAudit] = useState([]);
	const [f, setF] = useState('all');
	useEffect(() => {
		api.get('audit').then(setAudit).catch(() => setAudit([]));
	}, [api]);
	const all = personEvents(data, pid, audit);
	const isOther = (x) => !['assigned', 'completed', 'logged'].includes(x.kind);
	const ev = all.filter((x) => f === 'all' || (f === 'changes' ? isOther(x) : x.kind === f));
	const cnt = (k) => all.filter((x) => (k === 'changes' ? isOther(x) : x.kind === k)).length;
	const months = {};
	ev.forEach((x) => (months[x.date.slice(0, 7)] = months[x.date.slice(0, 7)] || []).push(x));
	const chip = (k, l, n) => (
		<button type="button" className={'ra-chip ' + (f === k ? 'on' : '')} aria-pressed={f === k} onClick={() => setF(k)}>
			{l}
			<span>{n}</span>
		</button>
	);
	return (
		<>
			<div className="ra-bar">
				{chip('all', 'All', all.length)}
				{chip('assigned', 'Assigned', cnt('assigned'))}
				{chip('completed', 'Completed', cnt('completed'))}
				{chip('logged', 'Logged work', cnt('logged'))}
				{chip('changes', 'Other changes', cnt('changes'))}
			</div>
			{Object.keys(months).length ? (
				Object.keys(months)
					.sort()
					.reverse()
					.map((k) => {
						const list = months[k];
						const sum = ['assigned', 'completed', 'logged'].map((z) => [z, list.filter((x) => x.kind === z).length]).filter((z) => z[1]);
						return (
							<section className="dcard ra-month" key={k}>
								<div className="ra-mhead">
									<h3>{toDate(k + '-01').toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3>
									<div className="ra-sum">
										{sum.map(([z, n]) => (
											<span key={z} className={KIND[z][2]}>
												{n} {KIND[z][0].toLowerCase()}
											</span>
										))}
										<span className="ra-tot">
											{list.length} {list.length === 1 ? 'entry' : 'entries'}
										</span>
									</div>
								</div>
								<ol className="ra-list">
									{list.map((x, i) => {
										const [lab, ico, cls] = KIND[x.kind] || KIND.changed;
										const d = toDate(x.date);
										return (
											<li className="ra-row" key={i}>
												<div className="ra-date">
													<b>{d.getDate()}</b>
													<span>{d.toLocaleDateString(undefined, { weekday: 'short' })}</span>
												</div>
												<span className={'ra-ico ' + cls} aria-hidden="true">
													{ico}
												</span>
												<div className="ra-body">
													<div className="ra-top">
														<span className={'ra-kind ' + cls}>{lab}</span>
														<b className="ra-title">
															{x.title || 'Untitled'}
															{x.qty ? <em> ×{x.qty}</em> : null}
														</b>
													</div>
													<div className="ra-meta">
														{x.client && <span className="ra-proj">{x.client}</span>}
														{x.src && <span>{x.src}</span>}
														{x.detail && <span>{x.detail}</span>}
													</div>
												</div>
												<time className="ra-time">{toDate(x.at.length > 10 ? x.at : x.at + ' 00:00:00').toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
											</li>
										);
									})}
								</ol>
							</section>
						);
					})
			) : (
				<section className="dcard">
					<p className="d-empty">{f === 'all' ? 'No activity yet. Assigned tasks, completed work and changes will appear here.' : 'Nothing of this kind yet.'}</p>
				</section>
			)}
		</>
	);
}

// Member page (SPEC.md 7.6): own page for members, any member's page for admin/lead.
export default function MemberPage({ pid, perf, setPerf, onBack }) {
	const { api, data, dispatch, toast, me, today } = usePortal();
	const [tab, setTab] = useState('dash');
	const [filter, setFilter] = useState('all');
	const [proj, setProj] = useState('');
	const [logOpen, setLogOpen] = useState(false);
	const person = data.members[pid];
	if (!person) return null;
	const self = pid === me.id;
	const admin = isAdmin(me);
	const r = perfRange(perf.mode, perf.anchor);
	const prevR = perfRange(perf.mode, perfShift(perf.mode, perf.anchor, -1));
	const acts = rowsOf(data, 'activity').filter((x) => x.member_id === pid);
	const mine = acts.filter((x) => inRange(x, r));
	const st = perfStats(mine);
	const pv = perfStats(acts.filter((x) => inRange(x, prevR)));
	const open = assignedFor(data, pid, today);
	const word = periodWord(perf.mode);

	const removeActivity = async (x) => {
		try {
			await api.del(`activity/${x.id}`);
			dispatch({ type: 'remove', table: 'activity', id: x.id });
			toast('Removed');
		} catch (err) {
			toast(err.message);
		}
	};
	const pdf = async () => {
		toast('Preparing the PDF…');
		try {
			await downloadReport(data, pid, perf, today);
			toast('Report downloaded');
		} catch (err) {
			toast("The report couldn't be created. Try again.");
		}
	};

	const tabs = [
		['dash', self ? 'My dashboard' : 'Overview'],
		['assigned', self ? 'My tasks' : 'Tasks', open.length || ''],
		['calendar', 'Calendar'],
		['activity', 'Recent Activities'],
		['profile', self ? 'Settings' : 'Profile'],
	];

	let body;
	if (tab === 'dash') {
		const urgent = open.filter((x) => x.priority === 'urgent').length;
		body = (
			<div className="dash one-col">
				<div className="dash-main">
					<div className="dash-top">
						<section className="dcard d-hello">
							<h2>{self ? `${greeting()}, ${person.name.split(' ')[0]}` : person.name}</h2>
							<p className="d-date">
								{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
								{person.title ? ' · ' + person.title : ''}
							</p>
							<div className="d-now">
								<span className="dn in">
									<b>{open.length}</b>to do
								</span>
								<span className="dn br">
									<b>{urgent}</b>urgent or overdue
								</span>
								<span className="dn out">
									<b>{st.total}</b>done {word}
								</span>
							</div>
							<p className="d-off">{trend(st.total, pv.total)}</p>
							<div className="d-acts">
								{(self || admin) && (
									<button type="button" className="btn small primary" onClick={() => setLogOpen(true)}>
										+ Log work
									</button>
								)}
								<button type="button" className="btn small" onClick={() => (setTab('assigned'), setFilter('done'))}>
									See completed
								</button>
							</div>
						</section>
						<section className="dcard">
							<div className="dc-head">
								<span className="s-k">{self ? 'My tasks' : 'Assigned'}</span>
								<button type="button" className="linkbtn" onClick={() => setTab('assigned')}>
									See all {open.length ? `(${open.length})` : ''}
								</button>
							</div>
							<AssignedList list={open} limit={4} emptyText={`${self ? 'Nothing assigned to you right now.' : 'Nothing assigned.'} Tasks assigned in Meeting Minutes and Monthly Tasks show up here.`} />
						</section>
					</div>
					<section className="dcard d-hours">
						<div className="dc-head">
							<span className="s-k">
								{self ? 'My completed tasks' : 'Completed tasks'} · {word}
							</span>
							<span className="muted">
								{st.done} from task lists · {st.manual} logged
							</span>
						</div>
						<ProjectMix list={mine} />
						<BarChart
							bars={daysIn(r).map((ds) => {
								const n = perfStats(mine.filter((x) => x.date === ds)).total;
								return { key: ds, label: dayLabel(perf.mode, ds), n, future: ds > today, today: ds === today, title: `${short(ds)}: ${n} ${n === 1 ? 'task' : 'tasks'}`, onClick: () => setPerf({ mode: 'day', anchor: ds }) };
							})}
						/>
					</section>
				</div>
			</div>
		);
	} else if (tab === 'assigned') {
		const inProj = (x) => !proj || x.project_id === proj;
		const todo = open.filter((x) => x.group === 'todo' && inProj(x));
		const doing = open.filter((x) => x.group === 'doing' && inProj(x));
		const doneList = mine.filter(inProj).sort((a, b) => String(b.at).localeCompare(String(a.at)));
		const counts = { all: todo.length + doing.length + doneList.length, todo: todo.length, doing: doing.length, done: doneList.length };
		const projects = [...new Set([...open.map((x) => x.project_id), ...mine.map((x) => x.project_id).filter(Boolean)])].filter((c) => data.projects[c]);
		const chip = (k, l) => (
			<button type="button" className={'sg tf-' + k} aria-selected={filter === k} onClick={() => setFilter(k)}>
				<span className="sg-dot" />
				{l}
				<span className="sg-n">{counts[k]}</span>
			</button>
		);
		const group = (title, list, cls) =>
			list.length > 0 && (
				<div className="tk-group">
					<h4 className={'tk-h ' + cls}>
						{title}
						<span>{list.length}</span>
					</h4>
					<AssignedList list={list} />
				</div>
			);
		body = (
			<>
				<ReviewsOfWork memberId={pid} self={self} />
				<div className="tk-bar">
					<div className="segs" role="tablist" aria-label="Filter tasks">
						{chip('all', 'All')}
						{chip('todo', 'To start')}
						{chip('doing', 'In progress')}
						{chip('done', 'Completed')}
					</div>
					<label className="act-who">
						Project{' '}
						<select value={proj} onChange={(e) => setProj(e.target.value)}>
							<option value="">All projects</option>
							{projects.map((c) => (
								<option key={c} value={c}>
									{data.projects[c].name}
								</option>
							))}
						</select>
					</label>
					{(self || admin) && (
						<button type="button" className="btn small primary" onClick={() => setLogOpen(true)}>
							+ Log work
						</button>
					)}
					<button type="button" className="btn small" title="PDF of completed, missed and open tasks for this period" onClick={pdf}>
						⬇ Download PDF report
					</button>
				</div>
				{filter !== 'done' && (
					<section className="dcard tk-card">
						{filter !== 'doing' && group('To start', todo, 'g-todo')}
						{filter !== 'todo' && group('In progress', doing, 'g-doing')}
						{!todo.length && !doing.length && <p className="d-empty">Nothing waiting{proj ? ' for this project' : ''}. Tasks assigned in Meeting Minutes and Monthly Tasks show up here.</p>}
					</section>
				)}
				{(filter === 'all' || filter === 'done') && doneList.length > 0 && (
					<section className="dcard tk-done">
						<div className="tk-group">
							<h4 className="tk-h g-done">
								Completed {word}
								<span>{doneList.length}</span>
							</h4>
							<ul className="as-list">
								{doneList.map((x) => (
									<li key={x.id}>
										<span className={'as-tag ' + (x.kind === 'manual' ? 'at-logged' : x.source === 'board' ? 'at-board' : 'at-monthly')}>{x.kind === 'manual' ? 'Logged' : x.source === 'board' ? 'Meeting' : 'Recurring'}</span>
										<div className="as-main">
											<b>
												{x.title}
												{x.qty > 1 ? ` ×${x.qty}` : ''}
											</b>
											<span>{[data.projects[x.project_id]?.name || 'Other work', x.detail, x.minutes ? fmtDur(x.minutes) : ''].filter(Boolean).join(' · ')}</span>
										</div>
										<span className="as-when">{short(x.date)}</span>
										{(admin || (x.kind === 'manual' && self)) && (
											<button type="button" className="nt-x" aria-label="Remove" onClick={() => removeActivity(x)}>
												✕
											</button>
										)}
									</li>
								))}
							</ul>
						</div>
					</section>
				)}
				{filter === 'done' && !doneList.length && <p className="d-empty">Nothing completed {word}{proj ? ' for this project' : ''}.</p>}
			</>
		);
	} else if (tab === 'calendar') {
		body = <Calendar pid={pid} />;
	} else if (tab === 'activity') {
		body = <ActivityFeed pid={pid} />;
	} else {
		body = <Profile key={pid + (person.updated_at || '')} person={person} self={self} />;
	}

	return (
		<div className="grp-member">
			{isManager(me) && onBack && (
				<button type="button" className="linkbtn back" onClick={onBack}>
					← All team members
				</button>
			)}
			<nav className="ttabs etabs" role="tablist" aria-label="Sections">
				{tabs.map(([k, l, n]) => (
					<button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
						{l}
						{n ? <span className="tt-n">{n}</span> : null}
					</button>
				))}
			</nav>
			{(tab === 'dash' || tab === 'assigned') && <PeriodHead perf={perf} setPerf={setPerf} />}
			{body}
			{logOpen && <LogWorkDialog open onClose={() => setLogOpen(false)} memberId={pid} date={perf.mode === 'day' ? perf.anchor : today} />}
		</div>
	);
}

export { Avatar };

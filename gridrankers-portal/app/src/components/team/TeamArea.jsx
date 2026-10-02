import { useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { short, toDate } from '../../lib/format.js';
import { assignedFor, daysIn, fmtDur, inRange, perfRange, perfShift, perfStats, periodWord } from '../../lib/perf.js';
import { mayDecide, pendingReviews } from '../../lib/reviews.js';
import { ROLE, isAdmin } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import { Trash } from '../RecentActivities.jsx';
import LeaveTab from './LeaveTab.jsx';
import { trend } from './MemberPage.jsx';
import Notifications, { attentionItems } from './Notifications.jsx';
import { AutoMessages, DaysOff } from './PeopleSettings.jsx';
import { AddMemberDialog, BarChart, LogWorkDialog, PeriodHead, SetCodeDialog, dayLabel } from './parts.jsx';

const greeting = () => {
	const h = new Date().getHours();
	return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
};

// Admin settings sections (SPEC.md 7.5), each opened from the menu on the left.
export const ADMIN_SECTIONS = [
	['members', 'Members & access'],
	['daysoff', 'Days off'],
	['messages', 'Automatic messages'],
	['deleted', 'Deleted projects'],
	['export', 'Export all data'],
];

// Team sections for the Super Admin / Team Leader (SPEC.md 7.5). With `section` it renders just
// that section inside My page (team, leave, activity or settings); otherwise its own tabs.
export default function TeamArea({ perf, setPerf, onPerson, section }) {
	const { api, data, dispatch, toast, confirm, me, today } = usePortal();
	const admin = isAdmin(me);
	const [ownTab, setTab] = useState('dash');
	const tab = section || ownTab;
	const [sec, setSec] = useState('members');
	const [audit, setAudit] = useState([]);
	const [dialog, setDialog] = useState(null);
	const [who, setWho] = useState('');
	const [q, setQ] = useState('');

	useEffect(() => {
		api.get('audit').then(setAudit).catch(() => setAudit([]));
	}, [api]);

	const people = rowsOf(data, 'members')
		.filter((m) => +m.active !== 0)
		.sort((a, b) => a.name.localeCompare(b.name));
	const r = perfRange(perf.mode, perf.anchor);
	const prevR = perfRange(perf.mode, perfShift(perf.mode, perf.anchor, -1));
	const allActs = rowsOf(data, 'activity');
	const acts = allActs.filter((x) => inRange(x, r));
	const prevActs = allActs.filter((x) => inRange(x, prevR));
	const word = periodWord(perf.mode);
	const openOf = (id) => assignedFor(data, id, today);
	const openCount = Object.fromEntries(people.map((p) => [p.id, openOf(p.id).length]));
	const teamStats = perfStats(acts);
	const prevTeam = perfStats(prevActs);
	const notes = attentionItems(data, me, audit, today).length + pendingReviews(data).filter((r) => mayDecide(r, me)).length;

	const waiting = rowsOf(data, 'leave').filter((l) => l.status === 'pending' && data.members[l.member_id] && data.members[l.member_id].role === 'member').length;
	const tabsList = [['dash', 'Dashboard', notes || ''], ['activity', 'Activity'], ['team', 'Team', people.length], ['leave', 'Leave', waiting || ''], ...(admin ? [['settings', 'Settings']] : [])];

	const removePerson = async (p) => {
		const ok = await confirm({ title: `Remove ${p.name}?`, message: 'They leave the team and are signed out. Past activity stays.', ok: 'Remove', danger: true });
		if (!ok) return;
		try {
			await api.del(`members/${p.id}`);
			dispatch({ type: 'upsert', table: 'members', row: { ...p, active: 0 } });
			toast(`${p.name} removed`);
		} catch (err) {
			toast(err.message);
		}
	};

	const copyReport = (pid) => {
		const p = data.members[pid];
		const list = allActs.filter((x) => inRange(x, r) && x.member_id === pid).sort((a, b) => String(a.at).localeCompare(String(b.at)));
		const byProject = new Map();
		list.forEach((x) => {
			const k = data.projects[x.project_id] ? data.projects[x.project_id].name : 'Other work';
			byProject.set(k, [...(byProject.get(k) || []), x]);
		});
		let out = `${p ? p.name : 'Team'} — completed work — ${r.label}\n${'='.repeat(40)}\nTotal: ${perfStats(list).total} tasks across ${byProject.size} projects\n`;
		[...byProject].forEach(([k, xs]) => {
			out += `\n${k} (${perfStats(xs).total})\n`;
			xs.forEach((x) => (out += `  · ${x.title}${x.qty > 1 ? ` ×${x.qty}` : ''}${x.detail ? ` — ${x.detail}` : ''} (${short(x.date)})\n`));
		});
		(navigator.clipboard ? navigator.clipboard.writeText(out) : Promise.reject())
			.then(() => toast('Report copied. Paste it into your email or doc.'))
			.catch(() => confirm({ title: 'Copy this report', message: out.slice(0, 1500), ok: 'Close' }));
	};

	const exportAll = async () => {
		try {
			const res = await api.get('export');
			const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			a.download = `gridrankers-portal-export-${today}.json`;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(url), 4000);
			toast('Export downloaded');
		} catch (err) {
			toast(err.message);
		}
	};

	let body;
	if (tab === 'dash') {
		const unassigned = rowsOf(data, 'meeting_tasks').filter((i) => i.status !== 'done' && !(i.assignees || []).some((a) => data.members[a.id]) && data.projects[i.project_id]).length;
		const mx = Math.max(1, ...people.map((p) => openCount[p.id]));
		const bars =
			perf.mode === 'day'
				? people.map((p) => {
						const n = perfStats(acts.filter((x) => x.member_id === p.id)).total;
						return { key: p.id, label: p.name.split(' ')[0], n, title: `${p.name}: ${n} ${n === 1 ? 'task' : 'tasks'}`, onClick: () => onPerson(p.id) };
					})
				: daysIn(r).map((ds) => {
						const n = perfStats(acts.filter((x) => x.date === ds)).total;
						return { key: ds, label: dayLabel(perf.mode, ds), n, future: ds > today, today: ds === today, title: `${short(ds)}: ${n} ${n === 1 ? 'task' : 'tasks'}`, onClick: () => setPerf({ mode: 'day', anchor: ds }) };
					});
		body = (
			<>
				<Notifications audit={audit} onPerson={onPerson} />
				<div className="dash">
					<div className="dash-main">
						<div className="dash-top">
							<section className="dcard d-hello">
								<h2>
									{greeting()}, {me.name.split(' ')[0]}
								</h2>
								<p className="d-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</p>
								<div className="d-now">
									<span className="dn in">
										<b>{teamStats.total}</b>done {word}
									</span>
									<span className="dn br">
										<b>{people.reduce((a, p) => a + openCount[p.id], 0)}</b>assigned
									</span>
									<span className="dn out">
										<b>{unassigned}</b>unassigned
									</span>
								</div>
								<div className="d-acts">
									<button type="button" className="btn small primary" onClick={() => setDialog({ type: 'add' })}>
										+ Add member
									</button>
									<button type="button" className="btn small" onClick={() => setDialog({ type: 'log' })}>
										+ Log work
									</button>
								</div>
							</section>
							<section className="dcard">
								<div className="dc-head">
									<span className="s-k">Workload</span>
									<span className="muted">Open tasks per person</span>
								</div>
								{people.length ? (
									<ul className="wl-list">
										{people.map((p) => {
											const open = openOf(p.id);
											const urg = open.filter((x) => x.priority === 'urgent').length;
											return (
												<li key={p.id} onClick={() => onPerson(p.id)}>
													<Avatar person={p} small />
													<div className="wl-main">
														<b>{p.name}</b>
														<span className="wl-bar">
															<i style={{ width: ((open.length / mx) * 100).toFixed(0) + '%' }} className={urg ? 'urg' : ''} />
														</span>
													</div>
													<span className="wl-n">
														{open.length}
														{urg ? <em> {urg}!</em> : null}
													</span>
												</li>
											);
										})}
									</ul>
								) : (
									<p className="d-empty">No team members yet.</p>
								)}
							</section>
						</div>
						<section className="dcard d-hours">
							<div className="dc-head">
								<span className="s-k">Completed tasks · {perf.mode === 'day' ? 'by person' : word}</span>
								<span className="muted">{perf.mode === 'day' ? 'Click a bar to open that person' : 'Click a day for that day'}</span>
							</div>
							<div className="d-hwrap">
								<div className="d-legend">
									<div>
										<i className="lg-w" />
										<span>Total</span>
										<b>{teamStats.total}</b>
									</div>
									<div>
										<i className="lg-b" />
										<span>From boards</span>
										<b>{teamStats.done}</b>
									</div>
									<div>
										<i className="lg-x" />
										<span>Logged manually</span>
										<b>{teamStats.manual}</b>
									</div>
									<div className="lg-att">
										<span>Vs previous</span>
										<b>
											{teamStats.total - prevTeam.total >= 0 ? '+' : ''}
											{teamStats.total - prevTeam.total}
										</b>
										<small>
											{prevTeam.total} last {perf.mode === 'day' ? 'day' : perf.mode === 'week' ? 'week' : 'month'}
										</small>
									</div>
								</div>
								<BarChart bars={bars} />
							</div>
						</section>
					</div>
					<div className="dash-side">
						<section className="dcard d-who">
							<div className="dw-head">
								<h3>Team</h3>
								<span>
									{people.length} {people.length === 1 ? 'member' : 'members'}
								</span>
							</div>
							<ul className="dw-list">
								{people.map((p) => (
									<li key={p.id} onClick={() => onPerson(p.id)}>
										<span className="ec-av">
											<Avatar person={p} small />
										</span>
										<div>
											<b>{p.name}</b>
											<span>
												{openCount[p.id]} to do · {perfStats(acts.filter((x) => x.member_id === p.id)).total} done {word}
											</span>
										</div>
									</li>
								))}
							</ul>
						</section>
					</div>
				</div>
			</>
		);
	} else if (tab === 'activity') {
		const groups = daysIn(r)
			.filter((d) => d <= today)
			.reverse()
			.map((ds) => ({
				ds,
				ev: allActs.filter((a) => a.date === ds && data.members[a.member_id] && (!who || a.member_id === who)).sort((a, b) => String(b.at).localeCompare(String(a.at))),
			}))
			.filter((g) => g.ev.length);
		const count = groups.reduce((a, g) => a + g.ev.length, 0);
		body = (
			<>
				<div className="tm-bar">
					<label className="act-who">
						Show{' '}
						<select value={who} onChange={(e) => setWho(e.target.value)}>
							<option value="">Everyone</option>
							{people.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</label>
					<span className="muted">
						{count} {count === 1 ? 'task' : 'tasks'} completed {word}
					</span>
					{who && (
						<button type="button" className="btn small" onClick={() => copyReport(who)}>
							Copy report
						</button>
					)}
				</div>
				<section className="dcard d-feed act-page">
					{groups.length ? (
						groups.map((g) => (
							<div key={g.ds}>
								<h4>{toDate(g.ds).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h4>
								<ul>
									{g.ev.map((a) => {
										const p = data.members[a.member_id];
										return (
											<li key={a.id} onClick={() => onPerson(p.id)}>
												<time>{toDate(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</time>
												<span className={'f-ico f-' + (a.kind === 'manual' ? 'req' : 'task')} aria-hidden="true">
													{a.kind === 'manual' ? '✎' : '✓'}
												</span>
												<Avatar person={p} small />
												<span>
													<b>{p.name}</b> {a.kind === 'manual' ? 'logged' : 'completed'} “{a.title}”{a.qty > 1 ? ' ×' + a.qty : ''}
													{data.projects[a.project_id] ? ' · ' + data.projects[a.project_id].name : ''}
													{a.minutes ? ' · ' + fmtDur(a.minutes) : ''}
												</span>
											</li>
										);
									})}
								</ul>
							</div>
						))
					) : (
						<p className="d-empty">No completed tasks {word}.</p>
					)}
				</section>
			</>
		);
	} else if (tab === 'leave') {
		body = <LeaveTab />;
	} else if (tab === 'team') {
		const shown = people.filter((p) => !q || p.name.toLowerCase().includes(q.trim().toLowerCase()));
		body = (
			<>
				<div className="tm-bar">
					<label className="dw-search tm-search">
						<span aria-hidden="true">⌕</span>
						<input type="search" placeholder="Search people…" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
					</label>
					<span className="muted">
						{people.length} {people.length === 1 ? 'member' : 'members'} · click someone to see their tasks and completed work
					</span>
					<button type="button" className="btn primary" onClick={() => setDialog({ type: 'add' })}>
						+ Add member
					</button>
				</div>
				<div className="mcards emp-grid">
					{shown.map((p) => {
						const ml = acts.filter((x) => x.member_id === p.id);
						const s2 = perfStats(ml);
						const pv = perfStats(prevActs.filter((x) => x.member_id === p.id));
						const open = openOf(p.id);
						const urg = open.filter((x) => x.priority === 'urgent').length;
						const last = [...ml].sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
						return (
							<article key={p.id} className="card emp-card ec2" tabIndex={0} role="button" aria-label={`Open ${p.name}`} onClick={() => onPerson(p.id)} onKeyDown={(e) => e.key === 'Enter' && onPerson(p.id)}>
								<div className="ec-head">
									<span className="ec-av">
										<Avatar person={p} small />
									</span>
									<div className="ec-id">
										<b>{p.name}</b>
										<span>{p.title || ROLE[p.role]}</span>
									</div>
								</div>
								<div className="ec-status">
									<span className={'ec-pill ' + (urg ? 'lv-sick' : 'pl-week')}>
										{open.length} to do{urg ? ` · ${urg} urgent` : ''}
									</span>
								</div>
								<div className="ec-hrs">
									<div className="ec-hrow">
										<b>{s2.total}</b>
										<span>done {word}</span>
										{trend(s2.total, pv.total)}
									</div>
									<div className="ec-sub">
										<span>
											{s2.done} from boards · {s2.manual} logged
										</span>
										<span>{new Set(ml.map((x) => x.project_id || 'custom')).size} projects</span>
									</div>
								</div>
								<div className="ec-foot2">
									<span className="ec-last">{last ? `Last: ${last.title}` : 'No tasks yet'}</span>
								</div>
							</article>
						);
					})}
					<button type="button" className="card add-card" aria-label="Add member" onClick={() => setDialog({ type: 'add' })}>
						<span className="plus" aria-hidden="true">
							+
						</span>
						<b>Add member</b>
						<small>Add someone, their role and sign-in code</small>
					</button>
				</div>
			</>
		);
	} else {
		const panes = {
			members: (
				<section className="dcard">
					<div className="dc-head">
						<span className="s-k">Members &amp; access</span>
						<button type="button" className="btn small primary" onClick={() => setDialog({ type: 'add' })}>
							+ Add member
						</button>
					</div>
					<div className="tbl-wrap">
						<table className="hrs mtable">
							<thead>
								<tr>
									<th>Member</th>
									<th>Role</th>
									<th>Contact</th>
									<th>Open tasks</th>
									<th>Sign-in</th>
									<th />
								</tr>
							</thead>
							<tbody>
								{people.map((p) => (
									<tr key={p.id}>
										<td>
											<span className="mt-who">
												<Avatar person={p} small />
												<b>{p.name}</b>
											</span>
											{p.title && <div className="muted">{p.title}</div>}
										</td>
										<td>
											<span className={'role r-' + p.role}>{ROLE[p.role]}</span>
										</td>
										<td>
											{[p.email, p.phone].filter(Boolean).join(' · ') || <span className="muted">—</span>}
										</td>
										<td>
											<b>{openCount[p.id]}</b>
										</td>
										<td>
											<span className={'att ' + (p.role === 'admin' || p.has_code ? 'b-work' : 'lv-sick')}>{p.role === 'admin' ? 'WordPress login' : p.has_code ? 'Active' : 'No sign-in yet'}</span>
											{p.id !== me.id && p.role !== 'admin' && (
												<button type="button" className="linkbtn" onClick={() => setDialog({ type: 'code', member: p })}>
													Set code
												</button>
											)}
										</td>
										<td className="mt-acts">
											<button type="button" className="linkbtn" onClick={() => onPerson(p.id)}>
												Open
											</button>
											{p.id !== me.id && (
												<button type="button" className="linkbtn danger" onClick={() => removePerson(p)}>
													Remove
												</button>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
					<p className="hint">Super Admins sign in with their WordPress account. Team Leaders and Members sign in with the code set here; setting a new code signs them out everywhere.</p>
				</section>
			),
			daysoff: <DaysOff />,
			messages: <AutoMessages />,
			deleted: (
				<Trash
					entries={rowsOf(data, 'trash').filter((e) => e.type === 'grp_projects')}
					title="Deleted projects"
					hint="Kept 30 days · restoring a project brings back the tasks deleted with it"
					empty="No deleted projects."
				/>
			),
			export: (
				<section className="dcard">
					<div className="dc-head">
						<span className="s-k">Export all data</span>
					</div>
					<p className="hint">Downloads every project, task, record, team member, activity and log as one JSON file (same format as the old portal export).</p>
					<button type="button" className="btn small" onClick={exportAll}>
						⬇ Export all data
					</button>
				</section>
			),
		};
		body = section ? (
			<div className="as-wrap">
				<nav className="as-nav" aria-label="Admin settings">
					{ADMIN_SECTIONS.map(([k, l]) => (
						<button key={k} type="button" aria-current={sec === k ? 'page' : undefined} onClick={() => setSec(k)}>
							{l}
						</button>
					))}
				</nav>
				<div className="as-pane">{panes[sec]}</div>
			</div>
		) : (
			<div className="set-grid">
				{panes.members}
				{panes.deleted}
				{panes.daysoff}
				{panes.messages}
				{panes.export}
			</div>
		);
	}

	return (
		<>
			{!section && (
				<nav className="ttabs" role="tablist" aria-label="Team sections">
					{tabsList.map(([k, l, n]) => (
						<button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
							{l}
							{n ? <span className="tt-n">{n}</span> : null}
						</button>
					))}
				</nav>
			)}
			{tab !== 'settings' && tab !== 'leave' && <PeriodHead perf={perf} setPerf={setPerf} />}
			{body}
			{dialog && dialog.type === 'add' && <AddMemberDialog onClose={() => setDialog(null)} />}
			{dialog && dialog.type === 'code' && <SetCodeDialog member={dialog.member} onClose={() => setDialog(null)} />}
			{dialog && dialog.type === 'log' && <LogWorkDialog open onClose={() => setDialog(null)} date={perf.mode === 'day' ? perf.anchor : today} />}
		</>
	);
}

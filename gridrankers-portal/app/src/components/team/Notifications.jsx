import { useState } from 'react';
import { usePortal } from '../../context.js';
import { dateTime } from '../../lib/format.js';
import { assignedFor } from '../../lib/perf.js';
import { isAdmin } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Avatar from '../Avatar.jsx';
import { WaitingForReview } from '../review/ReviewLists.jsx';

const WEEK = 7 * 86400000;

// Dismissable notifications (SPEC.md 6.9): members without a code, member edits, unassigned
// urgent tasks, overdue recurring work. Dismissals are per person; sticky items return after 7 days.
export function attentionItems(data, me, audit, today) {
	const out = [];
	const members = rowsOf(data, 'members').filter((m) => +m.active !== 0);
	if (isAdmin(me)) {
		members.filter((p) => p.role !== 'admin' && !p.has_code).forEach((p) => out.push({ p, key: `code:${p.id}`, sticky: true, icon: '🔑', text: 'has no sign-in code yet — set one in Settings' }));
	}
	(audit || [])
		.filter((x) => x.kind === 'edit' && (x.by_role || 'member') === 'member' && Date.now() - new Date(x.at.replace(' ', 'T') + 'Z').getTime() < 14 * 86400000)
		.forEach((x) =>
			out.push({
				p: data.members[x.by_member] || { name: 'Someone', id: x.by_member },
				key: `edit:${x.id}`,
				icon: '✎',
				edit: x,
				text: `changed ${(x.changes || []).map((c) => c.label).join(', ')} on “${x.title}”${data.projects[x.project_id] ? ' · ' + data.projects[x.project_id].name : ''}`,
				goto: x.project_id,
				gotab: x.type === 'monthly' ? 'monthly' : 'board',
			})
		);
	const un = rowsOf(data, 'meeting_tasks').filter((i) => i.status !== 'done' && i.priority === 'urgent' && !(i.assignees || []).some((a) => data.members[a.id]) && data.projects[i.project_id]);
	if (un.length) out.push({ key: `unassigned:${un.length}`, icon: '⚠', warn: true, text: `${un.length} urgent ${un.length === 1 ? 'task has' : 'tasks have'} nobody assigned`, goto: un[0].project_id, gotab: 'board' });
	members.filter((p) => assignedFor(data, p.id, today).some((x) => x.kind === 'monthly' && x.priority === 'urgent')).forEach((p) => out.push({ p, key: `overdue:${p.id}:${today}`, icon: '⏰', text: 'has recurring tasks past their due date' }));

	const dismissed = Object.fromEntries(rowsOf(data, 'dismissals').map((d) => [d.notice_key, d.at]));
	return out.filter((a) => {
		const at = dismissed[a.key];
		return !at || (a.sticky && Date.now() - new Date(at.replace(' ', 'T') + 'Z').getTime() > WEEK);
	});
}

export default function Notifications({ audit, onPerson }) {
	const { api, data, dispatch, me, today, toast, setProject, setView } = usePortal();
	const [all, setAll] = useState(false);
	const info = attentionItems(data, me, audit, today);
	const LIMIT = 6;

	const dismiss = async (keys) => {
		try {
			for (const key of keys) dispatch({ type: 'upsert', table: 'dismissals', row: await api.post('notifications/dismiss', { key }) });
			toast(keys.length > 1 ? `${keys.length} notifications dismissed` : 'Notification dismissed');
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<>
			<WaitingForReview />
			{info.length ? (
				<section className="nt-card">
					<div className="nt-head">
						<span>Notifications</span>
						<em>{info.length}</em>
						<button type="button" className="linkbtn" onClick={() => dismiss(info.map((a) => a.key))}>
							Dismiss all
						</button>
					</div>
					<ul className={'nt-list ' + (!all && info.length > LIMIT ? 'clip' : '')}>
						{info.map((a) => (
							<li key={a.key}>
								<span className={'nt-ico ' + (a.warn ? 'k-warn' : 'k-info')} aria-hidden="true">
									{a.icon}
								</span>
								<div className="nt-body">
									<div className="nt-title">
										{a.p && (
											<>
												<b>{a.p.name}</b>{' '}
											</>
										)}
										{a.text}
									</div>
									{a.edit && (
										<div className="nt-meta">
											{(a.edit.changes || []).map((c, i) => (
												<span className="ed-ch" key={i}>
													<b>{c.label}</b>: {c.from} → {c.to}
												</span>
											))}
											<span>{dateTime(a.edit.at)}</span>
										</div>
									)}
								</div>
								<div className="nt-acts">
									{a.goto && data.projects[a.goto] ? (
										<button
											type="button"
											className="linkbtn"
											onClick={() => {
												setProject(a.goto);
												setView(a.gotab || 'board');
											}}
										>
											Open
										</button>
									) : a.p && data.members[a.p.id] ? (
										<button type="button" className="linkbtn" onClick={() => onPerson(a.p.id)}>
											View
										</button>
									) : null}
									<button type="button" className="nt-x" aria-label="Dismiss" onClick={() => dismiss([a.key])}>
										✕
									</button>
								</div>
							</li>
						))}
					</ul>
					{info.length > LIMIT && (
						<button type="button" className="linkbtn nt-more" onClick={() => setAll(!all)}>
							{all ? 'Show less' : `Show all ${info.length}`}
						</button>
					)}
				</section>
			) : (
				<section className="nt-card nt-empty">
					<span className="nt-ok" aria-hidden="true">
						✓
					</span>
					<div>
						<b>Nothing needs attention</b>
						<span>Unassigned urgent work and sign-in problems show up here.</span>
					</div>
				</section>
			)}
		</>
	);
}

export { Avatar };

import { useState } from 'react';
import { usePortal } from '../../context.js';
import { toDate } from '../../lib/format.js';
import { perfRange, perfShift, projectMix } from '../../lib/perf.js';
import { isAdmin, isManager } from '../../lib/roles.js';
import { rowsOf } from '../../lib/store.js';
import Modal from '../Modal.jsx';
import { GENERAL, GENERAL_NAME } from '../../lib/tasks.js';

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Daily / Weekly / Monthly selector with ‹ label › navigation.
export function PeriodHead({ perf, setPerf }) {
	const { today } = usePortal();
	const r = perfRange(perf.mode, perf.anchor);
	const mode = (m, label) => (
		<button type="button" className="sg" role="tab" aria-selected={perf.mode === m} onClick={() => setPerf({ ...perf, mode: m })}>
			{label}
		</button>
	);
	return (
		<div className="mhead">
			<div className="segs" role="tablist" aria-label="Period">
				{mode('day', 'Daily')}
				{mode('week', 'Weekly')}
				{mode('month', 'Monthly')}
			</div>
			<div className="mnav">
				{perf.anchor !== today && (
					<button className="btn small" onClick={() => setPerf({ ...perf, anchor: today })}>
						Today
					</button>
				)}
				<div className="navgrp">
					<button aria-label="Previous" onClick={() => setPerf({ ...perf, anchor: perfShift(perf.mode, perf.anchor, -1) })}>
						‹
					</button>
					<h2>{r.label}</h2>
					<button aria-label="Next" onClick={() => setPerf({ ...perf, anchor: perfShift(perf.mode, perf.anchor, 1) })}>
						›
					</button>
				</div>
			</div>
		</div>
	);
}

// Bar chart (reference .d-chart). bars: [{key, label, n, future, today, onClick, title}]
export function BarChart({ bars }) {
	const top = Math.max(2, Math.ceil(Math.max(1, ...bars.map((b) => b.n)) / 2) * 2);
	return (
		<div className="d-chart" style={{ '--n': bars.length }}>
			<div className="d-grid">
				{[top, Math.round(top / 2), 0].map((v, i) => (
					<div key={i}>
						<span>{v}</span>
					</div>
				))}
			</div>
			<div className="d-bars">
				{bars.map((b) => (
					<button type="button" key={b.key} className={`d-bar ${b.future ? 'fut' : ''} ${b.today ? 'today' : ''}`} title={b.title} onClick={b.onClick}>
						<span className="d-stack">
							<i className="sb-w" style={{ height: ((b.n / top) * 100).toFixed(1) + '%' }} />
						</span>
						<span className="d-lab">{b.label}</span>
					</button>
				))}
			</div>
		</div>
	);
}

export const dayLabel = (mode, ds) => (mode === 'month' ? String(toDate(ds).getDate()) : WD[toDate(ds).getDay()]);

const MIX_COLORS = ['var(--accent)', 'var(--done)', 'var(--doing)', '#9333EA', '#0369A1', '#BE185D', '#4D7C0F'];

export function ProjectMix({ list }) {
	const { data } = usePortal();
	const items = projectMix(list);
	if (!items.length) return null;
	const tot = items.reduce((a, [, v]) => a + v, 0);
	const name = (k) => (k && data.projects[k] ? data.projects[k].name : 'Custom work');
	const color = (k, i) => (k ? MIX_COLORS[i % MIX_COLORS.length] : 'var(--ink-2)');
	return (
		<div className="pmix">
			<span className="pmix-bar">
				{items.map(([k, v], i) => (
					<i key={k || '_'} style={{ width: ((v / tot) * 100).toFixed(1) + '%', background: color(k, i) }} title={`${name(k)}: ${v}`} />
				))}
			</span>
			<span className="pmix-legend">
				{items.map(([k, v], i) => (
					<span key={k || '_'}>
						<i style={{ background: color(k, i) }} />
						{name(k)} <b>{v}</b>
					</span>
				))}
			</span>
		</div>
	);
}

// Open work list (reference assignedList).
export function AssignedList({ list, emptyText, limit }) {
	const { data, setProject, setView } = usePortal();
	if (!list.length) return emptyText ? <p className="d-empty">{emptyText}</p> : null;
	return (
		<ul className="as-list">
			{(limit ? list.slice(0, limit) : list).map((x) => (
				<li key={x.kind + x.id} className={x.priority === 'urgent' ? 'urgent' : ''}>
					<span className={'as-tag at-' + x.kind}>{x.kind === 'board' ? 'Meeting' : 'Recurring'}</span>
					<div className="as-main">
						<b>{x.title}</b>
						<span>
							{x.project_id === GENERAL && x.kind === 'board' ? GENERAL_NAME : data.projects[x.project_id]?.name} · {x.sub}
							{x.when ? ' · ' + x.when : ''}
						</span>
					</div>
					{x.priority === 'urgent' && <span className="as-pri">{x.kind === 'monthly' ? 'Overdue' : 'Urgent'}</span>}
					<button
						type="button"
						className="btn small"
						onClick={() => {
							setProject(x.project_id);
							setView(x.kind === 'board' ? (x.project_id === GENERAL ? 'general' : 'board') : 'monthly');
						}}
					>
						Open
					</button>
				</li>
			))}
		</ul>
	);
}

// "Add manual task" — work that isn't in Meeting Minutes or Monthly Tasks.
export function LogWorkDialog({ open, onClose, memberId, date }) {
	const { api, data, dispatch, toast, me, today } = usePortal();
	const people = rowsOf(data, 'members')
		.filter((m) => +m.active !== 0)
		.sort((a, b) => a.name.localeCompare(b.name));
	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));
	const [f, setF] = useState({ member_id: memberId || me.id, date: date || today, title: '', project_id: '', minutes: '', notes: '' });
	const [error, setError] = useState('');
	const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

	const submit = async (e) => {
		e.preventDefault();
		if (!f.title.trim()) return setError('Say what was done.');
		try {
			const row = await api.post('activity', { ...f, title: f.title.trim(), minutes: f.minutes === '' ? '' : +f.minutes });
			dispatch({ type: 'upsert', table: 'activity', row });
			toast('Manual task added');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpLogTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpLogTitle">Add manual task</h2>
				<p className="hint">For work that isn't in Meeting Minutes or Monthly Tasks.</p>
				<div className="row">
					<label>
						Team member
						<select value={f.member_id} onChange={set('member_id')} disabled={!isManager(me)}>
							{people.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</label>
					<label>
						Date
						<input type="date" value={f.date} onChange={set('date')} />
					</label>
				</div>
				<label>
					What was done
					<input value={f.title} onChange={set('title')} required maxLength={200} placeholder="e.g. Client call about new service pages" autoFocus />
				</label>
				<div className="row">
					<label>
						Project (optional)
						<select value={f.project_id} onChange={set('project_id')}>
							<option value="">Custom / internal work</option>
							{projects.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</select>
					</label>
					<label>
						Time spent (minutes)
						<input type="number" min={0} max={1440} value={f.minutes} onChange={set('minutes')} placeholder="Optional" />
					</label>
				</div>
				<label>
					Notes
					<textarea value={f.notes} onChange={set('notes')} maxLength={1000} placeholder="Optional" />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Add task
					</button>
				</div>
			</form>
		</Modal>
	);
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const generateCode = () => {
	const bytes = new Uint32Array(8);
	window.crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
};

// Set a person's sign-in code (min 6 chars, unique). Shows the code once to pass on.
export function SetCodeDialog({ member, onClose }) {
	const { api, dispatch, toast } = usePortal();
	const [code, setCode] = useState('');
	const [saved, setSaved] = useState('');
	const [error, setError] = useState('');

	const submit = async (e) => {
		e.preventDefault();
		if (code.trim().length < 6) return setError('Use at least 6 characters for the code.');
		try {
			const res = await api.post(`members/${member.id}/code`, { code: code.trim() });
			dispatch({ type: 'upsert', table: 'members', row: { ...member, has_code: true } });
			setSaved(res.code);
			toast(`Code set for ${member.name}. Their other sessions were signed out.`);
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpCodeTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpCodeTitle">Set code · {member.name}</h2>
				{saved ? (
					<>
						<p className="hint">Send this code to {member.name} privately. It isn't shown again.</p>
						<div className="otc">{saved}</div>
						<button type="button" className="btn small" onClick={() => navigator.clipboard && navigator.clipboard.writeText(saved).then(() => toast('Code copied'))}>
							Copy code
						</button>
						<div className="dlg-acts">
							<button type="button" className="btn primary" onClick={onClose}>
								Done
							</button>
						</div>
					</>
				) : (
					<>
						<label>
							Secret code <small>they sign in with this — at least 6 characters</small>
							<span className="ap-code">
								<input value={code} onChange={(e) => setCode(e.target.value)} maxLength={40} autoComplete="off" spellCheck={false} autoFocus />
								<button type="button" className="btn small" onClick={() => setCode(generateCode())}>
									Generate
								</button>
							</span>
						</label>
						<p className="err" role="alert">
							{error}
						</p>
						<div className="dlg-acts">
							<button type="button" className="btn" onClick={onClose}>
								Cancel
							</button>
							<button type="submit" className="btn primary">
								Set code
							</button>
						</div>
					</>
				)}
			</form>
		</Modal>
	);
}

// Add a team member with a role and code. Team Leaders add Team Members only.
export function AddMemberDialog({ onClose }) {
	const { api, dispatch, toast, me } = usePortal();
	const [f, setF] = useState({ name: '', role: 'member', code: '' });
	const [error, setError] = useState('');
	const [done, setDone] = useState(null);
	const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

	const submit = async (e) => {
		e.preventDefault();
		if (!f.name.trim()) return setError('Enter a name.');
		if (f.code && f.code.trim().length < 6) return setError('Use at least 6 characters for the code.');
		try {
			const member = await api.post('members', { name: f.name.trim(), role: f.role });
			let code = '';
			if (f.code.trim()) code = (await api.post(`members/${member.id}/code`, { code: f.code.trim() })).code;
			dispatch({ type: 'upsert', table: 'members', row: { ...member, has_code: !!code } });
			toast(`${member.name} added`);
			setDone({ member, code });
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpAddMemberTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpAddMemberTitle">Add team member</h2>
				{done ? (
					<>
						<p className="hint">
							{done.code ? `Send the name and code to ${done.member.name} privately. They open the portal link and enter the code — nothing else to set up.` : `${done.member.name} was added. Set a code from Settings so they can sign in.`}
						</p>
						{done.code && <div className="otc">{done.code}</div>}
						<div className="dlg-acts">
							<button type="button" className="btn primary" onClick={onClose}>
								Done
							</button>
						</div>
					</>
				) : (
					<>
						<p className="hint">They can then be assigned tasks, and their work shows up in Team.</p>
						<label>
							Full name
							<input value={f.name} onChange={set('name')} maxLength={50} autoFocus />
						</label>
						<div className="row">
							<label>
								Role
								<select value={f.role} onChange={set('role')} disabled={!isAdmin(me)}>
									<option value="member">Team Member</option>
									<option value="lead">Team Leader</option>
								</select>
							</label>
						</div>
						<label>
							Secret code <small>they sign in with this — at least 6 characters</small>
							<span className="ap-code">
								<input value={f.code} onChange={set('code')} maxLength={40} autoComplete="off" spellCheck={false} placeholder="e.g. irfan2026" />
								<button type="button" className="btn small" onClick={() => setF({ ...f, code: generateCode() })}>
									Generate
								</button>
							</span>
						</label>
						<p className="err" role="alert">
							{error}
						</p>
						<div className="dlg-acts">
							<button type="button" className="btn" onClick={onClose}>
								Cancel
							</button>
							<button type="submit" className="btn primary">
								Add member
							</button>
						</div>
					</>
				)}
			</form>
		</Modal>
	);
}

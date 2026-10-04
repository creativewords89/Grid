import { useState } from 'react';
import { usePortal } from '../../context.js';
import { addDays } from '../../lib/cycles.js';
import { monthEnd, mondayOf, short, toDate, weekNo } from '../../lib/format.js';
import { isManager } from '../../lib/roles.js';
import { assigneesOf } from '../../lib/tasks.js';
import { rowsOf } from '../../lib/store.js';
import { CalendarPicker } from '../DatePicker.jsx';
import Modal from '../Modal.jsx';
import PeoplePicker, { evenSplit } from '../PeoplePicker.jsx';

const TYPES = [
	['none', 'No deadline'],
	['weekly', 'Weekly'],
	['biweekly', 'Bi-weekly'],
	['monthly', 'Monthly'],
	['date', 'Specific date'],
	['dates', 'Range'],
];

function DeadlineField({ value, onChange, today }) {
	const type = value.type || 'none';
	const thisWeek = mondayOf(today);
	const weeks = value.weeks || [];
	const list = Array.from({ length: 12 }, (_, k) => addDays(thisWeek, 7 * k));
	weeks.forEach((w) => !list.includes(w) && list.push(w));
	list.sort();
	const month = value.month || today.slice(0, 7);

	const setType = (t) => {
		if (t === 'weekly') return onChange({ type: t, weeks: weeks.length ? weeks : [thisWeek] });
		if (t === 'biweekly') return onChange({ type: t, from: value.type === 'biweekly' && value.from ? value.from : thisWeek });
		if (t === 'monthly') return onChange({ type: t, month: value.month || today.slice(0, 7) });
		onChange({ ...value, type: t });
	};

	return (
		<div className="dl-wrap">
			<span className="pk-label">Deadline</span>
			<div className="dl-opts" role="radiogroup" aria-label="Deadline type">
				{TYPES.map(([t, label]) => (
					<label key={t}>
						<input type="radio" name="grp-dltype" value={t} checked={type === t} onChange={() => setType(t)} />
						<span>{label}</span>
					</label>
				))}
			</div>
			{type === 'weekly' && (
				<div className="dl-f">
					<span className="dl-note">Pick one or more weeks (Mon – Sun)</span>
					<div className="dl-weeks">
						{list.map((w) => {
							const on = weeks.includes(w);
							const end = addDays(w, 6);
							return (
								<button
									type="button"
									key={w}
									className={`dl-wk ${on ? 'on' : ''} ${end < today ? 'past' : ''}`}
									aria-pressed={on}
									onClick={() => onChange({ type: 'weekly', weeks: on ? weeks.filter((x) => x !== w) : [...weeks, w].sort() })}
								>
									<b>
										Week {weekNo(w)}
										{w === thisWeek ? ' · this week' : ''}
									</b>
									<span>
										{short(w)} – {short(end)}
									</span>
								</button>
							);
						})}
					</div>
				</div>
			)}
			{type === 'biweekly' && (
				<div className="dl-f">
					<span className="dl-note">Two weeks from the Monday you pick — due on the Sunday of the second week</span>
					<div className="dl-weeks">
						{list
							.filter((w) => w >= thisWeek || w === value.from)
							.map((w) => {
								const on = value.from === w;
								const end = addDays(w, 13);
								return (
									<button type="button" key={w} className={`dl-wk ${on ? 'on' : ''} ${end < today ? 'past' : ''}`} aria-pressed={on} onClick={() => onChange({ type: 'biweekly', from: w })}>
										<b>
											Weeks {weekNo(w)}–{weekNo(addDays(w, 7))}
											{w === thisWeek ? ' · from this week' : ''}
										</b>
										<span>
											{short(w)} – {short(end)}
										</span>
									</button>
								);
							})}
					</div>
				</div>
			)}
			{type === 'date' && (
				<div className="dl-f">
					<CalendarPicker value={{ date: value.date || '' }} onChange={(v) => onChange({ type: 'date', date: v.date })} today={today} />
				</div>
			)}
			{type === 'dates' && (
				<div className="dl-f">
					<CalendarPicker range value={{ from: value.from || '', to: value.to || '' }} onChange={(v) => onChange({ type: 'dates', from: v.from, to: v.to })} today={today} />
				</div>
			)}
			{type === 'monthly' && (
				<div className="dl-f">
					<span className="dl-month">
						Due <b>{toDate(monthEnd(month)).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</b> — the last day of{' '}
						{toDate(monthEnd(month)).toLocaleDateString(undefined, { month: 'long' })}
					</span>
				</div>
			)}
		</div>
	);
}

// Add / edit a meeting task (SPEC.md 7.2 "Task dialog"). Members can add but not edit.
export default function TaskDialog({ taskId, onClose }) {
	const { api, data, dispatch, toast, me, project, today, askCompletion } = usePortal();
	const editing = taskId ? data.meeting_tasks[taskId] : null;
	const members = rowsOf(data, 'members');
	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));

	const [f, setF] = useState(() => ({
		project_id: editing ? editing.project_id : project || '',
		title: editing ? editing.title : '',
		notes: editing ? editing.notes || '' : '',
		url: editing ? editing.url || '' : '',
		priority: editing ? editing.priority : 'normal',
		status: editing ? editing.status : 'todo',
		target: editing ? editing.target : 1,
		meeting_date: editing ? editing.meeting_date || '' : today,
		deadline: editing && editing.deadline ? editing.deadline : { type: 'none' },
		assignees: editing ? assigneesOf(editing, data.members) : [],
	}));
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });

	const setQty = (e) => {
		const q = Math.max(1, Math.min(999, parseInt(e.target.value, 10) || 1));
		const ids = f.assignees.map((a) => a.id);
		setF({ ...f, target: q, assignees: ids.length ? (q > 1 ? evenSplit(ids, q) : ids.map((id) => ({ id, n: 1 }))) : [] });
	};

	const deadlinePayload = () => {
		const D = f.deadline;
		if (D.type === 'weekly' && !(D.weeks || []).length) return { type: 'none' };
		if (D.type === 'biweekly') return D.from ? { type: 'biweekly', from: D.from } : { type: 'none' };
		if (D.type === 'date' && !D.date) return { type: 'none' };
		if (D.type === 'dates' && !D.from) return { type: 'none' };
		if (D.type === 'dates') return { type: 'dates', from: D.from, to: D.to || D.from };
		return D;
	};

	const submit = async (e) => {
		e.preventDefault();
		if (!f.title.trim()) return setError('Say what needs to change.');
		if (!f.project_id) return setError('Pick a project.');
		if (f.url && !/^https?:\/\//i.test(f.url)) return setError('The page URL should start with https://');
		const body = {
			project_id: f.project_id,
			title: f.title.trim(),
			notes: f.notes,
			url: f.url.trim(),
			priority: f.priority,
			status: f.status,
			target: f.target,
			meeting_date: f.meeting_date || '',
			deadline: deadlinePayload(),
			assignees: f.assignees,
		};
		if (f.status === 'done' && (!editing || editing.status !== 'done') && !isManager(me)) {
			const note = await askCompletion(body.title);
			if (!note) return;
			Object.assign(body, note);
		}
		setBusy(true);
		try {
			const row = editing ? await api.patch(`meeting-tasks/${editing.id}`, body) : await api.post('meeting-tasks', body);
			dispatch({ type: 'upsert', table: 'meeting_tasks', row });
			toast(editing ? 'Changes saved' : 'Task added');
			onClose();
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpTaskTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpTaskTitle">{editing ? 'Edit task' : 'Add task'}</h2>
				<label>
					Client
					<select value={f.project_id} onChange={set('project_id')} required>
						<option value="" disabled>
							Pick a project
						</option>
						{projects.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<label>
					What needs to change
					<input value={f.title} onChange={set('title')} required maxLength={200} placeholder="e.g. Fix H1 on the Riverview service page" autoFocus />
				</label>
				<label>
					Details
					<textarea value={f.notes} onChange={set('notes')} maxLength={4000} placeholder="Context from the meeting, exact wording, links…" />
				</label>
				<label>
					Page URL
					<input type="url" value={f.url} onChange={set('url')} placeholder="https://client.com/page" />
				</label>
				<div className="row">
					<label>
						Priority
						<select value={f.priority} onChange={set('priority')}>
							<option value="urgent">Urgent</option>
							<option value="high">High</option>
							<option value="normal">Normal</option>
							<option value="low">Low</option>
						</select>
					</label>
					<label>
						Status
						<select value={f.status} onChange={set('status')} disabled={!!editing && editing.status === 'done'}>
							<option value="todo">Not started</option>
							<option value="doing">In progress</option>
							<option value="done">Completed</option>
						</select>
					</label>
					<label>
						Quantity
						<input type="number" min={1} max={999} value={f.target} onChange={setQty} inputMode="numeric" />
					</label>
				</div>
				<div className="row">
					<label>
						From meeting on
						<input type="date" value={f.meeting_date} onChange={set('meeting_date')} />
					</label>
				</div>
				<DeadlineField value={f.deadline} onChange={set('deadline')} today={today} />
				<div className="pk-wrap">
					<span className="pk-label">
						Responsible <small>tick one or more</small>
					</span>
					<PeoplePicker members={members} value={f.assignees} onChange={set('assignees')} counts={f.target > 1} target={f.target} />
				</div>
				{editing && editing.status === 'done' && <p className="hint">It's completed — use Revise or Reject in Details to reopen it.</p>}
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy}>
						{editing ? 'Save changes' : 'Save task'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

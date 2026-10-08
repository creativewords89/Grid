import { useState } from 'react';
import { usePortal } from '../../context.js';
import { rowsOf } from '../../lib/store.js';
import { typePeople } from '../../lib/monthly.js';
import Avatar from '../Avatar.jsx';
import { CycleDayPicker } from '../DatePicker.jsx';
import Modal from '../Modal.jsx';
import PeoplePicker, { evenSplit } from '../PeoplePicker.jsx';
import StepsEditor, { WhoToggle, presetRows } from '../StepsEditor.jsx';
import AttachField from '../AttachField.jsx';
import { cleanSteps, hasSteps, stepsError } from '../../lib/steps.js';

const MODES = [
	['none', 'No deadline'],
	['weekly', 'Weekly'],
	['biweekly', 'Bi-weekly'],
	['monthly', 'Monthly'],
	['date', 'Specific date'],
	['dates', 'Range'],
];

let seq = 0;
const newPartId = () => 'p' + Date.now().toString(36) + (seq++).toString(36);

// One breakdown row: type, quantity, and who does it (whole team, one person, or shares).
function PartRow({ part, members, open, onToggle, onChange, onRemove }) {
	const people = [...members].filter((m) => +m.active !== 0).sort((a, b) => a.name.localeCompare(b.name));
	const byId = Object.fromEntries(members.map((m) => [m.id, m]));
	const tp = typePeople(part, byId);
	const sum = tp.reduce((a, b) => a + b.n, 0);
	const [q, setQ] = useState('');
	const label = !tp.length ? 'Choose people…' : tp.length === 1 ? byId[tp[0].id].name : tp.map((a) => `${byId[a.id].name.split(' ')[0]} ${a.n}`).join(' · ');

	const setN = (v) => {
		const n = Math.max(1, Math.min(999, parseInt(v, 10) || 1));
		onChange({ ...part, n, people: tp.length ? evenSplit(tp.map((p) => p.id), n) : [] });
	};
	const toggle = (id, on) => {
		const ids = tp.map((p) => p.id).filter((x) => x !== id);
		if (on) ids.push(id);
		onChange({ ...part, people: ids.length ? evenSplit(ids, part.n) : [] });
	};
	const share = (id, v) => {
		const mine = Math.max(0, Math.min(part.n, parseInt(v, 10) || 0));
		const others = tp.filter((p) => p.id !== id);
		const rest = part.n - mine;
		const per = others.length ? Math.floor(rest / others.length) : 0;
		const ex = others.length ? rest % others.length : 0;
		let k = 0;
		onChange({ ...part, people: tp.map((p) => (p.id === id ? { id, n: mine } : { id: p.id, n: per + (k++ < ex ? 1 : 0) })) });
	};

	return (
		<>
			<div className="bd-row">
				<input value={part.name} onChange={(e) => onChange({ ...part, name: e.target.value })} maxLength={60} aria-label="Type" />
				<input type="number" min={1} max={999} value={part.n} onChange={(e) => setN(e.target.value)} aria-label="How many" />
				<button type="button" className={`bd-whobtn ${tp.length ? 'set' : ''} ${open ? 'open' : ''}`} aria-expanded={open} onClick={onToggle}>
					<span className="bd-avs">
						{tp.slice(0, 3).map((a) => (
							<Avatar key={a.id} person={byId[a.id]} small />
						))}
					</span>
					<span className="bd-wl">{label}</span>
					<span className="bd-car" aria-hidden="true">
						{tp.length > 1 ? '✎' : '+ people'}
					</span>
				</button>
				<button type="button" className="nt-x" aria-label={`Remove ${part.name}`} onClick={onRemove}>
					✕
				</button>
			</div>
			{open && (
				<div className="bd-panel">
					<div className="bd-pnote">
						<b>{part.name || 'This type'}</b> · {part.n} to do — tick one or more people
						{tp.length > 1 && (
							<>
								{' · '}
								<span className={sum === part.n ? 'ok' : 'warn'}>
									shares {sum} of {part.n}
									{sum === part.n ? ' ✓' : ''}
								</span>
							</>
						)}
					</div>
					<input type="search" className="bd-psearch" placeholder={`Search ${people.length} people…`} aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
					<ul className="bd-plist">
						{people
							.filter((p) => !q || p.name.toLowerCase().includes(q.trim().toLowerCase()))
							.map((p) => {
								const on = tp.find((a) => a.id === p.id);
								return (
									<li key={p.id}>
										<label className={on ? 'on' : ''}>
											<input type="checkbox" checked={!!on} onChange={(e) => toggle(p.id, e.target.checked)} />
											<Avatar person={p} small />
											<b>{p.name}</b>
										</label>
										{on && tp.length > 1 && (
											<span className="bd-pshare">
												<input type="number" min={0} max={part.n} value={on.n} onChange={(e) => share(p.id, e.target.value)} aria-label={`${p.name}'s share`} />
												<small>of {part.n}</small>
											</span>
										)}
									</li>
								);
							})}
					</ul>
					<div className="bd-pacts">
						<button type="button" className="linkbtn" onClick={() => onChange({ ...part, people: [] })}>
							Clear — whole-task team
						</button>
						<button type="button" className="btn small" onClick={onToggle}>
							Done
						</button>
					</div>
				</div>
			)}
		</>
	);
}

// Add / edit a recurring task (SPEC.md 7.3 dialog): deadline, quantity, breakdown, responsible.
export default function MonthlyDialog({ taskId, onClose }) {
	const { api, data, dispatch, toast, project } = usePortal();
	const editing = taskId ? data.monthly_tasks[taskId] : null;
	const members = rowsOf(data, 'members');
	const projects = rowsOf(data, 'projects').sort((a, b) => a.name.localeCompare(b.name));

	const [f, setF] = useState(() => ({
		project_id: editing ? editing.project_id : project || '',
		title: editing ? editing.title : '',
		notes: editing ? editing.notes || '' : '',
		due_mode: editing ? editing.due_mode : 'monthly',
		due_day: editing && editing.due_mode === 'date' ? editing.due_day || '' : '',
		from_day: editing && editing.due_mode === 'dates' ? editing.due_from_day || '' : '',
		to_day: editing && editing.due_mode === 'dates' ? editing.due_day || '' : '',
		target: editing ? editing.target : 1,
		parts: editing && Array.isArray(editing.parts) ? editing.parts.map((x) => ({ ...x, people: typePeople(x, data.members) })) : [],
		assignees: editing ? (editing.assignees || []).filter((a) => data.members[a.id]).map((a) => ({ id: a.id })) : [],
		files: editing && Array.isArray(editing.files) ? editing.files : [],
	}));
	const [open, setOpen] = useState(-1);
	const [add, setAdd] = useState({ name: '', n: 1, who: '' });
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	// Steps in order (SPEC.md 6.16) instead of a breakdown: off by default.
	const [stepsOn, setStepsOn] = useState(() => hasSteps(editing));
	const [steps, setSteps] = useState(() => (hasSteps(editing) ? editing.steps.map((x) => ({ ...x })) : []));
	const set = (k) => (e) => setF({ ...f, [k]: e && e.target ? e.target.value : e });
	const toggleSteps = (on) => {
		if (on && f.parts.length) return setError('Remove the breakdown first — a task has steps or a breakdown, not both.');
		setError('');
		setStepsOn(on);
		if (on && !steps.length) setSteps(presetRows(['Write', 'Edit']));
	};

	const total = f.parts.reduce((a, x) => a + (x.n || 0), 0);
	const fromParts = (() => {
		const m = new Map();
		f.parts.forEach((x) => (x.people || []).forEach((a) => a.n > 0 && m.set(a.id, (m.get(a.id) || 0) + a.n)));
		return [...m].map(([id, n]) => ({ id, n }));
	})();
	const unpicked = total - fromParts.reduce((a, b) => a + b.n, 0);
	const wk = f.due_mode === 'weekly';
	const bw = f.due_mode === 'biweekly';

	const addPart = () => {
		const name = add.name.trim();
		if (!name) return setError('Type a name first, e.g. Profile backlink.');
		const n = Math.max(1, Math.min(999, parseInt(add.n, 10) || 1));
		setF({ ...f, parts: [...f.parts, { id: newPartId(), name, n, people: add.who ? [{ id: add.who, n }] : [] }] });
		setAdd({ name: '', n: 1, who: add.who });
		setError('');
	};

	const submit = async (e) => {
		e.preventDefault();
		if (!f.title.trim()) return setError('Name the task.');
		if (!f.project_id) return setError('Pick a project.');
		if (f.due_mode === 'date' && !f.due_day) return setError('Pick the day of the cycle it is due.');
		if (f.due_mode === 'dates' && (!f.from_day || !f.to_day)) return setError('Pick the first and last day of the cycle it is due.');
		const parts = f.parts.filter((x) => x.name.trim()).map((x) => ({ id: x.id, name: x.name.trim(), n: x.n, people: (x.people || []).filter((a) => a.n > 0) }));
		if (stepsOn && stepsError(steps)) return setError(stepsError(steps));
		// Every monthly task has someone responsible (SPEC.md 6.11); the server checks again.
		if (!stepsOn && !f.assignees.length && !parts.some((x) => x.people.length)) return setError('A monthly task needs at least one person responsible.');
		const body = {
			project_id: f.project_id,
			title: f.title.trim(),
			notes: f.notes,
			due_mode: f.due_mode,
			due_day: f.due_mode === 'date' ? +f.due_day : f.due_mode === 'dates' ? +f.to_day : null,
			due_from_day: f.due_mode === 'dates' ? +f.from_day : null,
			target: parts.length ? parts.reduce((a, x) => a + x.n, 0) : Math.max(1, Math.min(99, parseInt(f.target, 10) || 1)),
			parts: stepsOn ? [] : parts,
			assignees: stepsOn ? [] : f.assignees,
			team: true,
			steps: stepsOn ? cleanSteps(steps) : [],
			files: f.files.map((x) => x.id),
		};
		setBusy(true);
		try {
			const row = editing ? await api.patch(`monthly-tasks/${editing.id}`, body) : await api.post('monthly-tasks', body);
			dispatch({ type: 'upsert', table: 'monthly_tasks', row });
			toast(editing ? 'Changes saved' : 'Monthly task added');
			onClose();
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};

	return (
		<Modal open onClose={onClose} labelledBy="grpMTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpMTitle">{editing ? 'Edit monthly task' : 'Add monthly task'}</h2>
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
					Task
					<input value={f.title} onChange={set('title')} required maxLength={200} placeholder="e.g. Google Business Profile posts" autoComplete="off" autoFocus />
				</label>
				<div className="dl-wrap">
					<span className="pk-label">
						Deadline <small>repeats every cycle — Monthly is the default</small>
					</span>
					<div className="dl-opts" role="radiogroup" aria-label="Deadline type">
						{MODES.map(([m, label]) => (
							<label key={m}>
								<input type="radio" name="grp-mdl" value={m} checked={f.due_mode === m} onChange={() => setF({ ...f, due_mode: m })} />
								<span>{label}</span>
							</label>
						))}
					</div>
					{f.due_mode === 'none' && (
						<div className="dl-f">
							<span className="dl-note">Done any time in the cycle — it's never marked late.</span>
						</div>
					)}
					{f.due_mode === 'weekly' && (
						<div className="dl-f">
							<span className="dl-note">Repeats every week of the project's cycle: due at the end of each week (cycle days 1–7, 8–14, 15–21, 22–end).</span>
						</div>
					)}
					{f.due_mode === 'biweekly' && (
						<div className="dl-f">
							<span className="dl-note">Repeats every two weeks of the project's cycle: due at the end of weeks 1–2 and weeks 3–4.</span>
						</div>
					)}
					{f.due_mode === 'date' && (
						<div className="dl-f">
							<CycleDayPicker day={+f.due_day || 0} onChange={(v) => setF({ ...f, due_day: v.day })} />
						</div>
					)}
					{f.due_mode === 'dates' && (
						<div className="dl-f">
							<CycleDayPicker range from={+f.from_day || 0} to={+f.to_day || 0} onChange={(v) => setF({ ...f, from_day: v.from || '', to_day: v.to || '' })} />
						</div>
					)}
					{f.due_mode === 'monthly' && (
						<div className="dl-f">
							<span className="dl-note">Due by the last day of each cycle.</span>
						</div>
					)}
				</div>
				<div className="row">
					<label>
						<span>{wk ? 'Quantity per week' : bw ? 'Quantity per 2 weeks' : 'Quantity per cycle'}</span>
						<input type="number" min={1} max={999} value={f.parts.length ? total : f.target} disabled={f.parts.length > 0} onChange={set('target')} required />
					</label>
				</div>
				{!stepsOn && (
				<div className="bd-wrap">
					<span className="pk-label">
						Breakdown <small>optional — what types, and how many of each</small>
					</span>
					<p className="bd-tip">
						Share one type between several people: click <b>Who does it</b> on that row, tick the people and set each person's quantity.
					</p>
					<div>
						{f.parts.length > 0 && (
							<div className="bd-head">
								<span>Type</span>
								<span>Qty</span>
								<span>Who does it</span>
								<span />
							</div>
						)}
						{f.parts.map((x, k) => (
							<PartRow
								key={x.id}
								part={x}
								members={members}
								open={open === k}
								onToggle={() => setOpen(open === k ? -1 : k)}
								onChange={(nx) => setF({ ...f, parts: f.parts.map((p, i) => (i === k ? nx : p)) })}
								onRemove={() => {
									setF({ ...f, parts: f.parts.filter((_, i) => i !== k) });
									setOpen(-1);
								}}
							/>
						))}
					</div>
					<div className="bd-add">
						<input
							autoComplete="off"
							maxLength={60}
							placeholder="Type, e.g. Profile backlink"
							aria-label="Type"
							value={add.name}
							onChange={(e) => setAdd({ ...add, name: e.target.value })}
							onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addPart())}
						/>
						<input type="number" min={1} max={999} aria-label="Quantity" value={add.n} onChange={(e) => setAdd({ ...add, n: e.target.value })} />
						<select aria-label="Who does it" value={add.who} onChange={(e) => setAdd({ ...add, who: e.target.value })}>
							<option value="">Whole-task team</option>
							{members
								.filter((m) => +m.active !== 0)
								.sort((a, b) => a.name.localeCompare(b.name))
								.map((m) => (
									<option key={m.id} value={m.id}>
										{m.name}
									</option>
								))}
						</select>
						<button type="button" className="btn small" onClick={addPart}>
							+ Add
						</button>
					</div>
					<span className="pk-total">{f.parts.length ? `Total ${total} — quantity is set from the breakdown` : ''}</span>
				</div>
				)}
				<div className="pk-wrap">
					<span className="pk-label stp-label">
						Who does it
						<WhoToggle on={stepsOn} onChange={toggleSteps} />
					</span>
					{stepsOn ? (
						<StepsEditor members={members} value={steps} onChange={setSteps} dueKind={f.due_mode === 'weekly' || f.due_mode === 'biweekly' ? 'none' : 'day'} />
					) : fromParts.length > 0 ? (
						<>
							<p className="hint bd-note">
								{unpicked > 0
									? `These people come from “Who does it” in the breakdown. ${unpicked} ${unpicked === 1 ? 'unit has' : 'units have'} no one yet — pick people for each type above.`
									: 'These people come from “Who does it” in the breakdown — change them there.'}
							</p>
							<PeoplePicker members={members} value={fromParts.map((a) => ({ id: a.id }))} onChange={() => {}} disabled />
						</>
					) : (
						<>
							<small className="muted">
								Responsible <span className="req" aria-hidden="true">*</span> — tick the team members responsible for this task, at least one
							</small>
							<PeoplePicker members={members} value={f.assignees} onChange={set('assignees')} />
						</>
					)}
				</div>
				<AttachField value={f.files} onChange={(files) => setF((x) => ({ ...x, files }))} />
				<label>
					Details
					<textarea value={f.notes} onChange={set('notes')} maxLength={2000} placeholder="How it's done, where the report goes, logins location…" />
				</label>
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

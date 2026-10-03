import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { cycleRange } from '../../lib/cycles.js';
import { dateTime, short } from '../../lib/format.js';
import { profileLocked } from '../../lib/people.js';
import { columnsOf, deadlineFor, doneOf, groupOf, isLate, keywordsOf, splitKeywords } from '../../lib/plan.js';
import { isManager } from '../../lib/roles.js';
import Modal from '../Modal.jsx';

const GROUPS = [
	['this', 'This cycle'],
	['next', 'Next cycle'],
	['later', 'Later'],
];

// Closes a popover on an outside click or Escape.
function useDismiss(open, close) {
	const ref = useRef(null);
	useEffect(() => {
		if (!open) return undefined;
		const fn = (e) => (e.type === 'keydown' ? e.key === 'Escape' && close() : ref.current && !ref.current.contains(e.target) && close());
		document.addEventListener('mousedown', fn);
		document.addEventListener('keydown', fn);
		return () => {
			document.removeEventListener('mousedown', fn);
			document.removeEventListener('keydown', fn);
		};
	}, [open, close]);
	return ref;
}

// The Deadline pill: This cycle · Next cycle · Pick a date · No deadline (managers).
function DeadlinePill({ kw, project, columns, can, onSet }) {
	const { today } = usePortal();
	const [open, setOpen] = useState(false);
	const [picking, setPicking] = useState(false);
	const ref = useDismiss(open, () => (setOpen(false), setPicking(false)));
	const late = isLate(kw, columns, today);
	const label = kw.deadline ? `${short(kw.deadline)}${late ? ' · late' : ''}` : 'No deadline';
	const cls = 'kp-dl' + (late ? ' late' : kw.deadline ? '' : ' none');
	if (!can) return <span className={cls}>{label}</span>;
	const cur = deadlineFor('this', project, today);
	const next = deadlineFor('next', project, today);
	const pick = (v) => (setOpen(false), setPicking(false), onSet(v));
	return (
		<span className="kp-dlwrap" ref={ref}>
			<button type="button" className={cls} aria-haspopup="menu" aria-expanded={open} aria-label={`Deadline for ${kw.keyword}: ${label}`} onClick={() => setOpen(!open)}>
				{label} <span aria-hidden="true">▾</span>
			</button>
			{open && (
				<span className="kp-menu" role="menu">
					<button type="button" role="menuitem" onClick={() => pick(cur)}>
						This cycle · {short(cur)}
					</button>
					<button type="button" role="menuitem" onClick={() => pick(next)}>
						Next cycle · {short(next)}
					</button>
					{picking ? (
						<input type="date" aria-label="Pick a date" defaultValue={kw.deadline || today} onChange={(e) => e.target.value && pick(e.target.value)} autoFocus />
					) : (
						<button type="button" role="menuitem" onClick={() => setPicking(true)}>
							Pick a date…
						</button>
					)}
					<button type="button" role="menuitem" onClick={() => pick('')}>
						No deadline
					</button>
				</span>
			)}
		</span>
	);
}

// The ⋯ menu of a keyword: Rename, Remove (managers).
function RowMenu({ kw, onRename, onRemove }) {
	const [open, setOpen] = useState(false);
	const ref = useDismiss(open, () => setOpen(false));
	return (
		<span className="kp-more" ref={ref}>
			<button type="button" className="ma-dots" aria-label={`More for ${kw.keyword}`} aria-expanded={open} onClick={() => setOpen(!open)}>
				⋯
			</button>
			{open && (
				<span className="kp-menu right" role="menu">
					<button type="button" role="menuitem" onClick={() => (setOpen(false), onRename())}>
						Rename
					</button>
					<button type="button" role="menuitem" className="danger" onClick={() => (setOpen(false), onRemove())}>
						Remove
					</button>
				</span>
			)}
		</span>
	);
}

// The note: saved when it loses focus (or Enter).
function Note({ kw, disabled, onSave }) {
	const [value, setValue] = useState(kw.note || '');
	useEffect(() => setValue(kw.note || ''), [kw.note]);
	const commit = () => value.trim() !== (kw.note || '') && onSave(value.trim());
	return (
		<input
			className="kp-note"
			type="text"
			aria-label={`Note for ${kw.keyword}`}
			placeholder={disabled ? '' : 'Add a note…'}
			value={value}
			maxLength={500}
			disabled={disabled}
			onChange={(e) => setValue(e.target.value)}
			onBlur={commit}
			onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
		/>
	);
}

// + Add keywords: one per line (paste a column from your sheet), with a deadline.
function AddDialog({ project, onClose }) {
	const { api, dispatch, toast, today } = usePortal();
	const [text, setText] = useState('');
	const [when, setWhen] = useState('this');
	const [error, setError] = useState('');
	const list = splitKeywords(text);
	const submit = async (e) => {
		e.preventDefault();
		if (!list.length) return setError('Type or paste at least one keyword.');
		try {
			const rows = await api.post(`projects/${project.id}/keywords`, { keywords: list, deadline: deadlineFor(when, project, today) });
			rows.forEach((row) => dispatch({ type: 'upsert', table: 'keywords', row }));
			toast(rows.length === 1 ? 'Keyword added' : `${rows.length} keywords added`);
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="kpAdd">
			<form onSubmit={submit} noValidate>
				<h2 id="kpAdd">Add keywords</h2>
				<label>
					Keywords — one per line (paste a column from your sheet)
					<textarea rows={6} value={text} onChange={(e) => (setText(e.target.value), setError(''))} autoFocus placeholder={'emergency plumber dhaka\nwater heater repair'} />
				</label>
				<label>
					Deadline
					<select value={when} onChange={(e) => setWhen(e.target.value)}>
						<option value="this">This cycle · {short(deadlineFor('this', project, today))}</option>
						<option value="next">Next cycle · {short(deadlineFor('next', project, today))}</option>
						<option value="later">No deadline</option>
					</select>
				</label>
				<p className="hint">{list.length ? `${list.length} keyword${list.length === 1 ? '' : 's'} · ones already on the list are skipped` : 'Repeats are skipped.'}</p>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Add {list.length > 1 ? list.length + ' keywords' : 'keyword'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// ⚙ Columns: rename, reorder, add or remove the checkbox columns of this project.
function ColumnsDialog({ project, onClose }) {
	const { api, dispatch, toast } = usePortal();
	const [cols, setCols] = useState(() => columnsOf(project).map((c) => ({ ...c })));
	const [error, setError] = useState('');
	const set = (i, name) => setCols(cols.map((c, k) => (k === i ? { ...c, name } : c)));
	const move = (i, d) => {
		const next = [...cols];
		[next[i], next[i + d]] = [next[i + d], next[i]];
		setCols(next);
	};
	const submit = async (e) => {
		e.preventDefault();
		if (cols.some((c) => !c.name.trim())) return setError('Give every column a name.');
		try {
			const row = await api.put(`projects/${project.id}/keyword-columns`, { columns: cols.map((c) => ({ id: c.id || '', name: c.name.trim() })) });
			dispatch({ type: 'upsert', table: 'projects', row });
			toast('Columns saved');
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="kpCols">
			<form onSubmit={submit} noValidate>
				<h2 id="kpCols">Checklist columns</h2>
				<p className="hint">For this project. Ticks stay with a column when you rename or move it.</p>
				<ol className="kp-cols">
					{cols.map((c, i) => (
						<li key={c.id || 'new' + i}>
							<input type="text" aria-label={`Column ${i + 1}`} value={c.name} maxLength={40} onChange={(e) => set(i, e.target.value)} />
							<button type="button" className="btn small" aria-label={`Move ${c.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
								↑
							</button>
							<button type="button" className="btn small" aria-label={`Move ${c.name} down`} disabled={i === cols.length - 1} onClick={() => move(i, 1)}>
								↓
							</button>
							<button type="button" className="linkbtn danger" disabled={cols.length === 1} onClick={() => setCols(cols.filter((_, k) => k !== i))}>
								Remove
							</button>
						</li>
					))}
				</ol>
				{cols.length < 8 && (
					<button type="button" className="linkbtn" onClick={() => setCols([...cols, { id: '', name: '' }])}>
						+ Add column
					</button>
				)}
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Save
					</button>
				</div>
			</form>
		</Modal>
	);
}

// Project → Plan (SPEC.md 6.12, design KP-C): the keyword checklist grouped by deadline.
// Everyone ticks and writes notes; Team Leaders and the Super Admin manage keywords, deadlines
// (drag a row to another group, or the Deadline menu) and the columns.
export default function KeywordPlan() {
	const { api, data, project, dispatch, toast, confirm, me, today } = usePortal();
	const p = data.projects[project];
	const [q, setQ] = useState('');
	const [dialog, setDialog] = useState('');
	const [dragId, setDragId] = useState('');
	const [over, setOver] = useState('');
	if (!p) return null;

	const can = isManager(me);
	const locked = profileLocked(data.members[me.id] || me, me);
	const columns = columnsOf(p);
	const all = keywordsOf(data, p.id);
	const query = q.trim().toLowerCase();
	const rows = all.filter((k) => !query || [k.keyword, k.note].join(' ').toLowerCase().includes(query));
	const cur = cycleRange(p, 0, today);
	const next = cycleRange(p, 1, today);
	const sub = { this: `${short(cur.start)} – ${short(cur.end)} · deadline ${short(cur.end)}`, next: `${short(next.start)} – ${short(next.end)} · deadline ${short(next.end)}`, later: 'no deadline yet' };
	const name = (id) => (data.members[id] ? data.members[id].name : 'someone');

	const patch = async (kw, body, done) => {
		try {
			const row = await api.patch(`keywords/${kw.id}`, body);
			dispatch({ type: 'upsert', table: 'keywords', row });
			if (done) toast(done);
		} catch (err) {
			toast(err.message);
		}
	};
	const drop = (group) => {
		const kw = data.keywords[dragId];
		setDragId('');
		setOver('');
		if (!kw || groupOf(kw, p, today) === group) return;
		const deadline = deadlineFor(group, p, today);
		patch(kw, { deadline }, `Moved to ${GROUPS.find((g) => g[0] === group)[1].toLowerCase()}`);
	};
	const rename = async (kw) => {
		const value = await confirm({ title: 'Rename keyword', message: kw.keyword, input: 'Keyword', value: kw.keyword, ok: 'Save' });
		if (typeof value === 'string' && value.trim() && value.trim() !== kw.keyword) patch(kw, { keyword: value.trim() }, 'Renamed');
	};
	const remove = async (kw) => {
		if (!(await confirm({ title: `Remove “${kw.keyword}”?`, message: 'Its ticks and note go too.', ok: 'Remove', danger: true }))) return;
		try {
			await api.del(`keywords/${kw.id}`);
			dispatch({ type: 'remove', table: 'keywords', id: kw.id });
			toast('Keyword removed');
		} catch (err) {
			toast(err.message);
		}
	};
	const style = { '--kp-cols': columns.length };
	const fully = all.filter((k) => doneOf(k, columns) === columns.length).length;

	return (
		<div className="kp">
			<section className="dcard kp-card">
				<div className="kp-bar">
					<h3>Keyword checklist</h3>
					<span className="muted">{can ? 'Drag a row between cycles, or pick a deadline' : 'Tick a box when that step is done'}</span>
					<span className="lv-sp" />
					<label className="ld-search ma-search kp-search">
						<span aria-hidden="true">⌕</span>
						<input type="search" placeholder="Search keywords" aria-label="Search keywords" value={q} onChange={(e) => setQ(e.target.value)} />
					</label>
					{can && (
						<>
							<button type="button" className="btn small" onClick={() => setDialog('cols')}>
								⚙ Columns
							</button>
							<button type="button" className="btn primary" onClick={() => setDialog('add')}>
								+ Add keywords
							</button>
						</>
					)}
				</div>
				{all.length === 0 ? (
					<p className="d-empty kp-pad">{can ? 'No keywords yet. Add them one per line, or paste a column from your sheet.' : 'No keywords yet. A Team Leader adds them here.'}</p>
				) : (
					<div className="kp-table" role="table" aria-label="Keyword checklist" style={style}>
						<div className="kp-row kp-th" role="row">
							<span />
							<span role="columnheader">Keyword</span>
							{columns.map((c) => (
								<span key={c.id} role="columnheader" className="kp-c">
									{c.name}
								</span>
							))}
							<span role="columnheader">Progress</span>
							<span role="columnheader">Deadline</span>
							<span role="columnheader">Note</span>
							<span />
						</div>
						{GROUPS.map(([g, label]) => {
							const list = rows.filter((k) => groupOf(k, p, today) === g);
							return (
								<div
									key={g}
									className={'kp-group' + (over === g ? ' over' : '')}
									role="rowgroup"
									aria-label={label}
									onDragOver={(e) => can && dragId && (e.preventDefault(), setOver(g))}
									onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget) && setOver('')}
									onDrop={(e) => (e.preventDefault(), drop(g))}
								>
									<div className={'kp-gh g-' + g}>
										<i aria-hidden="true" />
										<b>{label}</b>
										<span className="muted">{sub[g]}</span>
										<span className="muted kp-gn">
											{list.length} keyword{list.length === 1 ? '' : 's'}
										</span>
									</div>
									{list.map((k) => {
										const n = doneOf(k, columns);
										return (
											<div key={k.id} className={'kp-row' + (dragId === k.id ? ' dragging' : '')} role="row" draggable={can} onDragStart={(e) => (e.dataTransfer.setData('text/plain', k.id), setDragId(k.id))} onDragEnd={() => (setDragId(''), setOver(''))}>
												<span className="kp-handle" aria-hidden="true">
													{can ? '⋮⋮' : ''}
												</span>
												<b role="cell" className="kp-kw">
													{k.keyword}
												</b>
												{columns.map((c) => {
													const on = k.checks && k.checks[c.id];
													return (
														<span key={c.id} role="cell" className="kp-c">
															<button
																type="button"
																role="checkbox"
																aria-checked={!!on}
																aria-label={`${c.name} for ${k.keyword}`}
																title={on ? `Ticked by ${name(on.by)} · ${dateTime(on.at)}` : locked ? 'Finish your profile first' : `Tick ${c.name}`}
																className={'kp-box' + (on ? ' on' : '')}
																disabled={locked}
																onClick={() => patch(k, { check: { column: c.id, on: !on } })}
															>
																{on ? '✓' : ''}
															</button>
														</span>
													);
												})}
												<span role="cell" className={'kp-prog' + (n === columns.length ? ' full' : '')}>
													<span className="kp-bar-o">
														<span style={{ width: Math.round((100 * n) / columns.length) + '%' }} />
													</span>
													<b>
														{n}/{columns.length}
													</b>
												</span>
												<span role="cell">
													<DeadlinePill kw={k} project={p} columns={columns} can={can} onSet={(v) => patch(k, { deadline: v }, v ? `Deadline ${short(v)}` : 'No deadline')} />
												</span>
												<span role="cell">
													<Note kw={k} disabled={locked} onSave={(v) => patch(k, { note: v })} />
												</span>
												<span role="cell">{can && <RowMenu kw={k} onRename={() => rename(k)} onRemove={() => remove(k)} />}</span>
											</div>
										);
									})}
									{list.length === 0 && <div className="kp-emptyg">{can ? 'Drag a keyword here' : 'Nothing here'}</div>}
								</div>
							);
						})}
						<div className="kp-row kp-foot" role="row">
							<span />
							<b role="cell">
								{all.length} keyword{all.length === 1 ? '' : 's'}
							</b>
							{columns.map((c) => (
								<span key={c.id} role="cell" className="kp-c">
									<b>{all.filter((k) => k.checks && k.checks[c.id]).length}</b>/{all.length}
								</span>
							))}
							<span role="cell">
								<b>{fully}</b> fully done
							</span>
							<span />
							<span />
							<span />
						</div>
					</div>
				)}
				<p className="kp-hint">Deadline = the end of the cycle a keyword sits in, or a date you pick. Past the deadline and not all ticked → late. Hover a tick to see who ticked it and when.</p>
			</section>
			{dialog === 'add' && <AddDialog project={p} onClose={() => setDialog('')} />}
			{dialog === 'cols' && <ColumnsDialog project={p} onClose={() => setDialog('')} />}
		</div>
	);
}

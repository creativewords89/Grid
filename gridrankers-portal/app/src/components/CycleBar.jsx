import { useState } from 'react';
import { usePortal } from '../context.js';
import { addDays, cycleRange, offLabel, periodsOf } from '../lib/cycles.js';
import { dateTime, longDate, short } from '../lib/format.js';
import { isAdmin } from '../lib/roles.js';
import Modal from './Modal.jsx';

const POLICIES = [
	{
		mode: 'due',
		title: 'Finish them in a short transition period',
		text: 'The days until the new cycle starts become a transition period. Unfinished work from before stays open and must be finished by the end of it. Monthly tasks are due in the transition too.',
	},
	{
		mode: 'waived',
		title: "Ignore last cycle's unfinished tasks",
		text: 'A transition period still runs for weekly tasks; monthly tasks are waived in it.',
	},
	{
		mode: 'merge',
		title: 'Fresh start',
		text: "The days before the new start day are added to the first new cycle, so there's no rushed short period.",
	},
];

function CycleChangeDialog({ project, open, onClose }) {
	const { api, dispatch, toast, today } = usePortal();
	const current = cycleRange(project, 0, today);
	const [day, setDay] = useState('');
	const [eff, setEff] = useState('end');
	const [mode, setMode] = useState('due');
	const [reason, setReason] = useState('');
	const [error, setError] = useState('');
	const from = eff === 'today' ? today : addDays(current.end, 1);

	const submit = async (e) => {
		e.preventDefault();
		if (!day) return setError('Pick the new start day.');
		if (!reason.trim()) return setError('Add a reason for the change.');
		try {
			const row = await api.post(`projects/${project.id}/cycle`, { day: +day, mode, from, reason: reason.trim() });
			dispatch({ type: 'upsert', table: 'projects', row });
			toast(`${project.name}: cycle changed`);
			onClose();
		} catch (err) {
			setError(err.message);
		}
	};

	return (
		<Modal open={open} onClose={onClose} labelledBy="grpCycTitle">
			<form onSubmit={submit} noValidate>
				<h2 id="grpCycTitle">Change project cycle</h2>
				<p className="hint">
					{project.name} starts on day {project.cycle_day}. Past cycles keep their dates.
				</p>
				<div className="row">
					<label>
						New cycle start day
						<select value={day} onChange={(e) => setDay(e.target.value)} required>
							<option value="">Pick</option>
							{Array.from({ length: 28 }, (_, i) => i + 1)
								.filter((d) => d !== +project.cycle_day)
								.map((d) => (
									<option key={d} value={d}>
										{d}
									</option>
								))}
						</select>
					</label>
					<label>
						Effective from
						<select value={eff} onChange={(e) => setEff(e.target.value)}>
							<option value="end">When the current cycle ends ({short(addDays(current.end, 1))})</option>
							<option value="today">Today (end current cycle early)</option>
						</select>
					</label>
				</div>
				<fieldset className="policy">
					<legend>What should happen to the previous cycle's tasks?</legend>
					{POLICIES.map((p) => (
						<label className="pol" key={p.mode}>
							<input type="radio" name="grp-pol" value={p.mode} checked={mode === p.mode} onChange={() => setMode(p.mode)} />
							<span>
								<b>{p.title}</b>
								<small>{p.text}</small>
							</span>
						</label>
					))}
				</fieldset>
				<label>
					Reason for the change
					<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. Client renewed the contract on the 15th" required />
				</label>
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary">
						Change cycle
					</button>
				</div>
			</form>
		</Modal>
	);
}

function CycleHistoryDialog({ project, open, onClose }) {
	const { data } = usePortal();
	const log = (project.cycle_log || []).filter((l) => l.by === 'admin').slice().reverse();
	return (
		<Modal open={open} onClose={onClose} labelledBy="grpHistTitle">
			<form method="dialog" onSubmit={(e) => (e.preventDefault(), onClose())}>
				<h2 id="grpHistTitle">Cycle history · {project.name}</h2>
				<ul className="dt-hist">
					{log.map((l, i) => (
						<li key={i}>
							<time>{dateTime(l.at)}</time>
							<span className="lg-tag lgk-cycle">Cycle change</span>
							<span>
								Day {l.from} → {l.to}
								{l.start ? ` from ${longDate(l.start)}` : ''}
								{l.by_member && data.members[l.by_member] ? ` · ${data.members[l.by_member].name}` : ''}
								{l.reason ? ` · ${l.reason}` : ''}
							</span>
						</li>
					))}
				</ul>
				<div className="dlg-acts">
					<button type="submit" className="btn primary">
						Close
					</button>
				</div>
			</form>
		</Modal>
	);
}

// "Project cycle 🔒 Starts day N · Change · History" and "‹ Current cycle ›" (SPEC.md 6.1).
export default function CycleBar({ project }) {
	const { api, dispatch, toast, me, cycleOff, setCycleOff, today } = usePortal();
	const [dlg, setDlg] = useState(null);
	const P = cycleRange(project, 0, today);
	const locked = !!project.cycle_set;
	const hasHistory = (project.cycle_log || []).some((l) => l.by === 'admin');
	const pending = (project.cycle_changes || []).find((ch) => ch.from > today);
	const pendingStart = pending ? periodsOf(project, today).find((x) => !x.transition && x.day === pending.day && x.start >= pending.from) : null;

	const lockFirst = async (day) => {
		try {
			const row = await api.post(`projects/${project.id}/cycle`, { day: +day });
			dispatch({ type: 'upsert', table: 'projects', row });
			toast(`${project.name}: cycle locked`);
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<div className="mhead">
			<div className="cyc-inline">
				<div className="cyc-chip">
					<span className="cc-name cc-lbl">Project cycle</span>
					{locked ? (
						<>
							<span className="cc-start locked" title="Locked. Only the Super Admin can change this.">
								<span className="lk" aria-hidden="true">
									🔒
								</span>
								Starts day <b>{P.day || (P.change && P.change.day) || project.cycle_day || 1}</b>
								{P.merged ? ' · extended' : ''}
								{P.cut ? ' · ended early' : ''}
							</span>
							{isAdmin(me) && (
								<button type="button" className="cc-change" onClick={() => setDlg('change')}>
									Change
								</button>
							)}
							{hasHistory && (
								<button type="button" className="cc-change" onClick={() => setDlg('history')}>
									History
								</button>
							)}
						</>
					) : (
						<label className="cc-start">
							Starts day{' '}
							<select defaultValue="" onChange={(e) => lockFirst(e.target.value)} aria-label={`Cycle start day for ${project.name}`}>
								<option value="" disabled>
									Pick
								</option>
								{Array.from({ length: 28 }, (_, i) => (
									<option key={i + 1} value={i + 1}>
										{i + 1}
									</option>
								))}
							</select>
						</label>
					)}
					{pending && cycleOff === 0 && (
						<span className="cc-pend" title={pending.reason || ''}>
							Day {pending.day} from {short(pendingStart ? pendingStart.start : pending.from)}
						</span>
					)}
				</div>
			</div>
			<div className="mnav">
				{cycleOff !== 0 && (
					<button className="btn small" onClick={() => setCycleOff(0)}>
						Back to current
					</button>
				)}
				<div className="navgrp">
					<button aria-label="Previous cycle" onClick={() => setCycleOff(cycleOff - 1)}>
						‹
					</button>
					<h2>{offLabel(cycleOff)}</h2>
					<button aria-label="Next cycle" onClick={() => setCycleOff(cycleOff + 1)}>
						›
					</button>
				</div>
			</div>
			{dlg === 'change' && <CycleChangeDialog project={project} open onClose={() => setDlg(null)} />}
			{dlg === 'history' && <CycleHistoryDialog project={project} open onClose={() => setDlg(null)} />}
		</div>
	);
}

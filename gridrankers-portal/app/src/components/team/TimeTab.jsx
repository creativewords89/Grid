import { useCallback, useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { settingOf } from '../../lib/people.js';
import { fmtMinutes } from '../../lib/reports.js';
import { addDays, canEditTime, canSetStart, entryLabel, flagLabels, fmtClock, localDate, localTime, toUtc } from '../../lib/timer.js';

// A person's time (SPEC.md 6.21, step 98): a week of time entries with their total, edit / delete
// (with Undo) by the rules of section 3, when their working day starts, and their signed-in
// desktop computers with Revoke.
export default function TimeTab({ person }) {
	const { api, data, me, today, toast, viewOnly } = usePortal();
	const [to, setTo] = useState(today);
	const [entries, setEntries] = useState(null);
	const [devices, setDevices] = useState(null);
	const [editing, setEditing] = useState(null);
	const from = addDays(to, -6);

	const load = useCallback(() => {
		api
			.get('time-entries', { member: person.id, from, to })
			.then(setEntries)
			.catch((err) => (setEntries([]), toast(err.message)));
	}, [api, person.id, from, to, toast]);
	useEffect(load, [load]);
	useEffect(() => {
		api
			.get('devices', { member: person.id })
			.then(setDevices)
			.catch(() => setDevices(null));
	}, [api, person.id]);

	const remove = async (e) => {
		try {
			await api.del(`time-entries/${e.id}`);
			load();
			toast('Time deleted', {
				action: {
					label: 'Undo',
					run: () =>
						api
							.post(`time-entries/${e.id}/restore`)
							.then(load)
							.catch((err) => toast(err.message)),
				},
			});
		} catch (err) {
			toast(err.message);
		}
	};
	const revoke = async (d) => {
		try {
			await api.del(`devices/${d.id}`);
			setDevices((list) => (list || []).filter((x) => x.id !== d.id));
			toast(`${d.name || 'That computer'} is signed out`);
		} catch (err) {
			toast(err.message);
		}
	};

	const days = {};
	(entries || []).forEach((e) => (days[e.day] = [...(days[e.day] || []), e]));
	const total = (entries || []).reduce((s, e) => s + (+e.seconds || 0), 0);
	const fmtDay = (ymd) => new Date(ymd + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });

	return (
		<div className="tt">
			<section className="dcard tt-week" aria-label="Time">
				<div className="tt-head">
					<h3>Time</h3>
					<div className="tt-nav">
						<button type="button" className="btn small ghost" aria-label="Earlier week" onClick={() => setTo(addDays(to, -7))}>
							‹
						</button>
						<span>
							{fmtDay(from)} – {fmtDay(to)}
						</span>
						<button type="button" className="btn small ghost" aria-label="Later week" disabled={to >= today} onClick={() => setTo(addDays(to, 7) > today ? today : addDays(to, 7))}>
							›
						</button>
					</div>
					<b className="tt-total" aria-label="Week total">
						{fmtMinutes(Math.round(total / 60))}
					</b>
				</div>
				{!entries ? (
					<p className="empty">Loading…</p>
				) : !entries.length ? (
					<p className="empty">No time tracked these days.</p>
				) : (
					Object.keys(days)
						.sort()
						.reverse()
						.map((day) => (
							<div key={day} className="tt-day">
								<div className="tt-dayh">
									<b>{fmtDay(day)}</b>
									<span>{fmtMinutes(Math.round(days[day].reduce((s, e) => s + (+e.seconds || 0), 0) / 60))}</span>
								</div>
								<ul className="tt-list">
									{days[day].map((e) => (
										<li key={e.id} className="tt-row">
											{editing === e.id ? (
												<EditRow entry={e} onDone={() => (setEditing(null), load())} onCancel={() => setEditing(null)} />
											) : (
												<>
													<span className="tt-when">
														{localTime(e.started_at)} – {e.ended_at ? localTime(e.ended_at) : 'running'}
													</span>
													<span className="tt-what">
														<b>{entryLabel(e, data)}</b>
														{e.note && <small>{e.note}</small>}
														<span className="tt-tags">
															<span className="tt-src">{e.source === 'desktop' ? '🖥 Desktop' : '🌐 Portal'}</span>
															{flagLabels(e).map((f) => (
																<span key={f} className="tt-flag">
																	{f}
																</span>
															))}
														</span>
													</span>
													<b className="tt-dur">{e.ended_at ? fmtClock(e.seconds) : '…'}</b>
													{!viewOnly && e.ended_at && canEditTime(me, person, e, today) && (
														<span className="tt-acts">
															<button type="button" className="linkbtn" onClick={() => setEditing(e.id)}>
																Edit
															</button>
															<button type="button" className="linkbtn danger" onClick={() => remove(e)}>
																Delete
															</button>
														</span>
													)}
												</>
											)}
										</li>
									))}
								</ul>
							</div>
						))
				)}
			</section>
			<WorkStart person={person} />
			{devices && (
				<section className="dcard tt-dev" aria-label="Desktop tracker">
					<h3>Desktop tracker</h3>
					{!devices.length ? (
						<p className="empty">Not signed in on any computer.</p>
					) : (
						<ul className="tt-list">
							{devices.map((d) => (
								<li key={d.id} className="tt-row">
									<span className="tt-what">
										<b>{d.name || 'Computer'}</b>
										<small>
											{[d.platform === 'darwin' ? 'Mac' : d.platform === 'win32' ? 'Windows' : d.platform, d.app_version && `v${d.app_version}`, d.last_seen_at && `last seen ${localDate(d.last_seen_at)} ${localTime(d.last_seen_at)}`].filter(Boolean).join(' · ')}
										</small>
									</span>
									{!viewOnly && (
										<button type="button" className="btn small" onClick={() => revoke(d)}>
											Revoke
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</section>
			)}
		</div>
	);
}

// Changing an entry's start and end (same day, local time).
function EditRow({ entry, onDone, onCancel }) {
	const { api, toast } = usePortal();
	const day = localDate(entry.started_at);
	const [start, setStart] = useState(localTime(entry.started_at));
	const [end, setEnd] = useState(localTime(entry.ended_at));
	const [busy, setBusy] = useState(false);
	const save = async (ev) => {
		ev.preventDefault();
		setBusy(true);
		try {
			await api.patch(`time-entries/${entry.id}`, { started_at: toUtc(day, start), ended_at: toUtc(day, end) });
			onDone();
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="tt-edit" onSubmit={save}>
			<input type="time" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start" required />
			<span>–</span>
			<input type="time" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End" required />
			<button type="submit" className="btn small primary" disabled={busy}>
				Save
			</button>
			<button type="button" className="btn small ghost" onClick={onCancel}>
				Cancel
			</button>
		</form>
	);
}

// When the person's working day starts (their own, else the team's); its length is their working
// hours from Pay (6.19). Reminders of the desktop tracker run from it.
function WorkStart({ person }) {
	const { api, data, dispatch, me, toast, viewOnly } = usePortal();
	const team = (settingOf(data, 'work_start') || {}).start || '09:00';
	const [value, setValue] = useState(person.work_start || '');
	if (person.role === 'admin') return null;
	const may = !viewOnly && canSetStart(me, person);
	const save = async (next) => {
		try {
			const row = await api.patch(`members/${person.id}`, { work_start: next });
			dispatch({ type: 'upsert', table: 'members', row });
			setValue(next);
			toast(next ? `${person.name.split(' ')[0]}’s day starts at ${next}` : 'The team’s start applies');
		} catch (err) {
			toast(err.message);
		}
	};
	return (
		<section className="dcard tt-start" aria-label="Working day">
			<h3>Working day</h3>
			<p className="hint">
				Starts at <b>{person.work_start || team}</b>
				{person.work_start ? ' (their own)' : ' (the team’s)'}. Its length is their working hours from Pay. The desktop tracker reminds them from then, never on days off or leave.
			</p>
			{may && (
				<div className="tt-startf">
					<input type="time" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Day starts at" />
					<button type="button" className="btn small" onClick={() => save(value)} disabled={!value}>
						Save
					</button>
					{person.work_start && (
						<button type="button" className="btn small ghost" onClick={() => save('')}>
							Use the team’s
						</button>
					)}
				</div>
			)}
		</section>
	);
}

// Admin settings (SPEC.md 6.21): when the team's working day starts. Each person's length is their
// working hours from Pay; a person may have their own start (their Time tab).
export function TeamWorkStart() {
	const { api, data, toast } = usePortal();
	const current = (settingOf(data, 'work_start') || {}).start || '09:00';
	const [value, setValue] = useState(current);
	const save = async () => {
		try {
			const res = await api.put('settings/work-start', { start: value });
			toast(`The working day starts at ${res.start}`);
		} catch (err) {
			toast(err.message);
		}
	};
	return (
		<section className="dcard tt-start" aria-label="Working day">
			<h3>Working day</h3>
			<p className="hint">When the team’s day starts. The desktop tracker reminds people to start their timer from then until their working hours are up — never on days off or leave.</p>
			<div className="tt-startf">
				<input type="time" value={value} onChange={(e) => setValue(e.target.value)} aria-label="Team day starts at" />
				<button type="button" className="btn small" onClick={save} disabled={!value || value === current}>
					Save
				</button>
			</div>
		</section>
	);
}

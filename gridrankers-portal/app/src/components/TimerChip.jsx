import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../context.js';
import { hostOf, trackerElsewhere } from '../lib/site.js';
import { elapsed, entryLabel, fmtClock, runningOf } from '../lib/timer.js';

// The timer in the top bar (SPEC.md 6.21): what is running and for how long, Stop, and a list to
// start or switch to a task. Team Leaders and Team Members only (the Super Admin tracks no time);
// hidden in a tour. Tracked time goes into the person's daily report on the server.
export default function TimerChip() {
	const { api, data, dispatch, me, toast, viewOnly, reports, config } = usePortal();
	const elsewhere = trackerElsewhere(config);
	const running = runningOf(data, me.id);
	const [now, setNow] = useState(Date.now());
	const [open, setOpen] = useState(false);
	const [tasks, setTasks] = useState(null);
	const [busy, setBusy] = useState(false);
	const box = useRef(null);

	useEffect(() => {
		if (!running) return undefined;
		const t = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(t);
	}, [running]);

	useEffect(() => {
		if (!open) return undefined;
		let gone = false;
		api
			.get('timer/tasks')
			.then((res) => !gone && setTasks(res))
			.catch((err) => !gone && (toast(err.message), setOpen(false)));
		const away = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
		const esc = (e) => e.key === 'Escape' && setOpen(false);
		document.addEventListener('mousedown', away);
		document.addEventListener('keydown', esc);
		return () => {
			gone = true;
			document.removeEventListener('mousedown', away);
			document.removeEventListener('keydown', esc);
		};
	}, [open, api, toast]);

	if (viewOnly || me.role === 'admin') return null;
	// A main portal linked to a tracker portal (SPEC.md 6.22): time is tracked there.
	if (elsewhere) {
		return (
			<a className="tchip tchip-away" href={elsewhere} target="_blank" rel="noopener noreferrer" title="Time is tracked on the tracker portal">
				⏱ Time is tracked on {hostOf(elsewhere)}
			</a>
		);
	}

	const keep = (res) => {
		['timer', 'stopped', 'entry'].forEach((k) => res && res[k] && dispatch({ type: 'upsert', table: 'time_entries', row: res[k] }));
		// Stopped time is now a tracked line in the daily report (server side): show it.
		if (res && (res.stopped || res.entry) && reports && reports.reload) reports.reload();
	};
	const start = async (body) => {
		setBusy(true);
		try {
			keep(await api.post('timer/start', body));
			setOpen(false);
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};
	const stop = async () => {
		setBusy(true);
		try {
			keep(await api.post('timer/stop'));
			toast('Timer stopped · added to today’s report');
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};

	const label = running ? entryLabel(running, data) : '';
	return (
		<div className={'tm' + (running ? ' on' : '')} ref={box}>
			{running ? (
				<>
					<span className="tm-dot" aria-hidden="true" />
					<button type="button" className="tm-what" onClick={() => setOpen(!open)} aria-expanded={open} title="Switch task">
						<b className="tm-clock" aria-label="Timer running">
							{fmtClock(elapsed(running, now))}
						</b>
						<span className="tm-label">{label}</span>
					</button>
					<button type="button" className="btn small tm-stop" onClick={stop} disabled={busy}>
						Stop
					</button>
				</>
			) : (
				<button type="button" className="btn small tm-start" onClick={() => setOpen(!open)} aria-expanded={open} disabled={busy}>
					▶ Start timer
				</button>
			)}
			{open && (
				<div className="tm-pop" role="dialog" aria-label={running ? 'Switch task' : 'Start timer'}>
					<p className="tm-h">{running ? 'Switch to' : 'Track time on'}</p>
					{!tasks ? (
						<p className="tm-empty">Loading…</p>
					) : (
						<ul className="tm-list">
							{tasks.tasks.map((t) => (
								<li key={t.kind + t.id}>
									<button type="button" disabled={busy} onClick={() => start({ ref_kind: t.kind, ref_id: t.id, period_key: t.period_key || undefined })}>
										<b>{t.title}</b>
										<span>{t.project_name || 'General task'}</span>
									</button>
								</li>
							))}
							<li>
								<button type="button" disabled={busy} onClick={() => start({ ref_kind: 'none' })}>
									<b>No task</b>
									<span>Office · anything else</span>
								</button>
							</li>
							{tasks.projects.map((p) => (
								<li key={'p' + p.id}>
									<button type="button" disabled={busy} onClick={() => start({ ref_kind: 'none', project_id: p.id })}>
										<b>{p.name}</b>
										<span>Project · no task</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

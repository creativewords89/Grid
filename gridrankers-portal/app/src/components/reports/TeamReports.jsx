import { useCallback, useEffect, useState } from 'react';
import { usePortal } from '../../context.js';
import { ROLE } from '../../lib/roles.js';
import { dayTitle, fmtMinutes, missLine, nextDay, teamTotals } from '../../lib/reports.js';
import Avatar from '../Avatar.jsx';
import { sentTime } from './DailyReports.jsx';
import { FileChip, LinkChip, ProjectTag } from './parts.jsx';

// Tasks shown per person before "+ N more tasks".
const SHOWN = 4;

// Team tab (SPEC.md 6.18, design TR-G1): everyone's tasks for a day in one table, to see at a glance
// what the team did. Totals on top, a filter by name, then one group of rows per person who sent
// a report; below them who hasn't sent (how many working days in a row, when they were reminded,
// Remind / Remind all), and who was on leave or off. The server decides who is listed: the Super
// Admin sees everyone, a Team Leader Team Members and the other Team Leaders.
export default function TeamReports({ onOpenPerson }) {
	const { api, data, me, toast, viewOnly, reports } = usePortal();
	const today = (reports.state && reports.state.today) || null;
	const [day, setDay] = useState(today);
	const [res, setRes] = useState(null);
	const [who, setWho] = useState('all');
	const [open, setOpen] = useState({});
	const [tellLeads, setTellLeads] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState('');

	const load = useCallback(() => {
		let live = true;
		api
			.get('daily-reports/team', day ? { day } : undefined)
			.then((r) => {
				if (!live) return;
				setRes(r);
				if (!day) setDay(r.day);
			})
			.catch((err) => live && setError(err.message));
		return () => {
			live = false;
		};
	}, [api, day]);
	useEffect(() => {
		setRes(null);
		setOpen({});
		return load();
	}, [load]);

	const remind = async (ids) => {
		setBusy(true);
		try {
			const r = await api.post('daily-reports/remind', ids.length === 1 && !tellLeads ? { member_id: ids[0], day: res.day } : { member_ids: ids, day: res.day, tell_leads: tellLeads });
			const n = r && r.reminded ? r.reminded.length : 1;
			toast(n === 0 ? 'Nobody left to remind' : n === 1 ? `Reminder sent to ${data.members[(r.reminded || ids)[0]].name}` : `Reminders sent to ${n} people`);
			load();
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};

	if (error) return <p className="err">{error}</p>;
	const shownDay = (res && res.day) || day;
	const isToday = !!res && shownDay === res.today;
	const everyone = res ? res.people.filter((p) => p.state !== 'none' && data.members[p.member_id]) : [];
	const totals = teamTotals(everyone);
	const people = everyone.filter((p) => who === 'all' || p.member_id === who);
	const sent = people.filter((p) => p.report);
	const missing = people.filter((p) => p.state === 'not_sent');
	const away = people.filter((p) => p.state === 'leave' || p.state === 'day_off');
	const canRemind = (p) => p.member_id !== me.id && !viewOnly;
	const toRemind = everyone.filter((p) => p.state === 'not_sent' && canRemind(p)).map((p) => p.member_id);

	return (
		<div className="dr-team tg">
			<div className="dr-dayrow">
				<button type="button" className="dr-nav" aria-label="Previous day" onClick={() => setDay(nextDay(shownDay, -1))} disabled={!shownDay}>
					‹
				</button>
				<b className="dr-day">{shownDay ? dayTitle(shownDay) : ''}</b>
				<button type="button" className="dr-nav" aria-label="Next day" onClick={() => setDay(nextDay(shownDay, 1))} disabled={!shownDay || !res || isToday}>
					›
				</button>
			</div>
			{!res ? (
				<p className="empty">Loading…</p>
			) : (
				<>
					<section className="tg-tiles" aria-label="Totals">
						<div>
							<b>
								{totals.sent} of {totals.owed}
							</b>
							<span>sent a report{totals.away ? ` · ${totals.away} away` : ''}</span>
						</div>
						<div>
							<b>{fmtMinutes(totals.minutes)}</b>
							<span>logged by the team</span>
						</div>
						<div>
							<b>{totals.tasks}</b>
							<span>tasks reported</span>
						</div>
						<div className={totals.missing ? 'bad' : ''}>
							<b>{totals.missing}</b>
							<span>not sent yet</span>
						</div>
					</section>

					<section className="tg-bar" aria-label="Filter">
						<span className="tg-lab">People</span>
						<div className="tg-people" role="group" aria-label="Filter by name">
							<button type="button" aria-pressed={who === 'all'} onClick={() => setWho('all')}>
								Everyone
							</button>
							{everyone.map((p) => (
								<button key={p.member_id} type="button" aria-label={data.members[p.member_id].name} aria-pressed={who === p.member_id} onClick={() => setWho(who === p.member_id ? 'all' : p.member_id)}>
									<Avatar person={data.members[p.member_id]} />
									{data.members[p.member_id].name.split(' ')[0]}
								</button>
							))}
						</div>
						<span className="tg-grow" />
						{toRemind.length > 0 && (
							<button type="button" className="tg-remind-all" onClick={() => remind(toRemind)} disabled={busy}>
								🔔 Remind everyone who hasn’t sent ({toRemind.length})
							</button>
						)}
					</section>

					<div className="tg-wrap">
						<table className="tg-table">
							<thead>
								<tr>
									<th scope="col">Person</th>
									<th scope="col">Task</th>
									<th scope="col">Project</th>
									<th scope="col">Time</th>
									<th scope="col">
										<span className="sr-only">Files and links</span>
									</th>
								</tr>
							</thead>
							{sent.map((p) => {
								const person = data.members[p.member_id];
								const r = p.report;
								const all = r.entries || [];
								const entries = open[p.member_id] ? all : all.slice(0, SHOWN);
								const more = all.length - entries.length;
								const extra = (r.blocking ? 1 : 0) + (more > 0 ? 1 : 0);
								return (
									<tbody key={p.member_id} className="tg-group" aria-label={`Report of ${person.name}`}>
										{entries.map((e, i) => (
											<tr key={e.id}>
												{i === 0 && (
													<th scope="rowgroup" rowSpan={entries.length + extra} className="tg-who">
														<div className="tg-person">
															<Avatar person={person} />
															<div>
																<button type="button" className="dr-who" onClick={() => onOpenPerson(p.member_id)} title="Open their reports">
																	<b>{person.name}</b>
																</button>
																<small>{ROLE[person.role]}</small>
															</div>
														</div>
														<div className="tg-hours">
															<b>{fmtMinutes(r.minutes)}</b>
															{p.day_minutes ? <span> of {fmtMinutes(p.day_minutes)}</span> : null}
														</div>
														<div className={'tg-sent' + (p.state === 'late' ? ' late' : '')}>{p.state === 'late' ? `Late · sent ${sentTime(r.sent_at)}` : `Sent ${sentTime(r.sent_at)}`}</div>
													</th>
												)}
												<td className="tg-task">
													<b>{e.title}</b>
													{e.details && <span>{e.details}</span>}
												</td>
												<td>
													<ProjectTag project={e.project} />
												</td>
												<td className="tg-time">{fmtMinutes(e.minutes)}</td>
												<td>
													<div className="tg-links">
														{(e.files || []).map((f) => (
															<FileChip key={f.id} file={f} />
														))}
														{(e.links || []).map((l, j) => (
															<LinkChip key={l.url + j} link={l} />
														))}
													</div>
												</td>
											</tr>
										))}
										{more > 0 && (
											<tr>
												<td colSpan={4}>
													<button type="button" className="linkbtn" onClick={() => setOpen({ ...open, [p.member_id]: true })}>
														+ {more} more {more === 1 ? 'task' : 'tasks'}
													</button>
												</td>
											</tr>
										)}
										{r.blocking && (
											<tr className="tg-block">
												<td colSpan={4}>
													<b>Blocking:</b> {r.blocking}
												</td>
											</tr>
										)}
									</tbody>
								);
							})}

							{missing.length > 0 && (
								<tbody className="tg-missing" aria-label="Not sent">
									<tr className="tg-miss-h">
										<td colSpan={5}>
											<div>
												<b>Not sent · {missing.length}</b>
												<span className="tg-names">{missing.map((p) => data.members[p.member_id].name).join(', ')}</span>
												<span className="tg-grow" />
												{toRemind.length > 0 && (
													<>
														<label>
															<input type="checkbox" checked={tellLeads} onChange={(e) => setTellLeads(e.target.checked)} /> Also tell the Team Leaders
														</label>
														<button type="button" className="tg-remind-all solid" onClick={() => remind(missing.filter(canRemind).map((p) => p.member_id))} disabled={busy}>
															Remind all {missing.filter(canRemind).length}
														</button>
													</>
												)}
											</div>
										</td>
									</tr>
									{missing.map((p) => {
										const person = data.members[p.member_id];
										return (
											<tr key={p.member_id} aria-label={person.name}>
												<th scope="row" className="tg-who">
													<div className="tg-person">
														<Avatar person={person} />
														<div>
															<button type="button" className="dr-who" onClick={() => onOpenPerson(p.member_id)} title="Open their reports">
																<b>{person.name}</b>
															</button>
															<small>{ROLE[person.role]}</small>
														</div>
													</div>
												</th>
												<td colSpan={4}>
													<div className="tg-miss">
														<b className={'tg-no' + (p.missed > 1 ? ' run' : '')}>No report</b>
														<span>{missLine(p, isToday, sentTime)}</span>
														<span className="tg-grow" />
														{canRemind(p) && (
															<button type="button" className="btn small" onClick={() => remind([p.member_id])} disabled={busy}>
																{p.reminded_at ? 'Remind again' : 'Remind'}
															</button>
														)}
													</div>
												</td>
											</tr>
										);
									})}
								</tbody>
							)}

							{away.length > 0 && (
								<tbody className="tg-away" aria-label="Away">
									{away.map((p) => {
										const person = data.members[p.member_id];
										return (
											<tr key={p.member_id}>
												<th scope="row" className="tg-who">
													<div className="tg-person">
														<Avatar person={person} />
														<div>
															<b>{person.name}</b>
															<small>{ROLE[person.role]}</small>
														</div>
													</div>
												</th>
												<td colSpan={4} className="muted">
													{p.state === 'leave' ? 'On leave' : 'Day off'} · no report needed
												</td>
											</tr>
										);
									})}
								</tbody>
							)}
						</table>
						{people.length === 0 && <p className="empty">Nobody here for this day.</p>}
					</div>
				</>
			)}
		</div>
	);
}


import { useState } from 'react';
import { usePortal } from '../../context.js';
import { addDays, daysBetween, parts, ymd } from '../../lib/cycles.js';
import { mondayOf, short, toDate } from '../../lib/format.js';
import { calEvents } from '../../lib/perf.js';

const ST = { open: 'To do', doing: 'In progress', urgent: 'Urgent', done: 'Done', missed: 'Missed', skipped: 'Skipped' };
const KD = { meeting: 'Meeting', weekly: 'Weekly', monthly: 'Monthly', logged: 'Logged', range: 'Date range' };
const tip = (e) => `${e.title} · ${e.client} · ${KD[e.kind]} · ${ST[e.status]}${e.detail ? ' · ' + e.detail : ''}`;

// Member calendar (SPEC.md 7.6): Month / Week / Day; monthly tasks as a bar across the cycle,
// weekly across the week, meeting deadlines per type, dated items as chips.
export default function Calendar({ pid }) {
	const { data, today, setProject, setView } = usePortal();
	const [C, setC] = useState({ mode: 'month', anchor: today });
	const [y, m] = parts(C.anchor);
	let from;
	let to;
	let label;
	if (C.mode === 'month') {
		from = mondayOf(ymd(y, m, 1));
		to = addDays(mondayOf(ymd(y, m + 1, 0)), 6);
		label = toDate(C.anchor).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
	} else if (C.mode === 'week') {
		from = mondayOf(C.anchor);
		to = addDays(from, 6);
		label = `${short(from)} – ${short(to)}, ${to.slice(0, 4)}`;
	} else {
		from = C.anchor;
		to = C.anchor;
		label = toDate(C.anchor).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
	}
	const { spans, dated } = calEvents(data, pid, from, to, today);
	const byDay = {};
	dated.forEach((e) => (byDay[e.date] = byDay[e.date] || []).push(e));
	const vFrom = C.mode === 'month' ? ymd(y, m, 1) : from;
	const vTo = C.mode === 'month' ? ymd(y, m + 1, 0) : to;
	const vis = [...spans.filter((e) => e.end >= vFrom && e.start <= vTo), ...dated.filter((e) => e.date >= vFrom && e.date <= vTo)];
	const cnt = (sts) => vis.filter((e) => sts.includes(e.status)).length;
	const open = (e) => {
		if (!e.tab || !e.project_id) return;
		setProject(e.project_id);
		setView(e.tab);
	};
	const nav = (dir) => {
		if (dir === 0) return setC({ ...C, anchor: today });
		const [ay, am, ad] = parts(C.anchor);
		setC({ ...C, anchor: C.mode === 'month' ? ymd(ay, am + dir, 1) : C.mode === 'week' ? addDays(C.anchor, 7 * dir) : ymd(ay, am, ad + dir) });
	};
	const chip = (e, i) => (
		<span key={i} className={'cal-chip cs-' + e.status} title={tip(e)}>
			<i />
			{e.title}
		</span>
	);

	// One week: day boxes, bars packed into lanes, then dated chips.
	const weekRow = (ws, compact, monthIdx) => {
		const we = addDays(ws, 6);
		const rowSpans = spans.filter((e) => e.end >= ws && e.start <= we);
		const colOf = (e) => [e.start < ws ? 0 : daysBetween(ws, e.start), e.end > we ? 6 : daysBetween(ws, e.end)];
		const ordered = [...rowSpans].sort((a, b) => (a.kind === 'monthly' ? 0 : 1) - (b.kind === 'monthly' ? 0 : 1) || a.title.localeCompare(b.title) || a.start.localeCompare(b.start));
		const lanes = [];
		const placed = ordered.map((e) => {
			const [c0, c1] = colOf(e);
			let li = lanes.findIndex((L) => L.every(([a, b]) => c1 < a || c0 > b));
			if (li < 0) {
				lanes.push([]);
				li = lanes.length - 1;
			}
			lanes[li].push([c0, c1]);
			return { e, c0, c1, lane: li };
		});
		const MAXB = compact ? 3 : 99;
		const shown = placed.filter((x) => x.lane < MAXB);
		const hidden = placed.length - shown.length;
		const laneN = Math.min(lanes.length, MAXB);
		const chipsRow = 2 + laneN + (hidden ? 1 : 0);
		const ds = Array.from({ length: 7 }, (_, k) => addDays(ws, k));
		return (
			<div className={'cw-row ' + (compact ? '' : 'tall')} key={ws}>
				{ds.map((d, k) => {
					const out = monthIdx !== undefined && parts(d)[1] !== monthIdx;
					const n = (byDay[d] || []).length + rowSpans.filter((e) => e.start <= d && e.end >= d).length;
					return [
						<button
							key={'b' + d}
							type="button"
							className={`cw-box ${out ? 'out' : ''} ${d === today ? 'today' : ''}`}
							style={{ gridColumn: k + 1, gridRow: `1 / span ${chipsRow}` }}
							aria-label={`${toDate(d).toDateString()}: ${n} tasks`}
							onClick={() => setC({ mode: 'day', anchor: d })}
						/>,
						<span key={'n' + d} className={`cw-dn ${d === today ? 'today' : ''} ${out ? 'out' : ''}`} style={{ gridColumn: k + 1, gridRow: 1 }}>
							{compact ? (
								parts(d)[2]
							) : (
								<>
									<b>{parts(d)[2]}</b> {toDate(d).toLocaleDateString(undefined, { weekday: 'short' })}
								</>
							)}
						</span>,
					];
				})}
				{shown.map(({ e, c0, c1, lane }, i) => (
					<button
						key={'s' + i}
						type="button"
						className={`cw-bar cs-${e.status} ${e.kind} ${e.meeting ? 'mt' : ''} ${e.start < ws ? 'cont-l' : ''} ${e.end > we ? 'cont-r' : ''}`}
						style={{ gridColumn: `${c0 + 1} / ${c1 + 2}`, gridRow: lane + 2 }}
						title={tip(e) + ' · click to open'}
						onClick={() => open(e)}
					>
						<i />
						<b>{e.title}</b>
						<em>{e.detail}</em>
					</button>
				))}
				{hidden > 0 && (
					<span className="cw-more" style={{ gridColumn: '1 / 8', gridRow: laneN + 2 }}>
						+{hidden} more running this week · open a day to see all
					</span>
				)}
				{ds.map((d, k) => {
					const list = byDay[d] || [];
					const lim = compact ? 2 : 99;
					return list.length ? (
						<span key={'c' + d} className="cw-chips" style={{ gridColumn: k + 1, gridRow: chipsRow }}>
							{list.slice(0, lim).map(chip)}
							{list.length > lim && <span className="cal-more">+{list.length - lim}</span>}
						</span>
					) : null;
				})}
			</div>
		);
	};

	let grid;
	if (C.mode === 'month') {
		const weeks = [];
		for (let w = from; w <= to; w = addDays(w, 7)) weeks.push(w);
		grid = (
			<div className="cal-m">
				<div className="cal-wds">
					{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => (
						<div className="cal-wd" key={x}>
							{x}
						</div>
					))}
				</div>
				{weeks.map((w) => weekRow(w, true, m))}
			</div>
		);
	} else if (C.mode === 'week') {
		grid = <div className="cal-m week">{weekRow(from, false)}</div>;
	} else {
		const list = [
			...spans.filter((e) => e.start <= C.anchor && e.end >= C.anchor).map((e) => ({ ...e, when: `${e.kind === 'weekly' ? (daysBetween(e.start, e.end) > 7 ? 'These two weeks' : 'This week') : e.kind === 'range' ? 'Between' : e.meeting ? 'This month' : 'This cycle'} (${short(e.start)} – ${short(e.end)})` })),
			...(byDay[C.anchor] || []).map((e) => ({ ...e, when: 'This day' })),
		];
		grid = (
			<section className="dcard cal-day">
				{list.length ? (
					<ul className="as-list">
						{list.map((e, i) => (
							<li key={i}>
								<span className={'as-tag at-' + (e.kind === 'meeting' || e.meeting ? 'board' : e.kind === 'logged' ? 'logged' : 'monthly')}>{e.meeting ? 'Meeting' : KD[e.kind]}</span>
								<div className="as-main">
									<b>{e.title}</b>
									<span>
										{e.client} · {e.when}
										{e.detail ? ' · ' + e.detail : ''}
									</span>
								</div>
								<span className={'cal-st cs-' + e.status}>{ST[e.status]}</span>
								{e.tab && e.project_id && (
									<button type="button" className="btn small" onClick={() => open(e)}>
										Open
									</button>
								)}
							</li>
						))}
					</ul>
				) : (
					<p className="d-empty">Nothing scheduled on this day.</p>
				)}
			</section>
		);
	}

	const mb = (k, l) => (
		<button type="button" className="sg" role="tab" aria-selected={C.mode === k} onClick={() => setC({ ...C, mode: k })}>
			{l}
		</button>
	);
	return (
		<>
			<div className="mhead cal-head">
				<div className="segs" role="tablist" aria-label="Calendar view">
					{mb('month', 'Month')}
					{mb('week', 'Week')}
					{mb('day', 'Day')}
				</div>
				<div className="mnav">
					{C.anchor !== today && (
						<button className="btn small" onClick={() => nav(0)}>
							Today
						</button>
					)}
					<div className="navgrp">
						<button aria-label="Previous" onClick={() => nav(-1)}>
							‹
						</button>
						<h2>{label}</h2>
						<button aria-label="Next" onClick={() => nav(1)}>
							›
						</button>
					</div>
				</div>
			</div>
			<div className="cal-sum">
				<span>
					<b>{vis.length}</b> {C.mode === 'day' ? 'on this day' : C.mode === 'week' ? 'this week' : 'this month'}
				</span>
				<span className="cs-open">
					<i />
					To do <b>{cnt(['open', 'doing'])}</b>
				</span>
				<span className="cs-urgent">
					<i />
					Urgent <b>{cnt(['urgent'])}</b>
				</span>
				<span className="cs-done">
					<i />
					Done <b>{cnt(['done'])}</b>
				</span>
				<span className="cs-missed">
					<i />
					Missed <b>{cnt(['missed'])}</b>
				</span>
				<span className="cal-key">
					<i className="k-bar" />
					Monthly / weekly = bar across its period <i className="k-chip" />
					Dated = on its day
				</span>
			</div>
			{grid}
		</>
	);
}

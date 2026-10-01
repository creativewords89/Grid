// Project cycle and calendar-week maths, ported from the reference portal (periodsOf,
// cycleRange, cycleAt, monthRange, dueAt, cycleFill; weeks follow the project cycle). Same as
// includes/class-cycles.php: every function takes "today" as 'YYYY-MM-DD' and returns
// 'YYYY-MM-DD' strings; period ends are inclusive. Tested against the same fixtures.

const WINDOW = 18;
const pad = (n) => String(n).padStart(2, '0');

// Like new Date(y, m, d) in the reference: months and days overflow.
export function ymd(y, m, d) {
	const t = new Date(Date.UTC(y, m, d));
	return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export const parts = (s) => {
	const [y, m, d] = s.slice(0, 10).split('-').map(Number);
	return [y, m - 1, d];
};
export const addDays = (s, n) => {
	const [y, m, d] = parts(s);
	return ymd(y, m, d + n);
};
export const daysBetween = (a, b) => Math.round((Date.UTC(...parts(b)) - Date.UTC(...parts(a))) / 86400000);
export const todayYmd = (date = new Date()) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const clampDay = (d) => Math.min(28, Math.max(1, parseInt(d, 10) || 1));
const endBefore = (s) => addDays(s, -1);

function changesOf(p) {
	let ch = p.cycle_changes ?? p.cycleChanges ?? [];
	if (typeof ch === 'string') {
		try {
			ch = JSON.parse(ch);
		} catch (e) {
			ch = [];
		}
	}
	return (Array.isArray(ch) ? ch : []).filter((c) => c && c.from);
}

const CACHE = new Map();

export function periodsOf(project, today) {
	const changes = [...changesOf(project)].sort((a, b) => String(a.from).localeCompare(String(b.from)));
	const sig = `${project.cycle_day ?? project.cycleDay}|${today}|${JSON.stringify(changes)}`;
	if (CACHE.has(sig)) return CACHE.get(sig);
	if (CACHE.size > 500) CACHE.clear();
	const list = buildPeriods(project, changes, today);
	CACHE.set(sig, list);
	return list;
}

function buildPeriods(project, changes, today) {
	const [ny, nm] = parts(today);
	let day = clampDay(changes.length ? changes[0].prevDay : project.cycle_day ?? project.cycleDay);
	let cur = ymd(ny, nm - WINDOW, day);
	const stop = ymd(ny, nm + WINDOW, 1);
	const out = [];
	const keys = new Set();
	let ci = 0;
	let guard = 0;
	const push = (p) => {
		const full = { day: null, cut: false, merged: false, transition: false, monthly: null, change: null, ...p };
		let key = full.transition ? 'T' + full.start : full.start.slice(0, 7);
		if (keys.has(key)) key += '-' + full.start.slice(8, 10);
		keys.add(key);
		out.push({ key, ...full });
	};

	while (cur < stop && guard++ < 300) {
		const [cy, cm] = parts(cur);
		const nextReg = ymd(cy, cm + 1, day);
		const ch = changes[ci];
		if (ch) {
			let f = String(ch.from);
			if (f < cur) f = cur;
			if (f <= nextReg) {
				if (f > cur) push({ start: cur, end: endBefore(f), day, cut: f < nextReg });
				const nd = clampDay(ch.day);
				const [fy, fm] = parts(f);
				let first = ymd(fy, fm, nd);
				if (first < f) first = ymd(fy, fm + 1, nd);
				if (first > f) {
					if (ch.mode === 'merge') {
						const [xy, xm] = parts(first);
						const nx = ymd(xy, xm + 1, nd);
						push({ start: f, end: endBefore(nx), day: nd, merged: true, change: ch });
						cur = nx;
					} else {
						push({ start: f, end: endBefore(first), transition: true, monthly: ch.mode === 'due' ? 'due' : 'waived', change: ch });
						cur = first;
					}
				} else cur = first;
				day = nd;
				ci++;
				continue;
			}
		}
		push({ start: cur, end: endBefore(nextReg), day });
		cur = nextReg;
	}
	return out;
}

const indexContaining = (list, date) => {
	const i = list.findIndex((p) => date >= p.start && date <= p.end);
	return i < 0 ? list.length - 1 : i;
};

export function cycleRange(project, off, today) {
	const list = periodsOf(project, today);
	const i = indexContaining(list, today);
	return list[Math.max(0, Math.min(list.length - 1, i + off))];
}

export function cycleAt(project, date, today) {
	const list = periodsOf(project, today);
	return list[indexContaining(list, date)];
}

export function monthRange(off, today) {
	const [y, m] = parts(today);
	const start = ymd(y, m + off, 1);
	return { key: start.slice(0, 7), start, end: ymd(y, m + off + 1, 0) };
}

// Weeks of a period counted from its start (SPEC.md 6.2): 7-day weeks, the last one taking
// the leftover days; max(1, floor(days / 7)) weeks. Not the reference's calendar-month weeks.
export function weeksIn(period) {
	const n = Math.max(1, Math.floor((daysBetween(period.start, period.end) + 1) / 7));
	const [y, m, d] = parts(period.start);
	return Array.from({ length: n }, (_, w) => ({ start: ymd(y, m, d + 7 * w), end: w < n - 1 ? ymd(y, m, d + 7 * w + 6) : period.end }));
}

export const weeksOf = (project, off, today) => weeksIn(cycleRange(project, off, today));

export function weekRange(project, w, off, today) {
	const weeks = weeksOf(project, off, today);
	return weeks[Math.max(0, Math.min(weeks.length - 1, w))];
}

// Week containing today in cycle `off`: first week of future cycles, last week of past ones.
export function activeWeek(project, off, today) {
	const weeks = weeksOf(project, off, today);
	for (let w = weeks.length - 1; w > 0; w--) if (today >= weeks[w].start) return w;
	return 0;
}

export const isWeekly = (task) => task.freq === 'weekly';
export const isBiweekly = (task) => task.freq === 'biweekly';
// Tracked per week or per two weeks rather than per cycle.
export const isSplit = (task) => isWeekly(task) || isBiweekly(task);

// Two-week periods of a period: pairs of its weeks, the last taking a leftover week
// (SPEC.md 6.2). Each knows which weeks it covers (1-based).
export function halvesIn(period) {
	const weeks = weeksIn(period);
	const n = Math.max(1, Math.floor(weeks.length / 2));
	return Array.from({ length: n }, (_, h) => {
		const last = h === n - 1 ? weeks.length - 1 : 2 * h + 1;
		return { start: weeks[2 * h].start, end: weeks[last].end, fromWeek: 2 * h + 1, toWeek: last + 1 };
	});
}

// Weeks (weekly), two-week periods (bi-weekly) or null (monthly: the whole period).
export const slotsIn = (task, period) => (isWeekly(task) ? weeksIn(period) : isBiweekly(task) ? halvesIn(period) : null);
export const slotsOf = (task, project, off, today) => slotsIn(task, cycleRange(project, off, today)) || [];

export function activeSlot(task, project, off, today) {
	const slots = slotsOf(task, project, off, today);
	for (let i = slots.length - 1; i > 0; i--) if (today >= slots[i].start) return i;
	return 0;
}

export function slotRange(task, project, i, off, today) {
	const slots = slotsOf(task, project, off, today);
	return slots[Math.max(0, Math.min(slots.length - 1, i))];
}

// "Week 2" / "Weeks 3–4" (short: "W2" / "W3–4").
export const slotLabel = (task, slot, i, short = false) =>
	isBiweekly(task) ? `${short ? 'W' : 'Weeks '}${slot.fromWeek}–${slot.toWeek}` : `${short ? 'W' : 'Week '}${i + 1}`;

export function dueAt(task, project, w, off, today) {
	if (isSplit(task)) return slotRange(task, project, w === undefined || w === null ? activeSlot(task, project, off, today) : w, off, today).end;
	const range = cycleRange(project, off, today);
	const dueDay = parseInt(task.due_day ?? task.dueDay, 10) || 0;
	if (!dueDay) return range.end;
	const [y, m, d] = parts(range.start);
	const x = ymd(y, m, d + dueDay - 1);
	return x > range.end ? range.end : x;
}

// Share of a normal one-month cycle that has passed (reference cycleFill).
export function cycleFill(P, today) {
	if (today > P.end) return 100;
	if (today < P.start) return 0;
	const nx = addDays(P.end, 1);
	const [y, m, d] = parts(nx);
	const ref = ymd(y, m - 1, d);
	const st = P.start < ref ? P.start : ref;
	const len = daysBetween(st, P.end);
	const day = daysBetween(st, today) + 1;
	return Math.max(0, Math.min(100, Math.round((day / len) * 100)));
}

export const offLabel = (o) => (o === 0 ? 'Current cycle' : o === -1 ? 'Previous cycle' : o === 1 ? 'Next cycle' : o < 0 ? `${-o} cycles ago` : `${o} cycles ahead`);

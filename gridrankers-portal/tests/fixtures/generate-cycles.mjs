// Generates tests/fixtures/cycles.json by running the cycle functions from the
// reference portal (site-changelog.html) at fixed "now" dates.
//
//   TZ=UTC node tests/fixtures/generate-cycles.mjs
//
// The reference functions are extracted verbatim; nothing here re-implements them.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.env.TZ !== 'UTC') {
	console.error('Run with TZ=UTC so local dates match the PHP port.');
	process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../../../site-changelog.html'), 'utf8');

function slice(startMarker, endMarker) {
	const a = html.indexOf(startMarker);
	const b = html.indexOf(endMarker, a);
	if (a < 0 || b < 0) throw new Error(`Marker not found: ${startMarker} … ${endMarker}`);
	return html.slice(a, b);
}

const source = [
	slice('const mondayOf = d =>', '\n'),
	slice('function cycleAt(c, d)', '\n'),
	slice('const ymd = d =>', 'const dueDate ='),
].join('\n');

function load(nowIso) {
	const NOW = new Date(nowIso).getTime();
	class FakeDate extends Date {
		constructor(...args) { super(...(args.length ? args : [NOW])); }
		static now() { return NOW; }
	}
	const state = { cycleOff: 0 };
	// eslint-disable-next-line no-new-func
	return new Function('Date', 'state', `${source}
		return { periodsOf, cycleRange, monthRange, weekRange, activeWeek, dueAt, cycleAt, ymd, parseYmd };`)(FakeDate, state);
}

const projects = {
	day1: { id: 'day1', cycleDay: 1 },
	day5: { id: 'day5', cycleDay: 5 },
	day15: { id: 'day15', cycleDay: 15 },
	day28: { id: 'day28', cycleDay: 28 },
	unset: { id: 'unset' },
	clampHigh: { id: 'clampHigh', cycleDay: 31 },
	merge: { id: 'merge', cycleDay: 20, cycleChanges: [
		{ from: '2026-03-10', day: 20, prevDay: 1, mode: 'merge' },
	] },
	due: { id: 'due', cycleDay: 20, cycleChanges: [
		{ from: '2026-03-10', day: 20, prevDay: 1, mode: 'due' },
	] },
	waived: { id: 'waived', cycleDay: 10, cycleChanges: [
		{ from: '2026-05-25', day: 10, prevDay: 15, mode: 'waived' },
	] },
	onBoundary: { id: 'onBoundary', cycleDay: 15, cycleChanges: [
		{ from: '2026-04-15', day: 15, prevDay: 5, mode: 'merge' },
	] },
	backward: { id: 'backward', cycleDay: 3, cycleChanges: [
		{ from: '2026-02-20', day: 3, prevDay: 25, mode: 'due' },
	] },
	twoChanges: { id: 'twoChanges', cycleDay: 12, cycleChanges: [
		{ from: '2026-08-01', day: 12, prevDay: 8, mode: 'waived' },
		{ from: '2025-11-03', day: 8, prevDay: 1, mode: 'merge' },
	] },
	futureChange: { id: 'futureChange', cycleDay: 22, cycleChanges: [
		{ from: '2027-01-05', day: 22, prevDay: 6, mode: 'due' },
	] },
	oldChange: { id: 'oldChange', cycleDay: 9, cycleChanges: [
		{ from: '2022-06-01', day: 9, prevDay: 2, mode: 'merge' },
	] },
};

const tasks = {
	monthly: { id: 't-m', freq: 'monthly' },
	day10: { id: 't-d10', freq: 'monthly', dueDay: 10 },
	day31: { id: 't-d31', freq: 'monthly', dueDay: 31 },
	weekly: { id: 't-w', freq: 'weekly' },
};

const nows = [
	'2026-10-01T12:00:00Z',
	'2026-03-09T12:00:00Z',
	'2026-03-10T00:30:00Z',
	'2026-03-31T23:30:00Z',
	'2026-02-28T12:00:00Z',
	'2028-02-29T12:00:00Z',
	'2026-12-31T12:00:00Z',
	'2027-01-01T12:00:00Z',
	'2026-05-24T12:00:00Z',
	'2026-06-07T12:00:00Z',
	'2026-06-22T12:00:00Z',
	'2026-08-15T12:00:00Z',
];

const dateOf = d => (d ? new Date(d).toISOString().slice(0, 10) : null);
// Compact: flags and change_from only when set.
const period = p => {
	const o = { key: p.key, start: dateOf(p.start), end: dateOf(p.end), day: p.day ?? null };
	for (const f of ['cut', 'merged', 'transition']) if (p[f]) o[f] = true;
	if (p.monthly) o.monthly = p.monthly;
	if (p.change) o.change_from = p.change.from;
	return o;
};
// Full period lists for a few "now" dates only; every case still checks ranges, due dates and cycleAt.
const fullPeriodsFor = new Set(['2026-10-01', '2026-03-10', '2028-02-29', '2027-01-01']);

const cases = [];
for (const now of nows) {
	const R = load(now);
	const today = now.slice(0, 10);
	const out = { now: today, months: {}, weeks: {}, activeWeek: {}, projects: {} };

	for (const off of [-2, -1, 0, 1, 2]) {
		const m = R.monthRange(off);
		out.months[off] = { key: m.key, start: dateOf(m.start), end: dateOf(m.end) };
		out.activeWeek[off] = R.activeWeek({}, off);
		out.weeks[off] = [0, 1, 2, 3].map(w => {
			const r = R.weekRange({}, w, off);
			return { start: dateOf(r.start), end: dateOf(r.end) };
		});
	}

	for (const [name, c] of Object.entries(projects)) {
		const pc = { periods: fullPeriodsFor.has(today) ? R.periodsOf(c).map(period) : null, ranges: {}, due: {}, at: {} };
		for (const off of [-3, -2, -1, 0, 1, 2, 3]) {
			pc.ranges[off] = period(R.cycleRange(c, off));
		}
		for (const [tn, t] of Object.entries(tasks)) {
			pc.due[tn] = {};
			for (const off of [-1, 0, 1]) {
				if (t.freq === 'weekly') {
					pc.due[tn][off] = {
						active: dateOf(R.dueAt(t, c, undefined, off)),
						weeks: [0, 1, 2, 3].map(w => dateOf(R.dueAt(t, c, w, off))),
					};
				} else {
					pc.due[tn][off] = dateOf(R.dueAt(t, c, undefined, off));
				}
			}
		}
		for (const d of ['2026-03-09', '2026-03-10', '2026-04-14', '2026-06-01', '2025-01-01', '2030-01-01', today]) {
			pc.at[d] = period(R.cycleAt(c, R.parseYmd(d)));
		}
		out.projects[name] = pc;
	}
	cases.push(out);
}

writeFileSync(
	join(here, 'cycles.json'),
	JSON.stringify({ generatedBy: 'tests/fixtures/generate-cycles.mjs', projects, tasks, cases }) + '\n'
);
console.log(`Wrote ${cases.length} cases.`);

import { useState } from 'react';
import { addDays, daysBetween } from '../lib/cycles.js';
import { mondayOf, short } from '../lib/format.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const pad = (n) => String(n).padStart(2, '0');
const monthStart = (ymd) => ymd.slice(0, 7) + '-01';
const shiftMonth = (first, k) => {
	const d = new Date(first + 'T00:00:00');
	d.setMonth(d.getMonth() + k);
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`;
};
const monthLabel = (first) => new Date(first + 'T00:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const longDate = (ymd) => new Date(ymd + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

// Once a date (or both ends of a range) is picked the calendar folds into one line with Change,
// so it doesn't stay open under the rest of the form; it opens again on Change.
function Chosen({ text, onChange }) {
	return (
		<div className="dp-chosen">
			<span className="dp-ic" aria-hidden="true">
				📅
			</span>
			<span className="dl-note">{text}</span>
			<button type="button" className="linkbtn" onClick={onChange}>
				Change
			</button>
		</div>
	);
}

// A month calendar (SPEC.md 6.3): one date (`range` false) or a range (`range` true: the first
// click sets the start, the second the end). Weeks run Monday – Sunday like the Weekly deadlines.
// `value` is {date} or {from, to}; `onChange` gets the same shape.
export function CalendarPicker({ range, value, onChange, today }) {
	const anchor = (range ? value.from : value.date) || today;
	const [month, setMonth] = useState(monthStart(anchor));
	const [hover, setHover] = useState('');
	const done = range ? !!(value.from && value.to) : !!value.date;
	const [open, setOpen] = useState(!done);
	// Range: waiting for the end date after the start was picked.
	const picking = range && value.from && !value.to;

	const first = mondayOf(month);
	const days = Array.from({ length: 42 }, (_, k) => addDays(first, k));
	const weeks = days[35].slice(0, 7) === month.slice(0, 7) ? 6 : 5;

	const pick = (d) => {
		if (!range) return setOpen(false), onChange({ date: d });
		if (!value.from || value.to) return onChange({ from: d, to: '' });
		setOpen(false);
		return d < value.from ? onChange({ from: d, to: value.from }) : onChange({ from: value.from, to: d });
	};
	const end = picking && hover ? hover : value.to;
	const lo = range && value.from && end ? (end < value.from ? end : value.from) : '';
	const hi = range && value.from && end ? (end < value.from ? value.from : end) : '';

	let summary;
	if (!range) summary = value.date ? `Due ${longDate(value.date)}` : 'Pick a date.';
	else if (!value.from) summary = 'Pick the first day.';
	else if (!value.to) summary = `From ${short(value.from)} — now pick the last day.`;
	else summary = `Due ${short(value.from)} – ${short(value.to)} (${daysBetween(value.from, value.to) + 1} day${value.from === value.to ? '' : 's'})`;

	if (done && !open) return <Chosen text={summary} onChange={() => (setMonth(monthStart(anchor)), setOpen(true))} />;

	return (
		<div className="dp" onMouseLeave={() => setHover('')}>
			<div className="dp-head">
				<button type="button" className="dp-nav" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
					‹
				</button>
				<b aria-live="polite">{monthLabel(month)}</b>
				<button type="button" className="dp-nav" aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
					›
				</button>
			</div>
			<div className="dp-grid" role="grid" aria-label={monthLabel(month)}>
				{WEEKDAYS.map((w) => (
					<span key={w} className="dp-wd" aria-hidden="true">
						{w.slice(0, 2)}
					</span>
				))}
				{days.slice(0, weeks * 7).map((d) => {
					const out = d.slice(0, 7) !== month.slice(0, 7);
					const on = range ? d === value.from || d === value.to : d === value.date;
					const inside = lo && d > lo && d < hi;
					const cls = ['dp-day', out && 'out', d === today && 'today', on && 'on', inside && 'in', lo && d === lo && 'lo', hi && d === hi && 'hi', d < today && 'past'].filter(Boolean).join(' ');
					return (
						<button key={d} type="button" className={cls} aria-label={longDate(d) + (d === today ? ' (today)' : '')} aria-current={d === today ? 'date' : undefined} title={d === today ? 'Today' : undefined} aria-pressed={!!on} onClick={() => pick(d)} onMouseEnter={() => picking && setHover(d)}>
							{+d.slice(8)}
						</button>
					);
				})}
			</div>
			<div className="dp-foot">
				<span className="dl-note">{summary}</span>
				<span className="dp-acts">
					<button type="button" className="linkbtn" onClick={() => (setMonth(monthStart(today)), pick(today))}>
						Today
					</button>
					{(range ? value.from : value.date) && (
						<button type="button" className="linkbtn" onClick={() => onChange(range ? { from: '', to: '' } : { date: '' })}>
							Clear
						</button>
					)}
				</span>
			</div>
		</div>
	);
}

// Days of the project's cycle (SPEC.md 6.4): one day N, or a range of days A–B, picked the same way.
export function CycleDayPicker({ range, from, to, day, onChange }) {
	const [hover, setHover] = useState(0);
	const done = range ? !!(from && to) : !!day;
	const [open, setOpen] = useState(!done);
	const picking = range && from && !to;
	const pick = (n) => {
		if (!range) return setOpen(false), onChange({ day: n });
		if (!from || to) return onChange({ from: n, to: 0 });
		setOpen(false);
		return n < from ? onChange({ from: n, to: from }) : onChange({ from, to: n });
	};
	const end = picking && hover ? hover : to;
	const lo = range && from && end ? Math.min(from, end) : 0;
	const hi = range && from && end ? Math.max(from, end) : 0;

	let summary;
	if (!range) summary = day ? `Due on day ${day} of each cycle.` : 'Pick the day of the cycle.';
	else if (!from) summary = 'Pick the first day of the cycle.';
	else if (!to) summary = `From day ${from} — now pick the last day.`;
	else summary = `Due between day ${from} and day ${to} of each cycle (${to - from + 1} day${from === to ? '' : 's'}).`;

	if (done && !open) return <Chosen text={summary} onChange={() => setOpen(true)} />;

	return (
		<div className="dp" onMouseLeave={() => setHover(0)}>
			<div className="dp-head">
				<b>Day of the cycle</b>
			</div>
			<div className="dp-grid dp-days" role="grid" aria-label="Day of the cycle">
				{Array.from({ length: 31 }, (_, k) => k + 1).map((n) => {
					const on = range ? n === from || n === to : n === day;
					const cls = ['dp-day', on && 'on', lo && n > lo && n < hi && 'in', lo && n === lo && 'lo', hi && n === hi && 'hi'].filter(Boolean).join(' ');
					return (
						<button key={n} type="button" className={cls} aria-label={`Day ${n}`} aria-pressed={!!on} onClick={() => pick(n)} onMouseEnter={() => picking && setHover(n)}>
							{n}
						</button>
					);
				})}
			</div>
			<div className="dp-foot">
				<span className="dl-note">{summary} Cycles shorter than the day picked end on their last day.</span>
			</div>
		</div>
	);
}

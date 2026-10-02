import { useState } from 'react';
import { usePortal } from '../../context.js';
import { short } from '../../lib/format.js';
import { DEFAULT_MESSAGES, WEEKDAYS, messages, teamWeekly, weekdays } from '../../lib/people.js';
import { rowsOf } from '../../lib/store.js';

const ORDER = [6, 0, 1, 2, 3, 4, 5]; // Sat … Fri, as the team's week runs.

function DayChips({ value, onToggle, label }) {
	return (
		<div className="ra-chips" role="group" aria-label={label}>
			{ORDER.map((d) => (
				<button key={d} type="button" className="ra-chip" aria-pressed={value.includes(d)} onClick={() => onToggle(d)}>
					{WEEKDAYS[d]}
				</button>
			))}
		</div>
	);
}

// Team → Settings → Days off (Super Admin, SPEC.md 6.10).
export function DaysOff() {
	const { api, data, dispatch, toast, confirm } = usePortal();
	const team = teamWeekly(data);
	const people = rowsOf(data, 'members')
		.filter((m) => m.active)
		.sort((a, b) => a.name.localeCompare(b.name));
	const [who, setWho] = useState('');
	const [form, setForm] = useState({ kind: 'event', name: '', from: '', to: '' });
	const list = rowsOf(data, 'days_off').sort((a, b) => a.from_date.localeCompare(b.from_date));
	const person = data.members[who];
	const own = person ? weekdays(person.weekly_off) : null;

	const saveTeam = async (days) => {
		try {
			const res = await api.put('days-off/weekly', { weekdays: days });
			dispatch({ type: 'upsert', table: 'settings', row: res.setting });
			toast('Weekly day off saved');
		} catch (err) {
			toast(err.message);
		}
	};
	const saveOwn = async (days) => {
		try {
			dispatch({ type: 'upsert', table: 'members', row: await api.put('days-off/weekly', { weekdays: days, member: who }) });
			toast(days === null ? `${person.name} follows the team’s day off` : `${person.name}’s weekly day off saved`);
		} catch (err) {
			toast(err.message);
		}
	};
	const toggle = (list, d) => (list.includes(d) ? list.filter((x) => x !== d) : [...list, d]).sort();

	const add = async (e) => {
		e.preventDefault();
		try {
			const row = await api.post('days-off', { kind: form.kind, name: form.name, from: form.from, to: form.kind === 'event' ? form.from : form.to });
			dispatch({ type: 'upsert', table: 'days_off', row });
			toast(`${row.name} added`);
			setForm({ kind: form.kind, name: '', from: '', to: '' });
		} catch (err) {
			toast(err.message);
		}
	};
	const remove = async (o) => {
		if (!(await confirm({ title: `Remove ${o.name}?`, message: 'It becomes a working day again.', ok: 'Remove', danger: true }))) return;
		try {
			await api.del(`days-off/${o.id}`);
			dispatch({ type: 'remove', table: 'days_off', id: o.id });
			toast(`${o.name} removed`);
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<section className="dcard">
			<div className="dc-head">
				<span className="s-k">Days off</span>
			</div>
			<div className="do-sec">
				<b>Weekly day off (whole team)</b>
				<DayChips value={team} label="Team weekly day off" onToggle={(d) => saveTeam(toggle(team, d))} />
			</div>
			<div className="do-sec">
				<b>A person’s own weekly day off</b>
				<div className="do-row">
					<select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
						<option value="">Pick a person</option>
						{people.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
								{weekdays(p.weekly_off) ? ` · own: ${weekdays(p.weekly_off).map((d) => WEEKDAYS[d]).join(', ') || 'none'}` : ''}
							</option>
						))}
					</select>
					{person && own && (
						<button type="button" className="linkbtn" onClick={() => saveOwn(null)}>
							Same as the team
						</button>
					)}
				</div>
				{person && <DayChips value={own || team} label={`${person.name}’s weekly day off`} onToggle={(d) => saveOwn(toggle(own || team, d))} />}
			</div>
			<div className="do-sec">
				<b>Events and seasons</b>
				{list.length === 0 ? (
					<p className="muted">No event or seasonal days off yet.</p>
				) : (
					<ul className="do-list">
						{list.map((o) => (
							<li key={o.id}>
								<b>{o.from_date === o.to_date ? short(o.from_date) : `${short(o.from_date)} – ${short(o.to_date)}`}</b>
								<span>{o.name}</span>
								<span className="muted">{o.kind === 'seasonal' ? 'Seasonal' : 'Event'} · whole team</span>
								<button type="button" className="linkbtn danger" onClick={() => remove(o)} aria-label={`Remove ${o.name}`}>
									Remove
								</button>
							</li>
						))}
					</ul>
				)}
				<form className="do-form" onSubmit={add}>
					<select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} aria-label="Kind">
						<option value="event">Event (one day)</option>
						<option value="seasonal">Seasonal (several days)</option>
					</select>
					<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Durga Puja" aria-label="Day off name" maxLength={191} />
					<input type="date" value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} aria-label="Date" />
					{form.kind === 'seasonal' && <input type="date" value={form.to} min={form.from} onChange={(e) => setForm({ ...form, to: e.target.value })} aria-label="Last day" />}
					<button type="submit" className="btn small primary">
						+ Add day off
					</button>
				</form>
			</div>
			<p className="hint">Days off never use anyone’s leave. Deadlines don’t move on days off.</p>
		</section>
	);
}

const MSG = [
	['birthday', 'Birthday'],
	['day_off', 'Signed in on a day off'],
	['leave_approved', 'Leave approved (when no message is typed)'],
];

// Team → Settings → Automatic messages (Super Admin).
export function AutoMessages() {
	const { api, data, dispatch, toast } = usePortal();
	const [f, setF] = useState(() => messages(data));

	const save = async (e) => {
		e.preventDefault();
		try {
			const res = await api.put('settings/messages', f);
			dispatch({ type: 'upsert', table: 'settings', row: res.setting });
			setF(Object.fromEntries(MSG.map(([k]) => [k, res[k]])));
			toast('Messages saved');
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<form className="dcard" onSubmit={save}>
			<div className="dc-head">
				<span className="s-k">Automatic messages</span>
			</div>
			{MSG.map(([k, l]) => (
				<label key={k} className="am-field">
					{l}
					<textarea rows={2} value={f[k]} maxLength={500} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={DEFAULT_MESSAGES[k]} />
				</label>
			))}
			<p className="hint">{'{name}'} is replaced by the person’s first name. Leave a message empty to use the default.</p>
			<div>
				<button type="submit" className="btn small primary">
					Save messages
				</button>
			</div>
		</form>
	);
}

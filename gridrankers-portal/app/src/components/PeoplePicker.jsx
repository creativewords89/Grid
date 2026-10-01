import { useState } from 'react';
import Avatar from './Avatar.jsx';
import { ROLE } from '../lib/roles.js';

// Searchable people picker (reference renderPicker). With `counts`, each chosen person has
// a share; shares never add up to more than `target` (editing one rebalances the others).
export function evenSplit(ids, target) {
	const per = Math.floor(target / ids.length);
	const extra = target % ids.length;
	return ids.map((id, k) => ({ id, n: Math.max(1, per + (k < extra ? 1 : 0)) }));
}

export function capShare(value, id, target) {
	const ids = value.map((a) => a.id);
	const v = Math.max(1, Math.min(target - Math.max(0, ids.length - 1), parseInt(id.n, 10) || 1));
	const others = value.filter((a) => a.id !== id.id);
	const rest = target - v;
	const per = others.length ? Math.floor(rest / others.length) : 0;
	const ex = others.length ? rest % others.length : 0;
	let k = 0;
	return value.map((a) => (a.id === id.id ? { id: a.id, n: v } : { id: a.id, n: Math.max(1, per + (k++ < ex ? 1 : 0)) }));
}

export default function PeoplePicker({ members, value, onChange, counts, target, disabled, id }) {
	const [q, setQ] = useState('');
	const people = [...members].filter((m) => +m.active !== 0).sort((a, b) => a.name.localeCompare(b.name));
	const chosen = new Map(value.map((a) => [a.id, a.n || 1]));
	const selected = people.filter((p) => chosen.has(p.id));
	const t = Math.max(1, target || 1);

	const toggle = (pid, on) => {
		if (!on) return onChange(value.filter((a) => a.id !== pid));
		const next = [...value, { id: pid, n: 1 }];
		if (!counts) return onChange(next);
		const used = value.reduce((a, x) => a + (x.n || 0), 0);
		onChange(t - used >= 1 ? next.map((a) => (a.id === pid ? { id: pid, n: t - used } : a)) : evenSplit(next.map((a) => a.id), t));
	};

	const sum = value.reduce((a, x) => a + (x.n || 0), 0);
	const note = counts ? (!value.length ? '' : sum === t ? `Shares add up to ${sum} of ${t} ✓` : `Shares add up to ${sum} — the task target is ${t}`) : value.length > 1 ? `${value.length} people share this task` : '';

	return (
		<>
			<div className="pk-list pk2" id={id}>
				<div className="pk2-sel">
					{selected.length ? (
						selected.map((p) => (
							<span className="pk2-chip" key={p.id}>
								<Avatar person={p} small />
								<b>{p.name}</b>
								{counts && (
									<>
										<input
											type="number"
											min={1}
											max={999}
											value={chosen.get(p.id)}
											aria-label={`${p.name}'s share`}
											disabled={disabled}
											onChange={(e) => onChange(capShare(value, { id: p.id, n: e.target.value }, t))}
										/>
										<small>of {t}</small>
									</>
								)}
								{!disabled && (
									<button type="button" className="pk2-x" aria-label={`Remove ${p.name}`} onClick={() => toggle(p.id, false)}>
										✕
									</button>
								)}
							</span>
						))
					) : (
						<span className="pk2-none">Nobody selected yet — pick from the list below.</span>
					)}
				</div>
				{!disabled && (
					<>
						<div className="pk2-find">
							<input type="search" className="pk2-q" placeholder={`Search ${people.length} people…`} aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
							<span className="pk2-count">{selected.length} selected</span>
						</div>
						<ul className="pk2-list">
							{people
								.filter((p) => !q || p.name.toLowerCase().includes(q.trim().toLowerCase()))
								.map((p) => (
									<li key={p.id}>
										<label className={'pk-row' + (chosen.has(p.id) ? ' on' : '')}>
											<input type="checkbox" checked={chosen.has(p.id)} onChange={(e) => toggle(p.id, e.target.checked)} />
											<Avatar person={p} small />
											<b>{p.name}</b>
											<small>{p.title || ROLE[p.role || 'member']}</small>
										</label>
									</li>
								))}
						</ul>
					</>
				)}
			</div>
			<span className={'pk-total ' + (!counts || !value.length || sum === t ? 'ok' : 'warn')}>{note}</span>
		</>
	);
}

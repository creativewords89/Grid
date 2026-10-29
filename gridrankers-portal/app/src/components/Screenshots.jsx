import { useEffect, useState } from 'react';
import { usePortal } from '../context.js';
import { hoursPeople } from '../lib/hours.js';
import { entryLabel, localTime } from '../lib/timer.js';
import Modal from './Modal.jsx';

// Screenshots on the tracker portal (SPEC.md 6.23): a day per person, the pictures in a grid by time
// with their task; a click opens one large; the Super Admin may delete one.
export default function Screenshots() {
	const { api, data, me, today, toast } = usePortal();
	const people = hoursPeople(data.members, me);
	const [who, setWho] = useState(people[0] ? people[0].id : '');
	const [day, setDay] = useState(today);
	const [list, setList] = useState(null);
	const [every, setEvery] = useState(null);
	const [open, setOpen] = useState(null);

	useEffect(() => {
		if (!who) return undefined;
		let gone = false;
		setList(null);
		api
			.get('screenshots', { member: who, day })
			.then((res) => !gone && (setList(res.screenshots), setEvery(res.every)))
			.catch((err) => !gone && (setList([]), toast(err.message)));
		return () => {
			gone = true;
		};
	}, [api, who, day, toast]);

	const remove = async (shot) => {
		try {
			await api.del(`screenshots/${shot.id}`);
			setList((l) => (l || []).filter((s) => s.id !== shot.id));
			setOpen(null);
			toast('Screenshot deleted');
		} catch (err) {
			toast(err.message);
		}
	};
	const entries = data.time_entries || {};

	return (
		<div className="dcard shots">
			<div className="tt-head">
				<h3>Screenshots</h3>
				<label className="shots-f">
					<span>Person</span>
					<select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
						{people.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name}
							</option>
						))}
					</select>
				</label>
				<label className="shots-f">
					<span>Day</span>
					<input type="date" value={day} max={today} onChange={(e) => e.target.value && setDay(e.target.value)} aria-label="Day" />
				</label>
			</div>
			{every === 0 && <p className="hint">Screenshots are off. {me.role === 'admin' ? 'Turn them on in Settings.' : ''}</p>}
			{!who ? (
				<p className="empty">Nobody tracks time here yet.</p>
			) : !list ? (
				<p className="empty">Loading…</p>
			) : !list.length ? (
				<p className="empty">No screenshots this day.</p>
			) : (
				<ul className="shots-grid">
					{list.map((s) => (
						<li key={s.id}>
							<button type="button" className="shots-item" onClick={() => setOpen(s)} aria-label={`Screenshot at ${localTime(s.taken_at)}`}>
								<Shot id={s.id} />
								<span className="shots-cap">
									<b>{localTime(s.taken_at)}</b> {entries[s.entry_id] ? entryLabel(entries[s.entry_id], data) : ''}
								</span>
							</button>
						</li>
					))}
				</ul>
			)}
			<Modal open={!!open} onClose={() => setOpen(null)} className="shots-big" labelledBy="shots-big-h">
				{open && (
					<>
						<h3 id="shots-big-h">
							{localTime(open.taken_at)} · {entries[open.entry_id] ? entryLabel(entries[open.entry_id], data) : 'Tracked time'}
						</h3>
						<Shot id={open.id} big />
						<div className="acts">
							{me.role === 'admin' && (
								<button type="button" className="btn danger" onClick={() => remove(open)}>
									Delete
								</button>
							)}
							<button type="button" className="btn" onClick={() => setOpen(null)}>
								Close
							</button>
						</div>
					</>
				)}
			</Modal>
		</div>
	);
}

// One picture, fetched with the portal's sign-in (an <img> can't send it).
function Shot({ id, big }) {
	const { api } = usePortal();
	const [url, setUrl] = useState('');
	useEffect(() => {
		let made = '';
		let gone = false;
		api
			.blob(`screenshots/${id}`)
			.then((b) => {
				if (gone) return;
				made = URL.createObjectURL(b);
				setUrl(made);
			})
			.catch(() => {});
		return () => {
			gone = true;
			if (made) URL.revokeObjectURL(made);
		};
	}, [api, id]);
	return url ? <img src={url} alt="" className={big ? 'shots-img big' : 'shots-img'} /> : <span className="shots-img wait" aria-hidden="true" />;
}

// The Super Admin's setting: Off, or every 5 / 10 / 15 / 30 minutes.
export function ScreenshotSettings() {
	const { api, toast } = usePortal();
	const [every, setEvery] = useState(null);
	useEffect(() => {
		api
			.get('screenshots')
			.then((res) => setEvery(res.every))
			.catch(() => setEvery(0));
	}, [api]);
	const save = async (value) => {
		try {
			const res = await api.put('settings/screenshots', { every: +value });
			setEvery(res.every);
			toast(res.every ? `A screenshot every ${res.every} minutes while a timer runs` : 'Screenshots are off');
		} catch (err) {
			toast(err.message);
		}
	};
	return (
		<div className="dcard">
			<h3>Screenshots</h3>
			<p className="hint">While a timer runs, the desktop tracker takes one at a random moment in each period. People are told before their first one; screenshots are kept 30 days.</p>
			<label className="shots-f">
				<span>Take one</span>
				<select value={every ?? ''} onChange={(e) => save(e.target.value)} aria-label="Screenshots" disabled={every === null}>
					<option value="0">Off</option>
					{[5, 10, 15, 30].map((n) => (
						<option key={n} value={n}>
							every {n} minutes
						</option>
					))}
				</select>
			</label>
		</div>
	);
}

import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { summary } from '../../lib/reports.js';
import { EntryRow } from './parts.jsx';
import WorkDialog from './WorkDialog.jsx';

// A person's own report for one day (SPEC.md 6.18, designs DR-A and DR-A2): the entries as quiet
// rows (click one to edit it), + Add work, Blocking and Tomorrow, and Send. Saved as they type;
// today's report can still change after it is sent, until midnight.
//
// `compact` (the sign-out and missing-report windows, design DR-D) puts the notes behind a link.
// `sendLabel` / `onSent` change what Send does there.
export default function ReportEditor({ day, report, onSaved, compact = false, sendLabel = 'Send report', onSent, hideSend = false, sendRef }) {
	const { api, toast, viewOnly } = usePortal();
	const [entries, setEntries] = useState((report && report.entries) || []);
	const [blocking, setBlocking] = useState((report && report.blocking) || '');
	const [tomorrow, setTomorrow] = useState((report && report.tomorrow) || '');
	const [editing, setEditing] = useState(null); // null, 'new' or an entry
	const [notesOpen, setNotesOpen] = useState(!compact);
	const [sending, setSending] = useState(false);
	const [error, setError] = useState('');
	const timer = useRef(null);
	const latest = useRef({ entries, blocking, tomorrow });
	latest.current = { entries, blocking, tomorrow };
	const sent = !!(report && report.sent_at);
	// Tracked time (SPEC.md 6.21) changes the report on the server: take in its lines when it does.
	const stamp = report && report.updated_at;
	useEffect(() => {
		if (report && Array.isArray(report.entries)) setEntries(report.entries);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [stamp]);

	const save = async (body, send = false) => {
		const res = await api.put(`daily-reports/${day}`, { ...body, ...(send ? { send: true } : {}) });
		if (onSaved) onSaved(res);
		return res;
	};
	// The server keeps tracked lines as the timer has them (SPEC.md 6.21): show what it saved.
	const saveNow = (next) =>
		save(next)
			.then((res) => res && Array.isArray(res.entries) && setEntries(res.entries))
			.catch((err) => {
				setError(err.message);
			});

	// Notes save a moment after typing stops.
	const later = (next) => {
		window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => saveNow(next), 700);
	};
	useEffect(() => () => window.clearTimeout(timer.current), []);

	const putEntries = (list) => {
		setEntries(list);
		setError('');
		saveNow({ ...latest.current, entries: list });
	};

	const send = async () => {
		window.clearTimeout(timer.current);
		if (!entries.length) {
			setError('Add at least one thing you did.');
			return;
		}
		setSending(true);
		try {
			const res = await save(latest.current, true);
			setError('');
			if (onSent) onSent(res);
			else toast(sent ? 'Report updated' : 'Report sent');
		} catch (err) {
			setError(err.message);
		} finally {
			setSending(false);
		}
	};
	if (sendRef) sendRef.current = send;

	return (
		<div className={'dr-editor' + (compact ? ' compact' : '')}>
			<ul className="dr-list" aria-label="What you did">
				{entries.map((e) => (
					<EntryRow key={e.id} entry={e} onOpen={viewOnly ? null : setEditing} />
				))}
				<li className="dr-add">
					<button type="button" className="linkbtn" onClick={() => setEditing('new')} disabled={viewOnly}>
						+ Add work
					</button>
				</li>
			</ul>
			{compact && !notesOpen ? (
				<div className="dr-compact-sum">
					<span>{summary(entries)}</span>
					<button type="button" className="linkbtn" onClick={() => setNotesOpen(true)}>
						Blocking / tomorrow (optional) ›
					</button>
				</div>
			) : (
				<div className="dr-notes edit">
					<label>
						<span>Blocking</span>
						<textarea
							rows={1}
							value={blocking}
							placeholder="Anything blocking you? (optional)"
							aria-label="Anything blocking you?"
							maxLength={2000}
							disabled={viewOnly}
							onChange={(e) => {
								setBlocking(e.target.value);
								later({ ...latest.current, blocking: e.target.value });
							}}
						/>
					</label>
					<label>
						<span>Tomorrow</span>
						<textarea
							rows={1}
							value={tomorrow}
							placeholder="Plan for tomorrow (optional)"
							aria-label="Plan for tomorrow"
							maxLength={2000}
							disabled={viewOnly}
							onChange={(e) => {
								setTomorrow(e.target.value);
								later({ ...latest.current, tomorrow: e.target.value });
							}}
						/>
					</label>
				</div>
			)}
			<p className="err" role="alert">
				{error}
			</p>
			{!hideSend && (
				<button type="button" className="btn primary dr-send" onClick={send} disabled={sending || viewOnly}>
					{sending ? 'Sending…' : sendLabel}
				</button>
			)}
			<WorkDialog
				open={!!editing}
				entry={editing === 'new' ? null : editing}
				onClose={() => setEditing(null)}
				onSave={(entry) => {
					const exists = entries.some((x) => x.id === entry.id);
					putEntries(exists ? entries.map((x) => (x.id === entry.id ? entry : x)) : [...entries, entry]);
					setEditing(null);
				}}
				onRemove={(entry) => {
					if (sent && entries.length === 1) {
						setError('A sent report needs at least one entry.');
						setEditing(null);
						return;
					}
					putEntries(entries.filter((x) => x.id !== entry.id));
					setEditing(null);
				}}
			/>
		</div>
	);
}

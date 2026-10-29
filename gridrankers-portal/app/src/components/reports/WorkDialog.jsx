import { useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { rowsOf } from '../../lib/store.js';
import { FILE_ACCEPT, MAX_ATTACH, MAX_FILE_BYTES } from '../../lib/files.js';
import { OTHER_PROJECTS, TIME_CHIPS, cleanLink, entryError, fmtMinutes, toMinutes } from '../../lib/reports.js';
import { isTracked } from '../../lib/timer.js';
import Modal from '../Modal.jsx';
import { FileChip, LinkChip } from './parts.jsx';

const newId = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// Add work (SPEC.md 6.18, design DR-A2): what you did, details, project, time spent (15m · 30m ·
// 1h · 2h · Other), and files and links. Also edits an entry (with Remove).
export default function WorkDialog({ open, entry, onClose, onSave, onRemove }) {
	return (
		<Modal open={open} onClose={onClose} className="dr-dlg" labelledBy="drWorkTitle">
			{open && <WorkForm entry={entry} onClose={onClose} onSave={onSave} onRemove={onRemove} />}
		</Modal>
	);
}

function WorkForm({ entry, onClose, onSave, onRemove }) {
	const { api, data, toast } = usePortal();
	const editing = !!entry;
	const [title, setTitle] = useState(entry ? entry.title : '');
	const [details, setDetails] = useState(entry ? entry.details || '' : '');
	const [project, setProject] = useState(entry ? entry.project || '' : '');
	const [minutes, setMinutes] = useState(entry ? +entry.minutes || 0 : 0);
	const [other, setOther] = useState(!!entry && !TIME_CHIPS.includes(+entry.minutes));
	const [hours, setHours] = useState(entry ? String(Math.floor((+entry.minutes || 0) / 60)) : '');
	const [mins, setMins] = useState(entry ? String((+entry.minutes || 0) % 60) : '');
	const [files, setFiles] = useState(entry ? entry.files || [] : []);
	const [links, setLinks] = useState(entry ? entry.links || [] : []);
	const [linkOpen, setLinkOpen] = useState(false);
	const [url, setUrl] = useState('');
	const [linkName, setLinkName] = useState('');
	const [busy, setBusy] = useState(0);
	const [error, setError] = useState('');
	const tracked = isTracked(entry);
	const picker = useRef(null);

	const projects = rowsOf(data, 'projects')
		.filter((p) => p.state !== 'inactive' || p.id === project)
		.sort((a, b) => a.name.localeCompare(b.name));
	const spent = other ? toMinutes(hours, mins) : minutes;

	const upload = async (chosen) => {
		let list = files;
		for (const file of Array.from(chosen || [])) {
			if (list.length >= MAX_ATTACH) {
				toast('Attach at most 10 files.');
				break;
			}
			if (file.size > MAX_FILE_BYTES) {
				toast(`“${file.name}” is larger than 10 MB.`);
				continue;
			}
			setBusy((n) => n + 1);
			try {
				const meta = await api.upload('files', file);
				list = [...list, meta];
				setFiles(list);
			} catch (err) {
				toast(err.message);
			} finally {
				setBusy((n) => n - 1);
			}
		}
	};

	const addLink = () => {
		const link = cleanLink(url, linkName);
		if (!link) {
			setError('The link should start with https://');
			return;
		}
		if (links.length >= 10) {
			setError('Add at most 10 links.');
			return;
		}
		setLinks([...links, link]);
		setUrl('');
		setLinkName('');
		setLinkOpen(false);
		setError('');
	};

	const submit = (e) => {
		e.preventDefault();
		// A tracked line (SPEC.md 6.21) keeps its task, project and minutes: they follow the timer.
		const next = tracked ? { ...entry, details: details.trim(), files, links } : { id: entry ? entry.id : newId(), title: title.trim(), details: details.trim(), project, minutes: spent, files, links };
		const err = entryError(next) || (busy ? 'Wait for the files to finish uploading.' : '');
		if (err) {
			setError(err);
			return;
		}
		onSave(next);
	};

	return (
		<form onSubmit={submit} noValidate className="dr-form">
			<div className="dr-form-h">
				<h2 id="drWorkTitle">{editing ? 'Edit work' : 'Add work'}</h2>
				<button type="button" className="dr-x" aria-label="Close" onClick={onClose}>
					×
				</button>
			</div>
			<input className="dr-in" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What did you do?" aria-label="What did you do?" autoFocus={!tracked} disabled={tracked} />
			<textarea className="dr-in" rows={3} value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} placeholder="Add details — what you did, results (optional)" aria-label="Details" />
			<label className="dr-lab">
				Project
				<select className="dr-in" value={project} onChange={(e) => setProject(e.target.value)} aria-label="Project" disabled={tracked}>
					<option value="">No project</option>
					{projects.map((p) => (
						<option key={p.id} value={p.id}>
							{p.name}
						</option>
					))}
					{Object.entries(OTHER_PROJECTS).map(([k, v]) => (
						<option key={k} value={k}>
							{v}
						</option>
					))}
				</select>
			</label>
			{tracked ? (
				<p className="dr-tracked-note">
					⏱ <b>{fmtMinutes(entry.minutes)}</b> tracked by the timer. Fix the time in the timer — typed time can’t replace it.
				</p>
			) : (
			<div className="dr-lab" role="group" aria-label="Time spent">
				Time spent
				<div className="dr-chips">
					{TIME_CHIPS.map((m) => (
						<button key={m} type="button" className="dr-chip" aria-pressed={!other && minutes === m} onClick={() => (setOther(false), setMinutes(m))}>
							{fmtMinutes(m)}
						</button>
					))}
					<button type="button" className="dr-chip" aria-pressed={other} onClick={() => setOther(true)}>
						Other
					</button>
				</div>
				{other && (
					<div className="dr-hm">
						<input className="dr-in" type="number" min="0" max="24" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours" />h
						<input className="dr-in" type="number" min="0" max="59" value={mins} onChange={(e) => setMins(e.target.value)} aria-label="Minutes" />m
					</div>
				)}
			</div>
			)}
			<div className="dr-lab">
				Files and links
				{(files.length > 0 || links.length > 0) && (
					<div className="dr-att">
						{files.map((f) => (
							<FileChip key={f.id} file={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
						))}
						{links.map((l, i) => (
							<LinkChip key={l.url + i} link={l} onRemove={() => setLinks(links.filter((_, j) => j !== i))} />
						))}
					</div>
				)}
				<div className="dr-chips">
					<button type="button" className="dr-pillbtn" onClick={() => picker.current && picker.current.click()} disabled={busy > 0}>
						📎 {busy > 0 ? 'Uploading…' : 'Attach file'}
					</button>
					<button type="button" className="dr-pillbtn" aria-expanded={linkOpen} onClick={() => setLinkOpen(!linkOpen)}>
						🔗 Add link
					</button>
					<input
						ref={picker}
						type="file"
						multiple
						hidden
						aria-label="Entry files"
						accept={FILE_ACCEPT}
						onChange={(e) => {
							upload(e.target.files);
							e.target.value = '';
						}}
					/>
				</div>
				{linkOpen && (
					<div className="dr-link">
						<input className="dr-in" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" aria-label="Link" />
						<div className="dr-link-row">
							<input className="dr-in" value={linkName} onChange={(e) => setLinkName(e.target.value)} placeholder="Name (optional)" aria-label="Link name" maxLength={120} />
							<button type="button" className="btn small primary" onClick={addLink}>
								Add
							</button>
						</div>
					</div>
				)}
			</div>
			<p className="err" role="alert">
				{error}
			</p>
			<div className="dlg-acts">
				{editing && onRemove && !tracked && (
					<button type="button" className="btn danger-soft dr-remove" onClick={() => onRemove(entry)}>
						Remove
					</button>
				)}
				<button type="button" className="btn" onClick={onClose}>
					Cancel
				</button>
				<button type="submit" className="btn primary">
					{editing ? 'Save' : 'Add'}
				</button>
			</div>
		</form>
	);
}

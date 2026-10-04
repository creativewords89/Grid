import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../context.js';
import { FILE_ACCEPT, MAX_ATTACH, MAX_FILE_BYTES, fileBadge, fileSize } from '../lib/files.js';
import { isManager } from '../lib/roles.js';
import { rowsOf } from '../lib/store.js';
import Modal from './Modal.jsx';

// "Submit completed work" (SPEC.md 6.6, design SF-A): everyone fills it in when work is completed —
// what they did (required), links, files and a comment for the reviewer. Team Leaders and the
// Super Admin also choose Done — no review needed (default) or Ask someone to review it. The same
// form edits a saved submission (SF-B, `edit`). Resolves through onSubmit({note, links, files,
// comment, reviewer}).
export default function CompletionDialog({ open, title, edit, initial, onCancel, onSubmit }) {
	const { api, data, me } = usePortal();
	const [note, setNote] = useState('');
	const [links, setLinks] = useState([]);
	const [linkDraft, setLinkDraft] = useState('');
	const [files, setFiles] = useState([]);
	const [uploading, setUploading] = useState([]);
	const [comment, setComment] = useState('');
	const [ask, setAsk] = useState(false);
	const [reviewer, setReviewer] = useState('');
	const [error, setError] = useState('');
	const [drag, setDrag] = useState(false);
	const picker = useRef(null);
	const leader = isManager(me) && !edit;

	useEffect(() => {
		if (!open) return;
		const c = initial || {};
		setNote(c.note || '');
		setLinks(Array.isArray(c.links) ? c.links : c.link ? [c.link] : []);
		setLinkDraft('');
		setFiles(Array.isArray(c.files) ? c.files : []);
		setUploading([]);
		setComment(c.comment || '');
		setAsk(false);
		setReviewer('');
		setError('');
	}, [open, initial]);

	const people = rowsOf(data, 'members')
		.filter((m) => m.active && m.id !== me.id)
		.sort((a, b) => a.name.localeCompare(b.name));

	const addLink = () => {
		const l = linkDraft.trim();
		if (!l) return true;
		if (!/^https?:\/\/[^/\s]+/i.test(l)) {
			setError('The link should start with https://');
			return false;
		}
		if (links.length >= MAX_ATTACH) {
			setError('Add at most 10 links.');
			return false;
		}
		if (!links.includes(l)) setLinks([...links, l]);
		setLinkDraft('');
		setError('');
		return true;
	};

	const addFiles = async (list) => {
		const chosen = Array.from(list || []);
		if (!chosen.length) return;
		if (files.length + uploading.length + chosen.length > MAX_ATTACH) return setError('Attach at most 10 files.');
		setError('');
		for (const file of chosen) {
			if (file.size > MAX_FILE_BYTES) {
				setError(`“${file.name}” is larger than 10 MB.`);
				continue;
			}
			const key = file.name + ':' + file.size + ':' + Math.random();
			setUploading((u) => [...u, { key, name: file.name, size: file.size }]);
			try {
				const meta = await api.upload('files', file);
				setFiles((f) => [...f, meta]);
			} catch (err) {
				setError(err.message);
			} finally {
				setUploading((u) => u.filter((x) => x.key !== key));
			}
		}
	};

	const submit = (e) => {
		e.preventDefault();
		if (note.trim().length < 3) return setError('Add a few words about what you completed.');
		if (!addLink()) return;
		if (uploading.length) return setError('Wait for the files to finish uploading.');
		if (leader && ask && !reviewer) return setError('Pick who should review it.');
		const draft = linkDraft.trim();
		onSubmit({
			note: note.trim(),
			links: draft && !links.includes(draft) ? [...links, draft] : links,
			files: files.map((f) => f.id),
			fileMeta: files,
			comment: comment.trim(),
			...(leader && ask ? { reviewer } : {}),
		});
	};

	return (
		<Modal open={open} onClose={onCancel} labelledBy="grpDoneTitle" className="sf-dlg">
			<form onSubmit={submit} noValidate>
				<h2 id="grpDoneTitle">{edit ? 'Edit submission' : 'Submit completed work'}</h2>
				{title && (
					<p className="hint">
						“{title}”{' '}
						{edit ? '· changes are saved on the same submission, marked “edited”' : isManager(me) ? '· you’re a ' + (me.role === 'admin' ? 'Super Admin' : 'Team Leader') : '· goes to your Team Leader / Super Admin for review'}
					</p>
				)}
				<label>
					<span>
						What you did <small className="sf-req">Required</small>
					</span>
					<textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} autoFocus required />
				</label>

				<div className="sf-field">
					<span className="sf-lab">
						Links <small>optional</small>
					</span>
					{links.map((l) => (
						<div key={l} className="sf-row">
							<span className="sf-link-ic" aria-hidden="true">
								↗
							</span>
							<span className="sf-row-name">{l.replace(/^https?:\/\//, '')}</span>
							<button type="button" className="sf-x" aria-label={`Remove link ${l}`} onClick={() => setLinks(links.filter((x) => x !== l))}>
								×
							</button>
						</div>
					))}
					<div className="sf-add">
						<input
							type="url"
							value={linkDraft}
							placeholder="Paste a link (https://…)"
							aria-label="Link"
							onChange={(e) => setLinkDraft(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									addLink();
								}
							}}
						/>
						<button type="button" className="linkbtn" onClick={addLink}>
							+ Add
						</button>
					</div>
				</div>

				<div className="sf-field">
					<span className="sf-lab">
						Files <small>optional</small>
					</span>
					{files.map((f) => (
						<div key={f.id} className="sf-row">
							<span className={'sf-badge ' + fileBadge(f).tone}>{fileBadge(f).label}</span>
							<span className="sf-row-name">
								<b>{f.name}</b>
								<small>{fileSize(f.size)}</small>
							</span>
							<button type="button" className="sf-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((x) => x.id !== f.id))}>
								×
							</button>
						</div>
					))}
					{uploading.map((u) => (
						<div key={u.key} className="sf-row uploading">
							<span className="sf-badge">…</span>
							<span className="sf-row-name">
								<b>{u.name}</b>
								<small>{fileSize(u.size)} · uploading</small>
							</span>
						</div>
					))}
					<div
						className={'sf-drop' + (drag ? ' on' : '')}
						onDragOver={(e) => {
							e.preventDefault();
							setDrag(true);
						}}
						onDragLeave={() => setDrag(false)}
						onDrop={(e) => {
							e.preventDefault();
							setDrag(false);
							addFiles(e.dataTransfer.files);
						}}
					>
						<span>
							<button type="button" className="linkbtn" onClick={() => picker.current && picker.current.click()}>
								Choose files
							</button>{' '}
							or drop them here
						</span>
						<small>PDF, images, Word, Excel, CSV · up to 10 MB each · 10 files</small>
						<input
							ref={picker}
							type="file"
							multiple
							hidden
							accept={FILE_ACCEPT}
							aria-label="Attach files"
							onChange={(e) => {
								addFiles(e.target.files);
								e.target.value = '';
							}}
						/>
					</div>
				</div>

				<label>
					<span>
						{edit ? 'Comment' : 'Comment for the reviewer'} <small>optional</small>
					</span>
					<input type="text" value={comment} maxLength={1000} placeholder="e.g. Two sites still waiting for email confirmation" onChange={(e) => setComment(e.target.value)} />
				</label>

				{leader && (
					<fieldset className="sf-review">
						<legend>Review</legend>
						<label className={'sf-opt' + (!ask ? ' on' : '')}>
							<input type="radio" name="sf-review" checked={!ask} onChange={() => setAsk(false)} />
							<span>
								<b>Done — no review needed</b>
								<small>Completed now. You can still edit this later.</small>
							</span>
						</label>
						<label className={'sf-opt' + (ask ? ' on' : '')}>
							<input type="radio" name="sf-review" checked={ask} onChange={() => setAsk(true)} />
							<span>
								<b>Ask someone to review it</b>
								<small>Pick anyone on your team; it waits for them.</small>
							</span>
						</label>
						<select value={reviewer} disabled={!ask} onChange={(e) => setReviewer(e.target.value)} aria-label="Reviewer">
							<option value="">Pick someone</option>
							{people.map((m) => (
								<option key={m.id} value={m.id}>
									{m.name} · {m.role === 'admin' ? 'Super Admin' : m.role === 'lead' ? 'Team Leader' : 'Team Member'}
								</option>
							))}
						</select>
					</fieldset>
				)}

				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={uploading.length > 0}>
						{edit ? 'Save changes' : leader ? (ask ? 'Send for review' : 'Complete') : 'Submit for review'}
					</button>
				</div>
			</form>
		</Modal>
	);
}

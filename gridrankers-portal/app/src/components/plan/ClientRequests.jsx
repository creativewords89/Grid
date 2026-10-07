import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { FILE_ACCEPT, MAX_ATTACH, MAX_FILE_BYTES, openFile } from '../../lib/files.js';
import { short } from '../../lib/format.js';
import { profileLocked } from '../../lib/people.js';
import { KINDS, KIND_LABEL, STATUSES, STATUS_LABEL, VIAS, VIA_LABEL, canDeleteRequest, isOpenRequest, requestsOf, whenText } from '../../lib/requests.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';
import { FileRow } from '../review/Submission.jsx';

// Stores a request from the server and the status line that came with it.
export function keep(dispatch, row, event) {
	if (!row) return;
	const { event_message: line, ...request } = row;
	dispatch({ type: 'upsert', table: 'client_requests', row: request });
	if (line || event) dispatch({ type: 'upsert', table: 'request_messages', row: line || event });
}

const ROLE = { admin: 'Super Admin', lead: 'Team Leader', member: 'Team Member' };
const FILTERS = [
	['open', 'Open'],
	['done', 'Done'],
	['all', 'All'],
];

function Status({ status }) {
	return (
		<span className={'cr-status s-' + status}>
			<span className={'cr-dot s-' + status} aria-hidden="true" />
			{STATUS_LABEL[status]}
		</span>
	);
}

// + Ask the client: what's needed, its type, a few words for the team, and whether it's already
// been asked (and how).
function AskDialog({ onClose, onSaved }) {
	const { api, project, dispatch } = usePortal();
	const [title, setTitle] = useState('');
	const [kind, setKind] = useState('info');
	const [details, setDetails] = useState('');
	const [asked, setAsked] = useState(false);
	const [via, setVia] = useState('email');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const submit = async (e) => {
		e.preventDefault();
		if (!title.trim()) return setError('Say what you need from the client.');
		setBusy(true);
		try {
			const row = await api.post(`projects/${project}/client-requests`, { title: title.trim(), kind, details: details.trim(), status: asked ? 'asked' : 'needed', via: asked ? via : undefined });
			keep(dispatch, row);
			onSaved(row);
		} catch (err) {
			setError(err.message);
			setBusy(false);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="crAsk" className="bl-dlg cr-dlg">
			<form onSubmit={submit} noValidate>
				<h2 id="crAsk">Ask the client</h2>
				<label>
					What do you need?
					<input value={title} maxLength={191} onChange={(e) => (setTitle(e.target.value), setError(''))} placeholder="e.g. New GBP images, Privacy Policy page" autoFocus />
				</label>
				<div className="bl-methods" role="group" aria-label="Type">
					{KINDS.map(([k, label]) => (
						<button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>
							{label}
						</button>
					))}
				</div>
				<label>
					<span>
						Details for the team <span className="muted">(optional)</span>
					</span>
					<textarea rows={3} value={details} maxLength={4000} onChange={(e) => setDetails(e.target.value)} placeholder="What exactly, and what it's for" />
				</label>
				<label className="cr-check">
					<input type="checkbox" checked={asked} onChange={(e) => setAsked(e.target.checked)} />
					Already asked the client
				</label>
				{asked && (
					<div className="bl-methods" role="group" aria-label="Asked by">
						{VIAS.map(([v, label]) => (
							<button key={v} type="button" aria-pressed={via === v} onClick={() => setVia(v)}>
								{label}
							</button>
						))}
					</div>
				)}
				<p className="err" role="alert">
					{error}
				</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={busy}>
						Add request
					</button>
				</div>
			</form>
		</Modal>
	);
}

// An image in a bubble: loaded through the API (files are private), opens full size.
function Thumb({ file }) {
	const { api, toast } = usePortal();
	const [url, setUrl] = useState('');
	useEffect(() => {
		let live = true;
		let made = '';
		api
			.blob(`files/${file.id}`)
			.then((b) => {
				made = URL.createObjectURL(b);
				if (live) setUrl(made);
			})
			.catch(() => {});
		return () => {
			live = false;
			if (made) URL.revokeObjectURL(made);
		};
	}, [api, file.id]);
	return (
		<button type="button" className="cr-thumb" title={file.name} aria-label={`Open ${file.name}`} onClick={() => openFile(api, file).catch((err) => toast(err.message))}>
			{url ? <img src={url} alt="" /> : <span aria-hidden="true">🖼</span>}
			<small>{file.name}</small>
		</button>
	);
}

// One message: a chat bubble (yours on the right); what the client sent is amber, with its images
// and files. Status changes are thin lines between them.
function Message({ m, mine }) {
	const { api, data, me, dispatch, toast, viewOnly } = usePortal();
	const who = data.members[m.created_by];
	if (m.event) {
		const via = m.via ? ` · by ${VIA_LABEL[m.via] || m.via}` : '';
		return (
			<div className="cr-event" role="note">
				<span>
					Status → {STATUS_LABEL[m.event]}
					{via} · {who ? who.name : 'Someone'} · {short(m.created_at)}
				</span>
			</div>
		);
	}
	const files = m.files || [];
	const images = files.filter((f) => /^image\//.test(f.mime || ''));
	const others = files.filter((f) => !/^image\//.test(f.mime || ''));
	const remove = async () => {
		try {
			dispatch({ type: 'upsert', table: 'request_messages', row: await api.del(`request-messages/${m.id}`) });
		} catch (err) {
			toast(err.message);
		}
	};
	const all = () => files.forEach((f) => openFile(api, f, true).catch((err) => toast(err.message)));
	return (
		<div className={'cr-msg' + (mine ? ' mine' : '') + (m.from_client ? ' client' : '')}>
			<Avatar person={who} small />
			<div className="cr-body">
				<div className="cr-who">
					<b>{who ? who.name : 'Someone'}</b> · {who ? ROLE[who.role] : ''} · {short(m.created_at)}
					{m.from_client ? <span className="cr-tag">From the client{m.via ? ` · ${VIA_LABEL[m.via] || m.via}` : ''}</span> : null}
				</div>
				<div className="cr-bubble">
					{m.deleted_at ? (
						<p className="muted">
							<i>Message deleted</i>
						</p>
					) : (
						<>
							{m.body && <p>{m.body}</p>}
							{images.length > 0 && (
								<div className="cr-thumbs">
									{images.map((f) => (
										<Thumb key={f.id} file={f} />
									))}
								</div>
							)}
							{others.map((f) => (
								<FileRow key={f.id} file={f} />
							))}
							{files.length > 1 && (
								<button type="button" className="linkbtn cr-all" onClick={all}>
									{files.length} files · ⬇ Download all
								</button>
							)}
						</>
					)}
				</div>
			</div>
			{!m.deleted_at && !viewOnly && m.id !== 'details' && (m.created_by === me.id || me.role === 'admin') && (
				<button type="button" className="sf-x" aria-label="Delete message" title="Delete message" onClick={remove}>
					×
				</button>
			)}
		</div>
	);
}

// The composer: write, 📎 attach files, tick "This is from the client" when pasting their reply.
function Composer({ r }) {
	const { api, dispatch, toast } = usePortal();
	const [body, setBody] = useState('');
	const [files, setFiles] = useState([]);
	const [client, setClient] = useState(false);
	const [busy, setBusy] = useState(false);
	const picker = useRef(null);
	const attach = async (chosen) => {
		for (const file of Array.from(chosen || [])) {
			if (files.length >= MAX_ATTACH) return toast('Attach at most 10 files.');
			if (file.size > MAX_FILE_BYTES) {
				toast(`“${file.name}” is larger than 10 MB.`);
				continue;
			}
			try {
				setBusy(true);
				const meta = await api.upload('files', file);
				setFiles((f) => [...f, meta]);
			} catch (err) {
				toast(err.message);
			} finally {
				setBusy(false);
			}
		}
	};
	const send = async (e) => {
		e.preventDefault();
		if (!body.trim() && !files.length) return;
		setBusy(true);
		try {
			const res = await api.post(`client-requests/${r.id}/messages`, { body: body.trim(), files: files.map((f) => f.id), from_client: client });
			dispatch({ type: 'upsert', table: 'request_messages', row: res.message });
			keep(dispatch, res.request, res.event);
			setBody('');
			setFiles([]);
			setClient(false);
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="cr-compose" onSubmit={send}>
			{files.map((f) => (
				<FileRow key={f.id} file={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
			))}
			<textarea rows={2} value={body} maxLength={4000} placeholder="Write a message…" aria-label="Write a message" onChange={(e) => setBody(e.target.value)} />
			<div className="cr-compose-row">
				<button type="button" className="linkbtn" onClick={() => picker.current && picker.current.click()}>
					📎 Attach files
				</button>
				<input
					ref={picker}
					type="file"
					multiple
					hidden
					aria-label="Files to attach"
					accept={FILE_ACCEPT}
					onChange={(e) => {
						attach(e.target.files);
						e.target.value = '';
					}}
				/>
				<label className="cr-check">
					<input type="checkbox" checked={client} onChange={(e) => setClient(e.target.checked)} />
					This is from the client
				</label>
				<button type="submit" className="btn primary" disabled={busy || (!body.trim() && !files.length)}>
					Send
				</button>
			</div>
		</form>
	);
}

// A request as a conversation (design DP-G): header with ← Client requests, title, type, who
// asked and the status menu; then the thread and the composer.
function Thread({ r, onBack }) {
	const { api, data, me, dispatch, toast, confirm, today, viewOnly } = usePortal();
	const can = !viewOnly && !profileLocked(data.members[me.id] || me, me);
	const asker = data.members[r.created_by];
	const end = useRef(null);
	useEffect(() => {
		if (end.current && end.current.scrollIntoView) end.current.scrollIntoView({ block: 'nearest' });
	}, [r.thread.length]);
	const status = async (next, via) => {
		try {
			keep(dispatch, await api.patch(`client-requests/${r.id}`, { status: next, via }));
			toast(`“${r.title}”: ${STATUS_LABEL[next]}`);
		} catch (err) {
			toast(err.message);
		}
	};
	const remove = async () => {
		if (!(await confirm({ title: `Delete “${r.title}”?`, message: 'The request and its messages are removed for everyone.', ok: 'Delete', danger: true }))) return;
		try {
			await api.del(`client-requests/${r.id}`);
			dispatch({ type: 'remove', table: 'client_requests', id: r.id });
			onBack();
		} catch (err) {
			toast(err.message);
		}
	};
	const [via, setVia] = useState(r.asked_via || 'email');
	return (
		<section className="dcard cr-thread" aria-label={r.title}>
			<div className="cr-th-head">
				<button type="button" className="linkbtn" onClick={onBack}>
					← Client requests
				</button>
				<div className="cr-th-title">
					<h3>{r.title}</h3>
					<span className="muted">
						{KIND_LABEL[r.kind]} · asked by {asker ? asker.name : 'someone'} · {short(r.created_at)}
						{r.status === 'asked' && r.asked_at ? ` · asked the client ${whenText(r.asked_at, today).toLowerCase()}` : ''}
					</span>
				</div>
				<span className="cr-th-acts">
					{can ? (
						<label className={'cr-select s-' + r.status}>
							<span className={'cr-dot s-' + r.status} aria-hidden="true" />
							<select aria-label="Status" value={r.status} onChange={(e) => status(e.target.value, e.target.value === 'asked' ? via : undefined)}>
								{STATUSES.map(([k, label]) => (
									<option key={k} value={k}>
										{label}
									</option>
								))}
							</select>
						</label>
					) : (
						<Status status={r.status} />
					)}
					{can && r.status !== 'done' && (
						<button type="button" className="btn" onClick={() => status('done')}>
							Mark done
						</button>
					)}
					{can && canDeleteRequest(me, r) && (
						<button type="button" className="linkbtn danger" onClick={remove}>
							Delete
						</button>
					)}
				</span>
			</div>
			{can && r.status === 'needed' && (
				<div className="cr-askbar">
					<span>Asked the client?</span>
					<select aria-label="Asked by" value={via} onChange={(e) => setVia(e.target.value)}>
						{VIAS.map(([v, label]) => (
							<option key={v} value={v}>
								by {label}
							</option>
						))}
					</select>
					<button type="button" className="btn small" onClick={() => status('asked', via)}>
						Mark as asked
					</button>
				</div>
			)}
			<div className="cr-msgs">
				{r.details && <Message m={{ id: 'details', body: r.details, created_by: r.created_by, created_at: r.created_at, files: [] }} mine={r.created_by === me.id} />}
				{r.thread.map((m) => (
					<Message key={m.id} m={m} mine={m.created_by === me.id} />
				))}
				{!r.details && !r.thread.length && <p className="muted cr-none">No messages yet. Write what the client needs to send, or paste their answer.</p>}
				<span ref={end} />
			</div>
			{can && <Composer r={r} />}
		</section>
	);
}

// Details → Client requests (SPEC.md 6.15, design DP-B): a table of what the team needs from the
// client, Open / Done / All and + Ask the client; a row opens its thread (design DP-G).
export default function ClientRequests({ openId, setOpenId }) {
	const { data, me, project, today, viewOnly } = usePortal();
	const [filter, setFilter] = useState('open');
	const [asking, setAsking] = useState(false);
	const all = requestsOf(data, project);
	const can = !viewOnly && !profileLocked(data.members[me.id] || me, me);
	const current = openId && all.find((r) => r.id === openId);
	if (current) return <Thread r={current} onBack={() => setOpenId('')} />;

	const rows = all.filter((r) => (filter === 'all' ? true : filter === 'done' ? !isOpenRequest(r) : isOpenRequest(r)));
	return (
		<section className="dcard cr-list" aria-label="Client requests">
			<div className="cr-bar">
				<div className="cr-filters" role="group" aria-label="Show">
					{FILTERS.map(([k, label]) => (
						<button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>
							{label}
						</button>
					))}
				</div>
				{can && (
					<button type="button" className="btn primary" onClick={() => setAsking(true)}>
						+ Ask the client
					</button>
				)}
			</div>
			{rows.length === 0 ? (
				<p className="muted cr-none">{filter === 'done' ? 'Nothing done yet.' : filter === 'open' ? 'Nothing waiting on the client. + Ask the client when the team needs something — images, a page, access, information.' : 'No requests yet.'}</p>
			) : (
				<table className="cr-table">
					<thead>
						<tr>
							<th scope="col">Request</th>
							<th scope="col">Type</th>
							<th scope="col">Status</th>
							<th scope="col">Updated</th>
							<th scope="col" className="cr-num">
								Files
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((r) => (
							<tr key={r.id} className="cr-row">
								<td>
									<button type="button" className="cr-open" onClick={() => setOpenId(r.id)}>
										{r.title}
									</button>
								</td>
								<td className="muted">{KIND_LABEL[r.kind]}</td>
								<td>
									<Status status={r.status} />
								</td>
								<td className="muted">{whenText(r.last, today)}</td>
								<td className="cr-num muted">
									{r.files || r.messages ? (
										<>
											{r.files || '—'} · <span aria-label={`${r.messages} messages`}>💬 {r.messages}</span>
										</>
									) : (
										'—'
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{asking && <AskDialog onClose={() => setAsking(false)} onSaved={(row) => (setAsking(false), setOpenId(row.id))} />}
		</section>
	);
}

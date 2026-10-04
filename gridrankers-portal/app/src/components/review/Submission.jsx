import { useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { canComment, canEditSubmission, commentsOf } from '../../lib/comments.js';
import { FILE_ACCEPT, MAX_ATTACH, MAX_FILE_BYTES, fileBadge, fileSize, linksOf, openFile } from '../../lib/files.js';
import { dateTime } from '../../lib/format.js';
import { REVIEW_TXT } from '../../lib/tasks.js';
import Avatar from '../Avatar.jsx';
import { submission } from '../meeting/useTaskActions.js';

// One file: badge, name, size and Open / Download.
export function FileRow({ file, onRemove }) {
	const { api, toast } = usePortal();
	const badge = fileBadge(file);
	const open = (download) => openFile(api, file, download).catch((err) => toast(err.message));
	const viewable = /^(image\/|application\/pdf)/.test(file.mime || '');
	return (
		<div className="sf-row">
			<span className={'sf-badge ' + badge.tone}>{badge.label}</span>
			<span className="sf-row-name">
				<b>{file.name}</b>
				<small>
					{fileSize(file.size)} ·{' '}
					{viewable && (
						<>
							<button type="button" className="linkbtn" onClick={() => open(false)}>
								View
							</button>{' '}
							·{' '}
						</>
					)}
					<button type="button" className="linkbtn" onClick={() => open(true)} aria-label={`Download ${file.name}`}>
						Download
					</button>
				</small>
			</span>
			{onRemove && (
				<button type="button" className="sf-x" aria-label={`Remove ${file.name}`} onClick={onRemove}>
					×
				</button>
			)}
		</div>
	);
}

// Comments on a submission (SPEC.md 6.6, design SF-B): everyone on the task, the reviewer, Team
// Leaders and the Super Admin; a comment can carry files.
function Comments({ kind, row, task }) {
	const { api, data, dispatch, me, toast } = usePortal();
	const [body, setBody] = useState('');
	const [files, setFiles] = useState([]);
	const [busy, setBusy] = useState(false);
	const picker = useRef(null);
	const list = commentsOf(data, kind, row.id);
	const may = canComment(me, task, row);

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
			const row2 = await api.post('comments', { kind, id: row.id, body: body.trim(), files: files.map((f) => f.id) });
			dispatch({ type: 'upsert', table: 'comments', row: row2 });
			setBody('');
			setFiles([]);
		} catch (err) {
			toast(err.message);
		} finally {
			setBusy(false);
		}
	};

	const remove = async (c) => {
		try {
			dispatch({ type: 'upsert', table: 'comments', row: await api.del(`comments/${c.id}`) });
		} catch (err) {
			toast(err.message);
		}
	};

	return (
		<div className="sb-comments">
			<b className="sb-ch">
				Comments <span className="muted">{list.length}</span>
			</b>
			{list.map((c) => {
				const who = data.members[c.created_by];
				return (
					<div key={c.id} className="sb-c">
						<Avatar person={who} small />
						<div className="sb-bubble">
							<b>{who ? who.name : 'Someone'}</b> <span className="muted">{dateTime(c.created_at)}</span>
							{c.deleted_at ? (
								<p className="muted">
									<i>Comment deleted</i>
								</p>
							) : (
								<>
									{c.body && <p>{c.body}</p>}
									{(c.files || []).map((f) => (
										<FileRow key={f.id} file={f} />
									))}
								</>
							)}
						</div>
						{!c.deleted_at && (c.created_by === me.id || me.role === 'admin') && (
							<button type="button" className="sf-x" aria-label="Delete comment" title="Delete comment" onClick={() => remove(c)}>
								×
							</button>
						)}
					</div>
				);
			})}
			{may && (
				<form className="sb-new" onSubmit={send}>
					{files.map((f) => (
						<FileRow key={f.id} file={f} onRemove={() => setFiles(files.filter((x) => x.id !== f.id))} />
					))}
					<div className="sb-new-row">
						<input type="text" value={body} maxLength={2000} placeholder="Write a comment…" aria-label="Write a comment" onChange={(e) => setBody(e.target.value)} />
						<button type="button" className="btn small" aria-label="Attach files to the comment" title="Attach files" onClick={() => picker.current && picker.current.click()}>
							📎
						</button>
						<input
							ref={picker}
							type="file"
							multiple
							hidden
							accept={FILE_ACCEPT}
							onChange={(e) => {
								attach(e.target.files);
								e.target.value = '';
							}}
						/>
						<button type="submit" className="btn small primary" disabled={busy || (!body.trim() && !files.length)}>
							Send
						</button>
					</div>
				</form>
			)}
		</div>
	);
}

// The Submission in task Details (SPEC.md 6.6, design SF-B): what was done, links, files, the
// comment for the reviewer, the review state, ✎ Edit submission and Comments.
export default function Submission({ kind, row, task, title }) {
	const { api, data, dispatch, me, toast, askCompletion } = usePortal();
	const members = data.members;
	const name = (id) => (members[id] ? members[id].name : 'someone');
	const completion = row && row.completion;
	const review = row && row.review;
	if (!row || (!review && !completion)) return <p className="muted">Not completed yet.</p>;

	const edit = async () => {
		const sub = await askCompletion(title, { edit: true, initial: completion });
		if (!sub) return;
		try {
			if (kind === 'item') {
				dispatch({ type: 'upsert', table: 'meeting_tasks', row: await api.patch(`meeting-tasks/${row.id}/submission`, submission(sub)) });
			} else {
				const res = await api.patch('records/submission', { taskId: row.task_id, periodKey: row.period_key, ...submission(sub) });
				dispatch({ type: 'upsert', table: 'records', row: res.record });
			}
			toast('Submission saved');
		} catch (err) {
			toast(err.message);
		}
	};

	const links = linksOf(completion);
	return (
		<div className="sb">
			{completion && (
				<div className="sb-head">
					<Avatar person={members[completion.by]} small />
					<span>
						<b>{name(completion.by)}</b> <span className="muted">· {dateTime(completion.at)}</span>
						{completion.edited_at && <i className="muted"> · edited {dateTime(completion.edited_at)}</i>}
					</span>
					{canEditSubmission(me, completion) && (
						<button type="button" className="btn small sb-edit" onClick={edit}>
							✎ Edit submission
						</button>
					)}
				</div>
			)}
			{completion && <p className="sb-note">{completion.note}</p>}
			{links.length > 0 && (
				<div className="sb-links">
					{links
						.filter((l) => /^https?:\/\//.test(l))
						.map((l) => (
							<a key={l} className="sb-link" href={l} target="_blank" rel="noopener noreferrer">
								↗ {l.replace(/^https?:\/\//, '')}
							</a>
						))}
				</div>
			)}
			{completion && (completion.files || []).length > 0 && (
				<div className="sb-files">
					{completion.files.map((f) => (
						<FileRow key={f.id} file={f} />
					))}
				</div>
			)}
			{completion && completion.comment && (
				<p className="sb-comment">
					<span className="muted">Comment for the reviewer:</span> {completion.comment}
				</p>
			)}
			{review && (
				<div className={'dt-rv rv-' + review.state}>
					<span className="rv-tag">{review.auto && review.state === 'accepted' ? 'Completed · no review' : REVIEW_TXT[review.state]}</span>{' '}
					<span className="muted">
						{review.state === 'pending'
							? `${review.reviewer ? 'waiting for ' + name(review.reviewer) : 'submitted by ' + name(review.submittedBy)} · ${dateTime(review.submittedAt)}`
							: `by ${name(review.by)} · ${dateTime(review.at || review.submittedAt)}`}
					</span>
					{review.note && review.state !== 'pending' && <p>“{review.note}”</p>}
				</div>
			)}
			{completion && <Comments kind={kind} row={row} task={task} />}
		</div>
	);
}

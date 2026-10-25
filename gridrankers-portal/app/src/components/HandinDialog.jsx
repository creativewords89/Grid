import { useRef, useState } from 'react';
import { usePortal } from '../context.js';
import { FILE_ACCEPT, MAX_FILE_BYTES } from '../lib/files.js';
import { MAX_HANDIN, cleanLink, handinOf, linkName } from '../lib/steps.js';
import Modal from './Modal.jsx';
import { KIND_ICON } from './StepsEditor.jsx';
import { FileRow } from './review/Submission.jsx';

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';
const has = (got) => !!got && ((got.files || []).length > 0 || (got.links || []).length > 0);

// One item of the checklist: what is in (files and links, × to remove), then a drop area and
// Paste a link while there's room.
function Slot({ item, got, onChange }) {
	const { api, toast } = usePortal();
	const [busy, setBusy] = useState(0);
	const [over, setOver] = useState(false);
	const [link, setLink] = useState('');
	const [bad, setBad] = useState('');
	const [more, setMore] = useState(false);
	const picker = useRef(null);
	const files = (got && got.files) || [];
	const links = (got && got.links) || [];
	const room = files.length + links.length < MAX_HANDIN;
	const image = item.kind === 'image';
	const put = (patch) => onChange({ files, links, ...patch });

	const add = async (chosen) => {
		let list = files;
		for (const file of Array.from(chosen || [])) {
			if (list.length + links.length >= MAX_HANDIN) break;
			if (image && !/^image\//.test(file.type)) {
				toast(`“${item.label}” takes images only.`);
				continue;
			}
			if (file.size > MAX_FILE_BYTES) {
				toast(`“${file.name}” is larger than 10 MB.`);
				continue;
			}
			setBusy((n) => n + 1);
			try {
				list = [...list, await api.upload('files', file)];
				put({ files: list });
			} catch (err) {
				toast(err.message);
			} finally {
				setBusy((n) => n - 1);
			}
		}
	};
	const paste = () => {
		const url = cleanLink(link);
		if (!url) return setBad('Paste a link that starts with https://');
		setBad('');
		setLink('');
		put({ links: [...links, { url, name: linkName(url) }] });
	};

	const done = has(got);
	return (
		<section className={'hi-slot' + (done ? ' ok' : '')} aria-label={item.label}>
			<div className="hi-slot-h">
				<span className="hi-tick" aria-hidden="true">
					{done ? '✓' : ''}
				</span>
				<b>{item.label}</b>
				<span className={'hi-tag' + (item.required ? ' req' : '')}>{item.required ? 'Required' : 'Optional'}</span>
			</div>
			{(files.length > 0 || links.length > 0) && (
				<div className="hi-got">
					{files.map((f) => (
						<FileRow key={f.id} file={f} onRemove={() => put({ files: files.filter((x) => x.id !== f.id) })} />
					))}
					{links.map((l, i) => (
						<div key={l.url + i} className="sf-row">
							<span className="sf-badge lnk">🔗</span>
							<span className="sf-row-name">
								<b>{l.name || linkName(l.url)}</b>
								<small>
									<a href={l.url} target="_blank" rel="noopener noreferrer">
										{l.url}
									</a>
								</small>
							</span>
							<button type="button" className="sf-x" aria-label={`Remove ${l.name || l.url}`} onClick={() => put({ links: links.filter((_, k) => k !== i) })}>
								×
							</button>
						</div>
					))}
				</div>
			)}
			{room && has(got) && !more && (
				<button type="button" className="linkbtn hi-more" onClick={() => setMore(true)}>
					+ Add another file or link
				</button>
			)}
			{room && (!has(got) || more) && (
				<div className={'hi-add-row' + (item.kind === 'link' ? ' link-first' : '')}>
					<div
						className={'hi-drop' + (over ? ' over' : '')}
						onDragOver={(e) => {
							e.preventDefault();
							setOver(true);
						}}
						onDragLeave={() => setOver(false)}
						onDrop={(e) => {
							e.preventDefault();
							setOver(false);
							add(e.dataTransfer.files);
						}}
					>
						{busy > 0 ? (
							'Uploading…'
						) : (
							<>
								{image ? 'Drop images or ' : 'Drop a file or '}
								<button type="button" className="linkbtn" onClick={() => picker.current && picker.current.click()}>
									browse
								</button>
							</>
						)}
						<input
							ref={picker}
							type="file"
							multiple
							hidden
							aria-label={`Upload for ${item.label}`}
							accept={image ? IMAGE_ACCEPT : FILE_ACCEPT}
							onChange={(e) => {
								add(e.target.files);
								e.target.value = '';
							}}
						/>
					</div>
					<span className="hi-link">
						<span aria-hidden="true">🔗</span>
						<input
							type="url"
							value={link}
							placeholder="Paste a link"
							aria-label={`Link for ${item.label}`}
							onChange={(e) => setLink(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									paste();
								}
							}}
						/>
						{link.trim() && (
							<button type="button" className="linkbtn" onClick={paste}>
								Add
							</button>
						)}
					</span>
				</div>
			)}
			{bad && (
				<p className="err" role="alert">
					{bad}
				</p>
			)}
		</section>
	);
}

// Hand in "{step}" (design SH-2B): one slot per item on the step's checklist, ticked as it fills,
// "2 of 3 · 1 required left", and Finish turns on when every required item is in. Opened when the
// step is completed (`finish`), or from the step to hand in or replace something on its own.
export default function HandinDialog({ ask, onCancel, onSubmit }) {
	const step = ask && ask.step;
	const [value, setValue] = useState(() => ({ ...((ask && ask.value) || {}) }));
	if (!step) return null;
	const items = handinOf(step);
	const got = items.filter((it) => has(value[it.id])).length;
	const left = items.filter((it) => it.required && !has(value[it.id])).length;
	return (
		<Modal open onClose={onCancel} labelledBy="grpHandinTitle" className="hi-dlg">
			<div className="hi-box">
				<div className="hi-top">
					<h2 id="grpHandinTitle">Hand in “{step.name}”</h2>
					<span className={'hi-count' + (left ? '' : ' ok')}>
						{got} of {items.length}
						{left ? ` · ${left} required left` : ''}
					</span>
					<button type="button" className="sf-x" aria-label="Close" onClick={onCancel}>
						×
					</button>
				</div>
				<span className="hi-bar" aria-hidden="true">
					<i style={{ width: `${items.length ? Math.round((got / items.length) * 100) : 0}%` }} />
				</span>
				{items.map((it) => (
					<Slot key={it.id} item={it} got={value[it.id]} onChange={(v) => setValue((all) => ({ ...all, [it.id]: v }))} />
				))}
				<div className="hi-foot">
					<span className="muted">{ask.finish ? 'Finish turns on when every required item is in.' : 'Saved with the step; the next person sees it in Details.'}</span>
					<button type="button" className="btn" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn primary" disabled={ask.finish && left > 0} onClick={() => onSubmit(Object.fromEntries(items.map((it) => [it.id, value[it.id] || { files: [], links: [] }])))}>
						{ask.finish ? `Finish ${step.name}` : 'Save hand-in'}
					</button>
				</div>
			</div>
		</Modal>
	);
}

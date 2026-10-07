import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { LINK_LABEL, isWebUrl, linkKind, sectionsOf } from '../../lib/plan.js';
import { cycleRange } from '../../lib/cycles.js';
import { short } from '../../lib/format.js';
import { profileLocked } from '../../lib/people.js';
import { openCount, openSummary, takePendingRequest } from '../../lib/requests.js';
import ClientRequests from './ClientRequests.jsx';

const TAB_KEY = 'grp:details-tab';

const ICON = { sheet: '▦', doc: '≣', drive: '▲', other: '↗' };
const newId = () => 'n' + Math.random().toString(36).slice(2, 10);

// Text of a section: lines starting with "-", "•" or "*" show as a bullet list (SPEC.md 6.12).
function Text({ text, className }) {
	const lines = String(text || '')
		.split(/\n/)
		.map((l) => l.trim())
		.filter(Boolean);
	if (!lines.length) return null;
	if (lines.every((l) => /^[-•*]\s*/.test(l))) {
		return (
			<ul className={'pdx-list ' + (className || '')}>
				{lines.map((l, i) => (
					<li key={i}>{l.replace(/^[-•*]\s*/, '')}</li>
				))}
			</ul>
		);
	}
	return <p className={'pdx-text ' + (className || '')}>{text}</p>;
}

// Sections every project shows, filled in or not (design PD-F).
const STANDARD = [
	['Goals', 'What this project should achieve, e.g. Top 3 for “locksmith Riverview”.'],
	['Notes for the team', 'Rules and reminders — one per line starting with “-” makes a list.'],
];

const TYPE_LABEL = { sheet: 'Google Sheet', doc: 'Google Doc', drive: 'Drive folder', other: 'Link' };
const initials = (name) =>
	String(name || '')
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((w) => w[0].toUpperCase())
		.join('');

// A link chip: opens in a new tab (edit mode: × removes it, drag to reorder). `wide`: the larger
// chip of the header card, with its type under the name (design PD-F).
function Chip({ link, onRemove, drag, wide }) {
	const body = wide ? (
		<>
			<span className={'pdx-ibox k-' + link.kind} aria-hidden="true">
				{ICON[link.kind] || ICON.other}
			</span>
			<span className="pdx-wname">
				<b>{link.title}</b>
				<small>{link.kind === 'other' ? hostOf(link.url) : TYPE_LABEL[link.kind]}</small>
			</span>
			<span className="pdx-go" aria-hidden="true">
				↗
			</span>
		</>
	) : (
		<>
			<span className={'pdx-ico k-' + link.kind} aria-hidden="true">
				{ICON[link.kind] || ICON.other}
			</span>
			{link.title}
		</>
	);
	if (onRemove) {
		return (
			<span className="pdx-chip editing" draggable {...drag}>
				{body}
				<button type="button" className="pdx-x" aria-label={`Remove ${link.title}`} onClick={onRemove}>
					×
				</button>
			</span>
		);
	}
	return (
		<a className={'pdx-chip' + (wide ? ' wide' : '')} href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
			{body}
		</a>
	);
}

// + Add link: paste the address (the kind is detected), give it a name.
function AddLink({ onAdd, onClose }) {
	const [url, setUrl] = useState('');
	const [title, setTitle] = useState('');
	const [error, setError] = useState('');
	const [busy, setBusy] = useState(false);
	const ref = useRef(null);
	useEffect(() => {
		const close = (e) => (e.type === 'keydown' ? e.key === 'Escape' && onClose() : ref.current && !ref.current.contains(e.target) && onClose());
		document.addEventListener('mousedown', close);
		document.addEventListener('keydown', close);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('keydown', close);
		};
	}, [onClose]);
	const kind = isWebUrl(url) ? linkKind(url) : '';
	const submit = async (e) => {
		e.preventDefault();
		if (!isWebUrl(url)) return setError('Paste a link starting with https://');
		setBusy(true);
		try {
			await onAdd({ id: newId(), url: url.trim(), title: title.trim(), kind });
			onClose();
		} catch (err) {
			setError(err.message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form className="pdx-pop" ref={ref} onSubmit={submit} noValidate>
			<b>Add a link</b>
			<input type="url" placeholder="Paste the link (Sheet, Drive, Doc…)" aria-label="Link address" value={url} onChange={(e) => (setUrl(e.target.value), setError(''))} autoFocus />
			{kind && <span className="pdx-kind">✓ {LINK_LABEL[kind]}</span>}
			<input type="text" placeholder="Name, e.g. Keyword research" aria-label="Link name" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />
			{error && (
				<span className="err" role="alert">
					{error}
				</span>
			)}
			<span className="pdx-pop-acts">
				<button type="button" className="btn small" onClick={onClose}>
					Cancel
				</button>
				<button type="submit" className="btn small primary" disabled={busy}>
					Add
				</button>
			</span>
		</form>
	);
}

// One section: title, text and link chips; Edit turns it into a form.
function Section({ section, can, editing, onEdit, onSave, onCancel, onRemove, onQuickAdd, hero }) {
	const [draft, setDraft] = useState(section);
	const [adding, setAdding] = useState(false);
	const [dragFrom, setDragFrom] = useState(-1);
	const [busy, setBusy] = useState(false);
	useEffect(() => setDraft(section), [section, editing]);

	// The first section is the project's header card (design PD-F): mark, title, project · status ·
	// cycle, then the text and the links as larger chips.
	if (!editing && hero) {
		return (
			<section className="dcard pdx-hero" aria-label={section.title}>
				<div className="pdx-head">
					<h2 className="pdx-label">{section.title}</h2>
					{can && (
						<button type="button" className="linkbtn" onClick={onEdit} aria-label={`Edit ${section.title}`}>
							Edit
						</button>
					)}
				</div>
				<Text text={section.text} />
				{(section.links.length > 0 || can) && (
					<div className="pdx-links">
						<div className="pdx-head">
							<h3 className="pdx-label">
								Links <span className="muted">{section.links.length}</span>
							</h3>
							{can && (
								<span className="pdx-addwrap">
									<button type="button" className="linkbtn" onClick={() => setAdding(true)}>
										+ Add link
									</button>
									{adding && <AddLink onAdd={onQuickAdd} onClose={() => setAdding(false)} />}
								</span>
							)}
						</div>
						{section.links.length > 0 ? (
							<div className="pdx-tiles">
								{section.links.map((l) => (
									<Chip key={l.id} link={l} wide />
								))}
							</div>
						) : (
							<p className="muted pdx-hint">Sheets, Drive folders and docs the team needs — + Add link.</p>
						)}
					</div>
				)}
			</section>
		);
	}

	if (!editing) {
		return (
			<section className="dcard pdx-card" aria-label={section.title}>
				<div className="pdx-head">
					<h3>{section.title}</h3>
					{can && (
						<button type="button" className="btn small" onClick={onEdit} aria-label={`Edit ${section.title}`}>
							Edit
						</button>
					)}
				</div>
				<Text text={section.text} />
				{(section.links.length > 0 || can) && (
					<div className="pdx-chips">
						{section.links.map((l) => (
							<Chip key={l.id} link={l} />
						))}
						{can && (
							<span className="pdx-addwrap">
								<button type="button" className="pdx-chip add" onClick={() => setAdding(true)}>
									+ Add link
								</button>
								{adding && <AddLink onAdd={onQuickAdd} onClose={() => setAdding(false)} />}
							</span>
						)}
					</div>
				)}
			</section>
		);
	}

	const links = draft.links;
	const move = (from, to) => {
		if (from < 0 || from === to) return;
		const next = [...links];
		next.splice(to, 0, next.splice(from, 1)[0]);
		setDraft({ ...draft, links: next });
	};
	const save = async () => {
		setBusy(true);
		try {
			await onSave(draft);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="dcard pdx-card editing" aria-label={`Editing ${draft.title || 'section'}`}>
			<div className="pdx-head">
				<input className="pdx-title" type="text" aria-label="Section title" placeholder="Title, e.g. About" value={draft.title} maxLength={80} onChange={(e) => setDraft({ ...draft, title: e.target.value })} autoFocus />
				<span className="pdx-acts">
					{onRemove && (
						<button type="button" className="linkbtn danger" onClick={onRemove}>
							Remove section
						</button>
					)}
					<button type="button" className="btn small" onClick={onCancel}>
						Cancel
					</button>
					<button type="button" className="btn small primary" disabled={busy || !draft.title.trim()} onClick={save}>
						Save
					</button>
				</span>
			</div>
			<textarea className="pdx-area" rows={4} aria-label="Description" placeholder="A few lines about the project…" value={draft.text} maxLength={5000} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
			<div className="pdx-chips">
				{links.map((l, i) => (
					<Chip
						key={l.id}
						link={l}
						onRemove={() => setDraft({ ...draft, links: links.filter((x) => x.id !== l.id) })}
						drag={{ onDragStart: () => setDragFrom(i), onDragOver: (e) => e.preventDefault(), onDrop: () => (move(dragFrom, i), setDragFrom(-1)) }}
					/>
				))}
				<span className="pdx-addwrap">
					<button type="button" className="pdx-chip add" onClick={() => setAdding(true)}>
						+ Add link
					</button>
					{adding && <AddLink onAdd={async (l) => setDraft((d) => ({ ...d, links: [...d.links, { ...l, title: l.title || hostOf(l.url) }] }))} onClose={() => setAdding(false)} />}
				</span>
			</div>
			<span className="hint">× removes a link · drag chips to reorder · links open in a new tab</span>
		</section>
	);
}

const hostOf = (url) => {
	try {
		return new URL(url).hostname;
	} catch (e) {
		return url;
	}
};

// Details → Overview (SPEC.md 6.12, design DP-F): About with its links as tiles, then Goals, Notes
// for the team and any other sections side by side, and a line pointing to open client requests.
// Everyone edits and reads: Team Members, Team Leaders and the Super Admin; the server refuses
// edits while a profile is incomplete.
function Overview({ onRequests }) {
	const { api, data, project, dispatch, toast, confirm, me, today } = usePortal();
	const p = data.projects[project];
	const can = !profileLocked(data.members[me.id] || me, me);
	const sections = sectionsOf(p);
	const [editing, setEditing] = useState('');

	if (!p) return null;
	const save = async (next, done) => {
		try {
			const row = await api.put(`projects/${p.id}/details`, { sections: next });
			dispatch({ type: 'upsert', table: 'projects', row });
			if (done) toast(done);
			setEditing('');
		} catch (err) {
			toast(err.message);
			throw err;
		}
	};
	const replace = (id, s) => sections.map((x) => (x.id === id ? s : x));
	const summary = openSummary(data, p.id, today);
	const blank = { id: 'new', title: sections.length ? '' : 'About', text: '', links: [] };

	return (
		<div className="pdx">
			{sections.length === 0 && editing !== 'new' && (
				<section className="dcard pdx-empty">
					<b>No details yet</b>
					<span className="muted">{can ? 'Add a description and the links the team needs — sheets, Drive folders, docs.' : 'Finish your profile to add the description and links.'}</span>
					{can && (
						<button type="button" className="btn primary" onClick={() => setEditing('new')}>
							+ Add a section
						</button>
					)}
				</section>
			)}
			{(() => {
				const card = (s, i) => (
					<Section
						key={s.id}
						section={s}
						hero={i === 0}
						can={can}
						editing={editing === s.id}
						onEdit={() => setEditing(s.id)}
						onCancel={() => setEditing('')}
						onSave={(d) => save(replace(s.id, d), 'Saved')}
						onQuickAdd={(l) => save(replace(s.id, { ...s, links: [...s.links, l] }), 'Link added')}
						onRemove={async () => {
							if (await confirm({ title: `Remove “${s.title}”?`, message: 'Its text and links are removed for everyone.', ok: 'Remove', danger: true })) {
								await save(
									sections.filter((x) => x.id !== s.id),
									'Section removed',
								).catch(() => {});
							}
						}}
					/>
				);
				const isStd = (s, i) => i > 0 && STANDARD.some(([t]) => t.toLowerCase() === s.title.trim().toLowerCase());
				// Header card, then Goals and Notes for the team in that order (filled in or not), then the rest.
				const standard = STANDARD.map(([title, hint]) => {
					const k = sections.findIndex((s, i) => i > 0 && s.title.trim().toLowerCase() === title.toLowerCase());
					if (k > 0) return card(sections[k], k);
					if (editing === 'std:' + title) {
						return <Section key={title} section={{ id: 'std', title, text: '', links: [] }} can editing onCancel={() => setEditing('')} onSave={(d) => save([...(sections.length ? sections : [{ id: '', title: 'About', text: '', links: [] }]), { ...d, id: '' }], 'Saved')} />;
					}
					// Empty: invites a Team Leader to fill it in.
					return (
						<section key={title} className="dcard pdx-card pdx-ph" aria-label={title}>
							<div className="pdx-head">
								<h3>{title}</h3>
								{can && (
									<button type="button" className="btn small" onClick={() => setEditing('std:' + title)} aria-label={`Edit ${title}`}>
										Edit
									</button>
								)}
							</div>
							<p className="muted pdx-hint">{can ? hint : 'Nothing here yet.'}</p>
						</section>
					);
				});
				return (
					<>
						{sections.slice(0, 1).map((s) => card(s, 0))}
						<div className="pdx-grid">
							{standard}
							{sections.map((s, i) => (i === 0 || isStd(s, i) ? null : card(s, i)))}
						</div>
					</>
				);
			})()}
			{editing === 'new' && <Section section={blank} can editing onCancel={() => setEditing('')} onSave={(d) => save([...sections, { ...d, id: '' }], 'Section added')} />}
			{can && sections.length > 0 && editing !== 'new' && (
				<button type="button" className="pdx-addsec" onClick={() => setEditing('new')}>
					+ Add a section
				</button>
			)}
			{summary && (
				<div className="dcard pdx-open">
					<span className="cr-dot s-needed" aria-hidden="true" />
					<span>
						<b>
							{summary.count} open client request{summary.count === 1 ? '' : 's'}
						</b>
						{summary.text && <span className="muted"> · {summary.text}</span>}
					</span>
					<button type="button" className="linkbtn" onClick={onRequests}>
						Open Client requests →
					</button>
				</div>
			)}
		</div>
	);
}

// Project → Details (SPEC.md 6.12, 6.15): the project's name, status and cycle, then two sub-tabs —
// Overview and Client requests (with the number still open).
export default function ProjectDetails() {
	const { data, project, today } = usePortal();
	const p = data.projects[project];
	const [tab, setTab] = useState(() => {
		try {
			return window.sessionStorage.getItem(TAB_KEY) === 'requests' ? 'requests' : 'overview';
		} catch (e) {
			return 'overview';
		}
	});
	const [openId, setOpenId] = useState(() => takePendingRequest());
	const show = (t) => {
		setTab(t);
		try {
			window.sessionStorage.setItem(TAB_KEY, t);
		} catch (e) {
			/* the tab isn't remembered */
		}
	};
	useEffect(() => {
		if (openId) show('requests');
		const on = () => {
			const id = takePendingRequest();
			if (id) {
				setOpenId(id);
				show('requests');
			}
		};
		window.addEventListener('grp:open-request', on);
		return () => window.removeEventListener('grp:open-request', on);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);
	// Another project: back to its list.
	useEffect(() => setOpenId((id) => (id && data.client_requests[id] && data.client_requests[id].project_id === project ? id : '')), [project]); // eslint-disable-line react-hooks/exhaustive-deps

	if (!p) return null;
	const cycle = cycleRange(p, 0, today);
	const meta = [p.state.charAt(0).toUpperCase() + p.state.slice(1), cycle ? `Cycle ${short(cycle.start)} – ${short(cycle.end)}` : ''].filter(Boolean).join(' · ');
	const open = openCount(data, p.id);
	return (
		<div className="pdx-page">
			<div className="pdx-proj">
				<span className="pdx-mark" aria-hidden="true">
					{initials(p.name)}
				</span>
				<div>
					<h2>{p.name}</h2>
					<span className="muted">{meta}</span>
				</div>
			</div>
			<div className="pdx-tabs" role="tablist" aria-label="Details">
				<button type="button" role="tab" aria-selected={tab === 'overview'} onClick={() => show('overview')}>
					Overview
				</button>
				<button type="button" role="tab" aria-selected={tab === 'requests'} onClick={() => (show('requests'), setOpenId(''))}>
					Client requests
					{open > 0 && (
						<span className="pdx-count" aria-label={`${open} open`}>
							{open}
						</span>
					)}
				</button>
			</div>
			{tab === 'overview' ? <Overview onRequests={() => show('requests')} /> : <ClientRequests openId={openId} setOpenId={setOpenId} />}
		</div>
	);
}

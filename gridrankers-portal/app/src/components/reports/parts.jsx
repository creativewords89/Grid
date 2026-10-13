import { usePortal } from '../../context.js';
import { openFile } from '../../lib/files.js';
import { fmtMinutes, projectName } from '../../lib/reports.js';
import { colorOf } from '../Sidebar.jsx';

// A file on an entry: 📎 name — opens it; × removes it while editing.
export function FileChip({ file, onRemove }) {
	const { api, toast } = usePortal();
	return (
		<span className="dr-fchip">
			<button type="button" className="dr-fchip-b" title={`Open ${file.name}`} onClick={() => openFile(api, file, !/^(image\/|application\/pdf)/.test(file.mime || '')).catch((err) => toast(err.message))}>
				📎 {file.name}
			</button>
			{onRemove && (
				<button type="button" className="dr-fchip-x" aria-label={`Remove ${file.name}`} onClick={onRemove}>
					×
				</button>
			)}
		</span>
	);
}

// A link on an entry: 🔗 name — opens in a new tab; × removes it while editing.
export function LinkChip({ link, onRemove }) {
	return (
		<span className="dr-fchip link">
			<a className="dr-fchip-b" href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>
				🔗 {link.name || link.url}
			</a>
			{onRemove && (
				<button type="button" className="dr-fchip-x" aria-label={`Remove ${link.name || link.url}`} onClick={onRemove}>
					×
				</button>
			)}
		</span>
	);
}

// The project of an entry as a small tag.
export function ProjectTag({ project }) {
	const { data } = usePortal();
	const name = projectName(project, data.projects);
	if (!name) return null;
	const dot = project === 'office' ? '#5B6B80' : project === 'other' ? '#9AA6B4' : colorOf(project);
	return (
		<span className="dr-ptag">
			<i style={{ background: dot }} aria-hidden="true" />
			{name}
		</span>
	);
}

// One entry as a quiet row (design DR-A): title and time spent, one line of details, project, files
// and links. `onOpen` makes the row editable (click to edit).
export function EntryRow({ entry, onOpen }) {
	const chips = (
		<span className="dr-chipsrow">
			<ProjectTag project={entry.project} />
			{(entry.files || []).map((f) => (
				<FileChip key={f.id} file={f} />
			))}
			{(entry.links || []).map((l, i) => (
				<LinkChip key={l.url + i} link={l} />
			))}
		</span>
	);
	return (
		<li className="dr-row">
			<div className="dr-row-top">
				{onOpen ? (
					<button type="button" className="dr-row-t" onClick={() => onOpen(entry)} title="Edit">
						{entry.title}
					</button>
				) : (
					<b className="dr-row-t">{entry.title}</b>
				)}
				<b className="dr-row-m">{fmtMinutes(entry.minutes)}</b>
			</div>
			{entry.details && <p className="dr-row-d">{entry.details}</p>}
			{chips}
		</li>
	);
}

// Blocking and tomorrow's plan, read only.
export function Notes({ report }) {
	if (!report || (!report.blocking && !report.tomorrow)) return null;
	return (
		<div className="dr-notes">
			{report.blocking && (
				<div>
					<span>Blocking</span>
					<span className="dr-block">{report.blocking}</span>
				</div>
			)}
			{report.tomorrow && (
				<div>
					<span>Tomorrow</span>
					<span>{report.tomorrow}</span>
				</div>
			)}
		</div>
	);
}

import { useRef, useState } from 'react';
import { usePortal } from '../context.js';
import { FILE_ACCEPT, MAX_ATTACH, MAX_FILE_BYTES } from '../lib/files.js';
import { FileRow } from './review/Submission.jsx';

// Attachments in the task dialogs (SPEC.md 6.17): 📎 Attach files (or drop them here) — the brief,
// screenshots, the client's documents. Same types and limits as submissions (6.6); each file is
// uploaded at once and saved with the task.
export default function AttachField({ value, onChange, disabled }) {
	const { api, toast } = usePortal();
	const [busy, setBusy] = useState(0);
	const [over, setOver] = useState(false);
	const picker = useRef(null);
	const files = value || [];

	const add = async (chosen) => {
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
				onChange(list);
			} catch (err) {
				toast(err.message);
			} finally {
				setBusy((n) => n - 1);
			}
		}
	};

	return (
		<div
			className={'att-field' + (over ? ' over' : '')}
			onDragOver={(e) => {
				if (disabled) return;
				e.preventDefault();
				setOver(true);
			}}
			onDragLeave={() => setOver(false)}
			onDrop={(e) => {
				if (disabled) return;
				e.preventDefault();
				setOver(false);
				add(e.dataTransfer.files);
			}}
		>
			<span className="pk-label">
				Attachments <small>optional — the brief, screenshots, the client’s files</small>
			</span>
			{files.map((f) => (
				<FileRow key={f.id} file={f} onRemove={disabled ? undefined : () => onChange(files.filter((x) => x.id !== f.id))} />
			))}
			{!disabled && (
				<div className="att-add">
					<button type="button" className="btn small" onClick={() => picker.current && picker.current.click()} disabled={busy > 0}>
						📎 Attach files
					</button>
					<span className="muted">{busy > 0 ? 'Uploading…' : 'or drop them here · PDF, images, Word, Excel, CSV, text · 10 MB each, up to 10'}</span>
					<input
						ref={picker}
						type="file"
						multiple
						hidden
						aria-label="Task attachments"
						accept={FILE_ACCEPT}
						onChange={(e) => {
							add(e.target.files);
							e.target.value = '';
						}}
					/>
				</div>
			)}
		</div>
	);
}

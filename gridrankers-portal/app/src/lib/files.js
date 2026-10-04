// Files on submissions and comments (SPEC.md 6.6). Same limits as GRP_Files on the server.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACH = 10;
export const FILE_ACCEPT = '.pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv,.txt';

export function fileSize(bytes) {
	const b = +bytes || 0;
	if (b < 1024) return `${b} B`;
	if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
	return `${(b / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

// The coloured badge before a file name: its extension, tinted by kind.
export function fileBadge(file) {
	const ext = (String(file && file.name).match(/\.([a-z0-9]+)$/i) || [])[1] || '';
	const mime = String((file && file.mime) || '');
	const tone = mime === 'application/pdf' ? 'pdf' : mime.startsWith('image/') ? 'img' : /sheet|excel|csv/.test(mime) ? 'xls' : /word/.test(mime) ? 'doc' : 'txt';
	return { label: (ext || 'file').toUpperCase().slice(0, 4), tone };
}

// Opens (images, PDF) or downloads a stored file through the API.
export async function openFile(api, file, download = false) {
	const blob = await api.blob(`files/${file.id}`, download ? { download: 1 } : undefined);
	const url = URL.createObjectURL(blob);
	const viewable = !download && /^(image\/|application\/pdf)/.test(file.mime || '');
	if (viewable) {
		window.open(url, '_blank', 'noopener');
	} else {
		const a = document.createElement('a');
		a.href = url;
		a.download = file.name || 'file';
		document.body.appendChild(a);
		a.click();
		a.remove();
	}
	setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// The links of a submission (older ones have a single `link`).
export const linksOf = (completion) => (completion ? (Array.isArray(completion.links) ? completion.links : completion.link ? [completion.link] : []) : []);

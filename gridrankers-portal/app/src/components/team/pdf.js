import { short } from '../../lib/format.js';
import { assignedFor, fmtDur, inRange, missedWork, perfRange, perfStats } from '../../lib/perf.js';
import { rowsOf } from '../../lib/store.js';

// jsPDF has no Unicode fonts by default: keep Latin-1 and common punctuation.
const pdfText = (v) =>
	String(v ?? '')
		.replace(/→/g, '->')
		.replace(/[✓✔]/g, '')
		.replace(/[^\x09\x0A\x0D\x20-\x7E -ÿ–—‘’“”•…·]/g, '')
		.trim();

// Member PDF report for the selected period (SPEC.md 6.7; reference downloadReport).
// jsPDF + AutoTable are bundled with the plugin and loaded on first use.
export async function downloadReport(data, pid, perf, today) {
	const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
	const p = data.members[pid];
	const r = perfRange(perf.mode, perf.anchor);
	const done = rowsOf(data, 'activity')
		.filter((x) => inRange(x, r) && x.member_id === pid)
		.sort((a, b) => String(a.at).localeCompare(String(b.at)));
	const missed = missedWork(data, pid, r, today);
	const open = assignedFor(data, pid, today);
	const proj = (x) => (x.project_id && data.projects[x.project_id] ? data.projects[x.project_id].name : 'Other work');
	const byProj = new Map();
	done.forEach((x) => byProj.set(proj(x), (byProj.get(proj(x)) || 0) + (x.kind === 'manual' ? 1 : x.qty || 1)));
	const st = perfStats(done);

	const doc = new jsPDF({ unit: 'pt', format: 'a4' });
	const W = doc.internal.pageSize.getWidth();
	const M = 40;
	const INK = [21, 35, 58];
	const MUTED = [96, 110, 130];
	const ACC = [39, 83, 201];
	const LINE = [226, 231, 238];
	const COL = { done: [31, 138, 76], missed: [200, 40, 40], open: [190, 120, 10], acc: ACC };

	doc.setFillColor(...ACC);
	doc.rect(0, 0, W, 96, 'F');
	doc.setTextColor(255, 255, 255);
	doc.setFont('helvetica', 'bold');
	doc.setFontSize(22);
	doc.text('Work report', M, 44);
	doc.setFont('helvetica', 'normal');
	doc.setFontSize(11);
	doc.text(pdfText(`${p.name}${p.title ? ' — ' + p.title : ''}`), M, 66);
	doc.text(pdfText(r.label), W - M, 44, { align: 'right' });
	doc.setFontSize(9);
	doc.text(pdfText(`Generated ${new Date().toLocaleString()}`), W - M, 66, { align: 'right' });

	let y = 120;
	const bw = (W - M * 2 - 3 * 12) / 4;
	[
		['Completed', st.total, COL.done],
		['Missed', missed.length, COL.missed],
		['Still open', open.length, COL.open],
		['Projects', byProj.size, COL.acc],
	].forEach(([lab, n, c], k) => {
		const x = M + k * (bw + 12);
		doc.setFillColor(246, 248, 251);
		doc.setDrawColor(...LINE);
		doc.roundedRect(x, y, bw, 58, 6, 6, 'FD');
		doc.setFillColor(...c);
		doc.rect(x, y + 8, 3, 42, 'F');
		doc.setTextColor(...INK);
		doc.setFont('helvetica', 'bold');
		doc.setFontSize(20);
		doc.text(String(n), x + 14, y + 30);
		doc.setTextColor(...MUTED);
		doc.setFont('helvetica', 'normal');
		doc.setFontSize(9);
		doc.text(lab.toUpperCase(), x + 14, y + 46);
	});
	y += 84;

	const heading = (title, color, note) => {
		if (y > 740) {
			doc.addPage();
			y = 50;
		}
		doc.setFillColor(...color);
		doc.rect(M, y - 11, 4, 16, 'F');
		doc.setTextColor(...INK);
		doc.setFont('helvetica', 'bold');
		doc.setFontSize(13);
		doc.text(title, M + 12, y + 2);
		if (note) {
			doc.setTextColor(...MUTED);
			doc.setFont('helvetica', 'normal');
			doc.setFontSize(9);
			doc.text(pdfText(note), W - M, y + 2, { align: 'right' });
		}
		y += 12;
	};
	const table = (head, body, color, widths) => {
		autoTable(doc, {
			startY: y,
			head: [head],
			body: body.map((rw) => rw.map(pdfText)),
			margin: { left: M, right: M },
			theme: 'grid',
			styles: { font: 'helvetica', fontSize: 9, cellPadding: 6, textColor: INK, lineColor: LINE, lineWidth: 0.6, valign: 'middle', overflow: 'linebreak' },
			headStyles: { fillColor: color, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
			alternateRowStyles: { fillColor: [248, 250, 252] },
			columnStyles: widths || {},
		});
		y = doc.lastAutoTable.finalY + 26;
	};
	const empty = (t) => {
		doc.setTextColor(...MUTED);
		doc.setFont('helvetica', 'italic');
		doc.setFontSize(10);
		doc.text(t, M + 12, y + 8);
		y += 34;
	};

	heading('Completed', COL.done, `${st.total} tasks · ${st.done} from task lists · ${st.manual} logged`);
	if (done.length) {
		table(
			['Date', 'Project', 'Task', 'Type', 'Qty'],
			done.map((x) => [short(x.date), proj(x), x.title + (x.detail ? `  (${x.detail})` : '') + (x.minutes ? `  · ${fmtDur(x.minutes)}` : ''), x.kind === 'manual' ? 'Logged work' : x.source === 'board' ? 'Meeting task' : 'Recurring task', x.kind === 'manual' ? 1 : x.qty || 1]),
			COL.done,
			{ 0: { cellWidth: 52 }, 1: { cellWidth: 110 }, 3: { cellWidth: 78 }, 4: { cellWidth: 34, halign: 'center' } }
		);
	} else empty('Nothing completed in this period.');

	if (byProj.size) {
		heading('By project', COL.acc);
		table(['Project', 'Tasks completed'], [...byProj].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]), COL.acc, { 1: { cellWidth: 110, halign: 'center' } });
	}

	heading('Missed', COL.missed, 'Recurring work that ended without the share being done');
	if (missed.length) {
		table(['Ended', 'Project', 'Task', 'Period', 'Done'], missed.map((x) => [short(x.end), data.projects[x.project_id]?.name || '', x.title, x.label, `${x.got} of ${x.need}`]), COL.missed, {
			0: { cellWidth: 52 },
			1: { cellWidth: 110 },
			4: { cellWidth: 50, halign: 'center' },
		});
	} else empty('Nothing missed in this period.');

	heading('Still open', COL.open, 'Assigned and not finished yet');
	if (open.length) {
		table(['Project', 'Task', 'Status', 'Due'], open.map((x) => [data.projects[x.project_id]?.name || '', x.title + (x.priority === 'urgent' ? '  [URGENT]' : ''), x.sub, x.when || '—']), COL.open, {
			0: { cellWidth: 110 },
			2: { cellWidth: 120 },
			3: { cellWidth: 100 },
		});
	} else empty('Nothing outstanding.');

	const pages = doc.internal.getNumberOfPages();
	for (let k = 1; k <= pages; k++) {
		doc.setPage(k);
		const h = doc.internal.pageSize.getHeight();
		doc.setDrawColor(...LINE);
		doc.line(M, h - 34, W - M, h - 34);
		doc.setTextColor(...MUTED);
		doc.setFont('helvetica', 'normal');
		doc.setFontSize(8);
		doc.text(pdfText(`GridRankers · ${p.name} · ${r.label}`), M, h - 20);
		doc.text(`Page ${k} of ${pages}`, W - M, h - 20, { align: 'right' });
	}

	doc.save(`report-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${r.start}.pdf`);
}

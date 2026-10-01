import { usePortal } from '../../context.js';
import { isManager } from '../../lib/roles.js';

// Status, progress and delete for meeting tasks. Each write stores the row the server
// returns; errors become toasts with the server's message.
export default function useTaskActions() {
	const { api, dispatch, toast, confirm, me, askCompletion } = usePortal();
	const save = (row) => dispatch({ type: 'upsert', table: 'meeting_tasks', row });

	const setStatus = async (task, to) => {
		if (task.status === to) return;
		let body = { status: to };
		if (to === 'done' && !isManager(me)) {
			const note = await askCompletion(task.title);
			if (!note) return;
			body = { ...body, ...note };
		}
		try {
			const row = await api.post(`meeting-tasks/${task.id}/status`, body);
			save(row);
			toast(to === 'done' ? (row.review && row.review.state === 'pending' ? 'Sent for review' : 'Marked fixed') : to === 'doing' ? 'In progress' : 'Back to To fix');
		} catch (err) {
			toast(err.message);
		}
	};

	const tick = async (task, memberId, delta) => {
		try {
			const row = await api.post(`meeting-tasks/${task.id}/progress`, { memberId: memberId || '', delta });
			save(row);
			const total = Object.values(row.progress || {}).reduce((a, b) => a + b, 0);
			if (row.status === 'done' && task.status !== 'done') toast(row.review && row.review.state === 'pending' ? 'All done — sent for review' : 'All done — marked fixed');
			else toast(`${total}/${row.target} done`);
		} catch (err) {
			toast(err.message);
		}
	};

	const remove = async (task) => {
		const ok = await confirm({ title: 'Delete this task?', message: `“${task.title}” is removed from the board. You can undo this for 30 days.`, ok: 'Delete', danger: true });
		if (!ok) return;
		try {
			const res = await api.del(`meeting-tasks/${task.id}`);
			dispatch({ type: 'remove', table: 'meeting_tasks', id: task.id });
			// Show it in Recently deleted now, not at the next sync.
			if (res.trash) dispatch({ type: 'upsert', table: 'trash', row: res.trash });
			toast('Task deleted', {
				action: {
					label: 'Undo',
					run: async () => {
						try {
							save(await api.post(`trash/${res.trash_id}/restore`));
							dispatch({ type: 'remove', table: 'trash', id: res.trash_id });
							toast(`“${task.title}” restored`);
						} catch (err) {
							toast(err.message);
						}
					},
				},
			});
		} catch (err) {
			toast(err.message);
		}
	};

	return { setStatus, tick, remove };
}

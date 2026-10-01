import { usePortal } from '../../context.js';
import { isManager } from '../../lib/roles.js';

// Ticks and status moves on a recurring task's period record, plus delete with Undo.
export default function useRecordActions() {
	const { api, dispatch, toast, confirm, me, askCompletion } = usePortal();

	const store = (res) => {
		if (res.record) dispatch({ type: 'upsert', table: 'records', row: res.record });
		else dispatch({ type: 'remove', table: 'records', id: res.id });
		return res.record;
	};

	const tick = async (task, periodKey, delta, who = {}) => {
		try {
			const rec = store(await api.post('records/tick', { taskId: task.id, periodKey, delta, ...who }));
			const n = Math.max(1, task.target || 1);
			toast(rec && rec.status === 'done' ? (rec.review && rec.review.state === 'pending' ? 'All done — sent for review' : 'All done') : `${rec ? rec.count : 0}/${n} done`);
		} catch (err) {
			toast(err.message);
		}
	};

	const setStatus = async (task, periodKey, to) => {
		let body = { taskId: task.id, periodKey, status: to };
		if (to === 'done' && !isManager(me)) {
			const note = await askCompletion(task.title);
			if (!note) return;
			body = { ...body, ...note };
		}
		try {
			const rec = store(await api.post('records/status', body));
			toast(to === 'done' ? (rec && rec.review && rec.review.state === 'pending' ? 'Sent for review' : 'Completed') : to === 'skipped' ? 'Skipped' : to === 'doing' ? 'In progress' : 'Reset to not started');
		} catch (err) {
			toast(err.message);
		}
	};

	const remove = async (task) => {
		const ok = await confirm({ title: 'Delete this monthly task?', message: `“${task.title}” is removed from every cycle. You can undo this for 30 days.`, ok: 'Delete', danger: true });
		if (!ok) return;
		try {
			const res = await api.del(`monthly-tasks/${task.id}`);
			dispatch({ type: 'remove', table: 'monthly_tasks', id: task.id });
			toast('Task deleted', {
				action: {
					label: 'Undo',
					run: async () => {
						try {
							dispatch({ type: 'upsert', table: 'monthly_tasks', row: await api.post(`trash/${res.trash_id}/restore`) });
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

	return { tick, setStatus, remove };
}

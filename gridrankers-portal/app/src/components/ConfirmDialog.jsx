import { useCallback, useEffect, useRef, useState } from 'react';

// Promise-based confirm / prompt in a native <dialog> (showModal keeps focus inside).
// confirm({title, message, ok, danger, input, placeholder, value}) resolves to
// true / the typed text, or null when cancelled.
export function useConfirm() {
	const [req, setReq] = useState(null);
	const [text, setText] = useState('');
	const ref = useRef(null);

	const confirm = useCallback(
		(options) =>
			new Promise((resolve) => {
				setText(options.value || '');
				setReq({ ...options, resolve });
			}),
		[]
	);

	useEffect(() => {
		const dlg = ref.current;
		if (req && dlg && !dlg.open) {
			if (dlg.showModal) dlg.showModal();
			else dlg.setAttribute('open', '');
		}
	}, [req]);

	const close = (value) => {
		const r = req;
		setReq(null);
		if (ref.current && ref.current.open) {
			if (ref.current.close) ref.current.close();
			else ref.current.removeAttribute('open');
		}
		if (r) r.resolve(value);
	};

	const view = (
		<dialog ref={ref} onCancel={(e) => (e.preventDefault(), close(null))} aria-labelledby="grpAskTitle">
			{req && (
				<form
					method="dialog"
					onSubmit={(e) => {
						e.preventDefault();
						close(req.input ? text.trim() : true);
					}}
				>
					<h2 id="grpAskTitle">{req.title}</h2>
					{req.message && <p className="hint">{req.message}</p>}
					{req.input && (
						<label>
							{req.input}
							<input autoFocus value={text} placeholder={req.placeholder || ''} onChange={(e) => setText(e.target.value)} maxLength={1000} />
						</label>
					)}
					<div className="dlg-acts">
						<button type="button" className="btn" onClick={() => close(null)}>
							Cancel
						</button>
						<button type="submit" className={'btn ' + (req.danger ? 'danger-btn' : 'primary')} autoFocus={!req.input}>
							{req.ok || 'OK'}
						</button>
					</div>
				</form>
			)}
		</dialog>
	);

	return [confirm, view];
}

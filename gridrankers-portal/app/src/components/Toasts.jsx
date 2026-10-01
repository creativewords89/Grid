import { useCallback, useEffect, useRef, useState } from 'react';

// One toast at a time, like the reference. With an action (e.g. "Undo") it stays 9 s.
export function useToasts() {
	const [toast, setToast] = useState(null);
	const timer = useRef(null);

	const show = useCallback((message, options = {}) => {
		clearTimeout(timer.current);
		const id = Date.now() + Math.random();
		setToast({ id, message, action: options.action || null });
		timer.current = setTimeout(() => setToast((t) => (t && t.id === id ? null : t)), options.duration || (options.action ? 9000 : 3500));
	}, []);

	useEffect(() => () => clearTimeout(timer.current), []);

	const view = (
		<div className={'toast' + (toast ? ' show' : '')} role="status" aria-live="polite">
			{toast && (
				<>
					<span>{toast.message}</span>
					{toast.action && (
						<button
							type="button"
							className="toast-act"
							onClick={() => {
								setToast(null);
								toast.action.run();
							}}
						>
							{toast.action.label}
						</button>
					)}
				</>
			)}
		</div>
	);

	return [show, view];
}

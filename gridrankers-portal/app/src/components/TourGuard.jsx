import { useRef } from 'react';

// Controls that change something. During a tour (SPEC.md 7.0) they are greyed out and a click on
// one is stopped here with a short note; every write the app still sends is refused by the
// tour's api, and the server checks each one anyway.
export const LOCKED = ['.add-card', '.seg button', '.icon-del', '.qstep button', '.kp-box', '.acts .btn:not(.primary-soft)', 'button[type="submit"]', 'input[type="checkbox"]', 'input[type="radio"]', '[data-write]'].join(',');

export default function TourGuard({ on, name, toast, children }) {
	const last = useRef(0);
	if (!on) return children;
	const stop = (e) => {
		const el = e.target instanceof Element ? e.target.closest(LOCKED) : null;
		if (!el) return;
		e.preventDefault();
		e.stopPropagation();
		// One note per second, however many clicks.
		if (Date.now() - last.current > 1000) toast(`View only — you’re touring ${name}’s portal.`);
		last.current = Date.now();
	};
	return (
		<div className="tour-guard" onClickCapture={stop} onChangeCapture={stop}>
			{children}
		</div>
	);
}

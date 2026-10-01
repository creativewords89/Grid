import { useEffect, useRef } from 'react';

// A native <dialog> opened with showModal() while `open` is true (focus stays inside;
// Escape calls onClose).
export default function Modal({ open, onClose, className, labelledBy, children }) {
	const ref = useRef(null);

	useEffect(() => {
		const dlg = ref.current;
		if (!dlg) return;
		if (open && !dlg.open) {
			if (dlg.showModal) dlg.showModal();
			else dlg.setAttribute('open', '');
		} else if (!open && dlg.open) {
			if (dlg.close) dlg.close();
			else dlg.removeAttribute('open');
		}
	}, [open]);

	return (
		<dialog
			ref={ref}
			className={className}
			aria-labelledby={labelledBy}
			onCancel={(e) => {
				e.preventDefault();
				onClose();
			}}
		>
			{open ? children : null}
		</dialog>
	);
}

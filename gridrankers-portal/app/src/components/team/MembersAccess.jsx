import { useEffect, useRef, useState } from 'react';
import { usePortal } from '../../context.js';
import { ROLE, canOpenPage, canTour, isAdmin } from '../../lib/roles.js';
import Avatar from '../Avatar.jsx';
import Modal from '../Modal.jsx';

const FILTERS = [
	['all', 'All'],
	['lead', 'Team Leaders'],
	['member', 'Team Members'],
	['nosign', 'No sign-in'],
];
const noSignIn = (p) => p.role !== 'admin' && !p.has_code;
const SIGN = (p) => (p.role === 'admin' ? ['wp', 'WordPress login'] : p.has_code ? ['ok', 'Can sign in'] : ['no', 'No sign-in yet']);

// Change a Team Leader / Team Member's role (Super Admin; the server checks).
function RoleDialog({ person, onClose }) {
	const { api, dispatch, toast } = usePortal();
	const [role, setRole] = useState(person.role);
	const save = async (e) => {
		e.preventDefault();
		try {
			const row = await api.patch(`members/${person.id}`, { role });
			dispatch({ type: 'upsert', table: 'members', row });
			toast(`${person.name} is now a ${ROLE[role]}`);
			onClose();
		} catch (err) {
			toast(err.message);
		}
	};
	return (
		<Modal open onClose={onClose} labelledBy="grpRole">
			<form onSubmit={save}>
				<h2 id="grpRole">Change {person.name}’s role</h2>
				<label>
					Role
					<select value={role} onChange={(e) => setRole(e.target.value)}>
						<option value="lead">Team Leader</option>
						<option value="member">Team Member</option>
					</select>
				</label>
				<p className="hint">Changing a role signs them out everywhere; they sign in again with their code.</p>
				<div className="dlg-acts">
					<button type="button" className="btn" onClick={onClose}>
						Cancel
					</button>
					<button type="submit" className="btn primary" disabled={role === person.role}>
						Save role
					</button>
				</div>
			</form>
		</Modal>
	);
}

// The ⋯ menu of a row.
function RowMenu({ person, items }) {
	const [open, setOpen] = useState(false);
	const ref = useRef(null);
	useEffect(() => {
		if (!open) return undefined;
		const close = (e) => (e.type === 'keydown' ? e.key === 'Escape' : !ref.current || !ref.current.contains(e.target)) && setOpen(false);
		document.addEventListener('mousedown', close);
		document.addEventListener('keydown', close);
		return () => {
			document.removeEventListener('mousedown', close);
			document.removeEventListener('keydown', close);
		};
	}, [open]);
	return (
		<div className="ma-more" ref={ref}>
			<button type="button" className="ma-dots" aria-label={`More for ${person.name}`} aria-expanded={open} onClick={() => setOpen(!open)}>
				⋯
			</button>
			{open && (
				<div className="ma-menu" role="menu">
					{items.map(([label, run, danger]) => (
						<button key={label} type="button" role="menuitem" className={danger ? 'danger' : undefined} onClick={() => (setOpen(false), run())}>
							{label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// My page → Team → Members & access (SPEC.md 7.6, design A): search, role filters, one row per
// person, every action in a ⋯ menu.
export default function MembersAccess({ people, openCount, urgentCount, onPerson, onAdd, onSetCode, onRemove }) {
	const { me, setTeamPerson, setViewAs } = usePortal();
	const [q, setQ] = useState('');
	const [f, setF] = useState('all');
	const [roleFor, setRoleFor] = useState(null);
	const counts = { all: people.length, lead: people.filter((p) => p.role === 'lead').length, member: people.filter((p) => p.role === 'member').length, nosign: people.filter(noSignIn).length };
	const query = q.trim().toLowerCase();
	const shown = people.filter((p) => (f === 'all' || (f === 'nosign' ? noSignIn(p) : p.role === f)) && (!query || [p.name, p.title, p.email, p.phone].join(' ').toLowerCase().includes(query)));
	const admins = people.filter((p) => p.role === 'admin').length;
	// A tour of their portal, view only (SPEC.md 7.0), or else their page — when you may see either.
	const tour = (p) => setViewAs(p.id);
	const open = (p) => (canTour(me, p) ? tour(p) : canOpenPage(me, p) ? onPerson(p.id) : null);

	return (
		<section className="dcard ma-card" aria-labelledby="maTitle">
			<div className="ma-head">
				<div className="ma-title">
					<h3 id="maTitle">Members &amp; access</h3>
					<span className="muted">
						{people.length} people · {admins} Super Admin · {counts.lead} Team Leader{counts.lead === 1 ? '' : 's'} · {counts.member} Team Member{counts.member === 1 ? '' : 's'}
					</span>
				</div>
				<label className="ld-search ma-search">
					<span aria-hidden="true">⌕</span>
					<input type="search" placeholder="Search people" aria-label="Search people" value={q} onChange={(e) => setQ(e.target.value)} />
				</label>
				<button type="button" className="btn primary" onClick={onAdd}>
					+ Add member
				</button>
			</div>
			<div className="ra-chips ma-filters" role="group" aria-label="Filter people">
				{FILTERS.map(([k, l]) => (
					<button key={k} type="button" className="ra-chip" aria-pressed={f === k} onClick={() => setF(k)}>
						{l} {counts[k]}
					</button>
				))}
			</div>
			<div className="ma-table" role="table" aria-label="Members">
				<div className="ma-row ma-th" role="row">
					<span role="columnheader">Person</span>
					<span role="columnheader">Role</span>
					<span role="columnheader">Contact</span>
					<span role="columnheader">Open tasks</span>
					<span role="columnheader">Sign-in</span>
					<span />
				</div>
				{shown.map((p) => {
					const [sk, st] = SIGN(p);
					const items = [
						...(canTour(me, p) ? [['Tour their portal', () => tour(p)]] : []),
						...(canOpenPage(me, p) ? [['Open their page', () => onPerson(p.id)]] : []),
						// What each role may do (section 3): codes for Team Members (leaders) or anyone but the
						// Super Admin (Super Admin); roles and removing: Super Admin only.
						...(p.id !== me.id && p.role !== 'admin' && (isAdmin(me) || p.role === 'member') ? [['Set sign-in code', () => onSetCode(p)]] : []),
						...(isAdmin(me) && p.id !== me.id && p.role !== 'admin' ? [['Change role', () => setRoleFor(p)], ['Remove from team', () => onRemove(p), true]] : []),
					];
					return (
						<div key={p.id} className="ma-row" role="row">
							<span className="ma-who" role="cell">
								{/* Photo and name start a tour (view only) or, for someone you can't tour, open their page. */}
								{canTour(me, p) || canOpenPage(me, p) ? (
									<button type="button" className="ma-open" aria-label={`Open ${p.name}`} title={canTour(me, p) ? 'Tour their portal (view only)' : 'Open their page'} onClick={() => open(p)}>
										<Avatar person={p} />
										<span>
											<b>{p.name}</b>
											<small>{p.title || ROLE[p.role]}</small>
										</span>
									</button>
								) : (
									<span className="ma-open ma-static">
										<Avatar person={p} />
										<span>
											<b>{p.name}</b>
											<small>{p.title || ROLE[p.role]}</small>
										</span>
									</span>
								)}
							</span>
							<span role="cell">
								<span className={'ma-role r-' + p.role}>{ROLE[p.role]}</span>
							</span>
							<span className="ma-contact" role="cell">
								{p.email || p.phone ? (
									<>
										{p.email && <span title={p.email}>{p.email}</span>}
										{p.phone && <small>{p.phone}</small>}
									</>
								) : (
									<small>No contact yet</small>
								)}
							</span>
							<span role="cell">
								<b>{openCount[p.id] || 0}</b>
								{urgentCount[p.id] ? <span className="ma-urg">{urgentCount[p.id]} urgent</span> : null}
							</span>
							<span className={'ma-sign s-' + sk} role="cell">
								{st}
							</span>
							<span role="cell" className="ma-end">
								{canTour(me, p) && (
									<button type="button" className="btn small ma-tour" aria-label={`Tour ${p.name}’s portal`} title="See the portal as they see it — view only" onClick={() => tour(p)}>
										<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
											<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
											<circle cx="12" cy="12" r="3" />
										</svg>
										Tour
									</button>
								)}
								{items.length > 0 && <RowMenu person={p} items={items} />}
							</span>
						</div>
					);
				})}
				{shown.length === 0 && <p className="ld-empty">Nobody matches.</p>}
			</div>
			<p className="hint ma-foot">The Super Admin signs in with WordPress. Team Leaders and Members sign in with a code set here; a new code signs them out everywhere.</p>
			{roleFor && <RoleDialog person={roleFor} onClose={() => setRoleFor(null)} />}
		</section>
	);
}

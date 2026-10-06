// Display helpers for roles. Permissions are enforced by the server; the UI only hides
// what a person can't do.

export const ROLE = { admin: 'Super Admin', lead: 'Team Leader', member: 'Team Member' };

export const isManager = (me) => !!me && (me.role === 'admin' || me.role === 'lead');
export const isAdmin = (me) => !!me && me.role === 'admin';

// Touring someone's portal, view only (SPEC.md 7.0): the Super Admin tours anyone else; a Team
// Leader tours Team Members only; Team Members tour nobody. The server checks it too
// (GET /members/{id}/tour).
export const canTour = (viewer, target) => !!viewer && !!target && viewer.id !== target.id && +target.active !== 0 && (isAdmin(viewer) || (viewer.role === 'lead' && target.role === 'member'));

// Opening someone's page: your own; the Super Admin anyone's; a Team Leader Team Members' only.
export const canOpenPage = (viewer, target) => !!viewer && !!target && (viewer.id === target.id || isAdmin(viewer) || (viewer.role === 'lead' && target.role === 'member'));

export const initials = (name) =>
	(name || '')
		.trim()
		.split(/\s+/)
		.map((w) => w[0])
		.join('')
		.slice(0, 2)
		.toUpperCase();

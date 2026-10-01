// Display helpers for roles. Permissions are enforced by the server; the UI only hides
// what a person can't do.

export const ROLE = { admin: 'Super Admin', lead: 'Team Leader', member: 'Team Member' };

export const isManager = (me) => !!me && (me.role === 'admin' || me.role === 'lead');
export const isAdmin = (me) => !!me && me.role === 'admin';

export const initials = (name) =>
	(name || '')
		.trim()
		.split(/\s+/)
		.map((w) => w[0])
		.join('')
		.slice(0, 2)
		.toUpperCase();

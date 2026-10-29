// The two sites (SPEC.md 6.22): this site's part and the other site's address, from the page config
// (`site: {part, mainUrl, trackerUrl}`).

export const isTracker = (config) => !!config && !!config.site && config.site.part === 'tracker';

// A main portal linked to a tracker portal: time is tracked there.
export const trackerElsewhere = (config) => (!!config && !!config.site && config.site.part === 'main' && config.site.trackerUrl) || '';

export const hostOf = (url) => String(url || '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');

// Where an entry is on the main portal (tracker portal): null when it is there.
export function mainMark(entry, mainHost) {
	if (!entry) return null;
	if (entry.main_error) return { kind: 'refused', text: `Not on ${mainHost}: ${entry.main_error}` };
	if (!entry.main_synced_at || entry.updated_at > entry.main_synced_at) return { kind: 'waiting', text: `Not on ${mainHost} yet` };
	return null;
}

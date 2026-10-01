import { initials } from '../lib/roles.js';

export default function Avatar({ person, small, big }) {
	const cls = ['av', small ? 'sm' : '', big ? 'big' : ''].filter(Boolean).join(' ');
	if (!person) {
		return (
			<span className="av none" title="Unassigned">
				?
			</span>
		);
	}
	if (person.photo) {
		return <img className={cls + ' ph'} src={person.photo} alt="" title={person.name} />;
	}
	return (
		<span className={cls} style={{ background: person.color || '#4A5A70' }} title={person.name}>
			{initials(person.name)}
		</span>
	);
}

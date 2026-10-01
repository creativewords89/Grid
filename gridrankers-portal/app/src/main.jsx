import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/bricolage-grotesque/500.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/bricolage-grotesque/800.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import './styles/portal.css';
import './styles/app.css';
import App from './App.jsx';

const el = document.getElementById('grp-portal-root');
if (el) {
	const config = window.GRP_CONFIG || { restRoot: '/wp-json/gr-portal/v1/', nonce: '' };
	createRoot(el).render(
		<StrictMode>
			<App config={config} />
		</StrictMode>
	);
}

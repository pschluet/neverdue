import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createServices } from './services';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App services={createServices()} />
  </StrictMode>,
);

if ('serviceWorker' in navigator && (import.meta.env.PROD || import.meta.env.VITE_MOCK)) {
  navigator.serviceWorker.register('/sw.js').catch(() => undefined);
}

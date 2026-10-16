// Main window entry: the sandboxed page talks to the system only through window.chawo (preload).
import '@chawo/ui/tokens.css';
import '@chawo/ui/base.css';
import './style.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initEvents } from './app/events';

initEvents();
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

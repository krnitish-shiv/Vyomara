import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App.tsx';
import { PipView } from './ui/pip.tsx';
import './ui/styles.css';

// The same bundle renders the main window and the mini controller (#pip).
const isPip = window.location.hash === '#pip';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isPip ? <PipView /> : <App />}
  </React.StrictMode>,
);

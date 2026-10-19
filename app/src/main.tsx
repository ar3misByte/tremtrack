import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '@fontsource/jetbrains-mono/400.css';
import './theme/tokens.css';
import './theme/global.css';
import App from './App';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);

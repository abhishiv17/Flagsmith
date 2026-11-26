import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { ExperimentsProvider } from './experiments';
import './styles/tokens.css';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

createRoot(root).render(
  <StrictMode>
    <ExperimentsProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ExperimentsProvider>
  </StrictMode>,
);

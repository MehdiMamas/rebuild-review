import React, { useEffect, useState } from 'react';
import { url } from './api.js';
import TaskRow from './components/TaskRow.jsx';
import TaskForm from './components/TaskForm.jsx';
import DetailPanel from './components/DetailPanel.jsx';
import SettingsPanel from './components/SettingsPanel.jsx';
import LegacyBoard from './components/LegacyBoard.jsx';

export default function App() {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState(null);
  const [reloads, setReloads] = useState(0);
  const density = new URLSearchParams(window.location.search).get('density');

  useEffect(() => {
    setError(false);
    fetch(url('/api/tasks', { q: query, status }))
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setResult)
      .catch(() => setError(true));
  }, [query, status, reloads]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'c' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
        e.preventDefault();
        document.getElementById('new-task').focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (window.location.pathname === '/legacy') return <LegacyBoard />;

  return (
    <div className={`app ${density === 'compact' ? 'compact' : ''}`}>
      <h1>Tasks</h1>
      <TaskForm onAdded={() => setReloads((n) => n + 1)} />
      <div className="toolbar">
        <input id="search" placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} />
        <select id="status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="done">Done</option>
        </select>
      </div>
      {error && (
        <div className="banner" data-testid="retry-banner">
          Could not load tasks. <button onClick={() => setReloads((n) => n + 1)}>Retry</button>
        </div>
      )}
      <div className="layout">
        <div>
          {result && (
            <p className="count" data-testid="count">
              {result.items.length} results for "{result.q}"
            </p>
          )}
          <div className="list" data-testid="list">
            {result && result.items.map((t) => <TaskRow key={t.id} task={t} onSelect={setSelected} />)}
          </div>
        </div>
        <div>
          {selected && <DetailPanel id={selected} />}
          <SettingsPanel />
        </div>
      </div>
    </div>
  );
}

import React, { useState } from 'react';
import { url } from '../api.js';

export default function TaskForm({ onAdded }) {
  const [title, setTitle] = useState('');
  async function submit(e) {
    e.preventDefault();
    const clean = title.trim();
    if (!clean) return;
    await fetch(url('/api/tasks'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: clean }),
    });
    setTitle('');
    onAdded();
  }
  return (
    <form onSubmit={submit} className="toolbar">
      <input id="new-task" placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button>Add</button>
    </form>
  );
}

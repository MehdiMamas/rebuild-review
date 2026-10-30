import React, { useState } from 'react';
import { url } from '../api.js';

export default function SettingsPanel() {
  const [form, setForm] = useState({ name: 'Sam', email: 'sam@example.com' });
  const [saved, setSaved] = useState(false);
  const Field = ({ name }) => (
    <label>
      {name}{' '}
      <input
        id={`field-${name}`}
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
      />
    </label>
  );
  async function save() {
    await fetch(url('/api/settings'), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    setSaved(true);
  }
  return (
    <div className="settings">
      <h3>Settings</h3>
      <Field name="name" /> <Field name="email" />
      <button id="save-settings" onClick={save}>Save</button>
      {saved && <span data-testid="saved"> Saved</span>}
    </div>
  );
}

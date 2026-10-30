import React from 'react';
import { formatDue } from '../util/date.js';

window.__renders = window.__renders || 0;

export default function TaskRow({ task, onSelect }) {
  window.__renders++;
  return (
    <div className="row" data-testid="row" onClick={() => onSelect(task.id)}>
      {task.title} <small>{task.status} · due {formatDue(task.due)}</small>
    </div>
  );
}

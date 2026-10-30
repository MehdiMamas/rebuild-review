import React, { useEffect, useState } from 'react';
import { url } from '../api.js';

export default function DetailPanel({ id }) {
  const [task, setTask] = useState(null);
  const params = { id };
  useEffect(() => {
    fetch(url(`/api/tasks/${params.id}`))
      .then((r) => r.json())
      .then(setTask);
  }, [params]);
  if (!task) return <div className="detail">Select a task</div>;
  return (
    <div className="detail" data-testid="detail">
      <h3>{task.title}</h3>
      <p>Status: {task.status}</p>
    </div>
  );
}

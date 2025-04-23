import React from 'react';

const WebhookList = ({ webhooks, onToggle }) => {
  if (!webhooks || webhooks.length === 0) return null;

  return (
    <div className="webhook-list">
      <h2>Registered Webhooks</h2>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Callback URL</th>
            <th>Events</th>
            <th>Active</th>
            <th>Created At</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {webhooks.map((w) => (
            <tr key={w.id}>
              <td>{w.id}</td>
              <td>{w.callbackUrl}</td>
              <td>{Array.isArray(w.events) ? w.events.join(', ') : w.events}</td>
              <td>{w.active ? 'Yes' : 'No'}</td>
              <td>{new Date(w.createdAt).toLocaleString()}</td>
              <td>
                <button onClick={() => onToggle(w)}>
                  {w.active ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default WebhookList;

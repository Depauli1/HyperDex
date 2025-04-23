import React, { useState } from 'react';
import WebhookForm from './components/WebhookForm';
import WebhookList from './components/WebhookList';
import { fetchWebhooks, registerWebhook, updateWebhook } from './utils/api';
import './style.css';

const App = () => {
  const [trader, setTrader] = useState('');
  const [webhooks, setWebhooks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleFetch = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await fetchWebhooks(trader);
      setWebhooks(result);
    } catch (err) {
      setError(err.message || 'Failed to fetch webhooks');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (data) => {
    setLoading(true);
    setError(null);
    try {
      await registerWebhook({ trader, ...data });
      handleFetch();
    } catch (err) {
      setError(err.message || 'Failed to register webhook');
    } finally {
      setLoading(false);
    }
  };

  const handleToggle = async (webhook) => {
    setLoading(true);
    setError(null);
    try {
      const updated = await updateWebhook(webhook.id, { active: !webhook.active });
      setWebhooks((prev) => prev.map((w) => (w.id === updated.id ? updated : w)));
    } catch (err) {
      setError(err.message || 'Failed to update webhook');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container">
      <h1>Webhook Management Dashboard</h1>
      <div className="search">
        <input
          type="text"
          placeholder="Trader address"
          value={trader}
          onChange={(e) => setTrader(e.target.value)}
        />
        <button onClick={handleFetch} disabled={!trader || loading}>
          Fetch Webhooks
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <WebhookForm onSubmit={handleRegister} disabled={!trader || loading} />
      <WebhookList webhooks={webhooks} onToggle={handleToggle} />
    </div>
  );
};

export default App;

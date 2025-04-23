import React, { useState } from 'react';

const WebhookForm = ({ onSubmit, disabled }) => {
  const [callbackUrl, setCallbackUrl] = useState('');
  const [events, setEvents] = useState('');
  const [signature, setSignature] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    onSubmit({ callbackUrl, events, signature });
    setCallbackUrl('');
    setEvents('');
    setSignature('');
  };

  return (
    <form className="webhook-form" onSubmit={handleSubmit}>
      <input
        type="text"
        placeholder="Callback URL"
        value={callbackUrl}
        onChange={(e) => setCallbackUrl(e.target.value)}
        disabled={disabled}
      />
      <input
        type="text"
        placeholder="Events (comma-separated)"
        value={events}
        onChange={(e) => setEvents(e.target.value)}
        disabled={disabled}
      />
      <input
        type="text"
        placeholder="Signature"
        value={signature}
        onChange={(e) => setSignature(e.target.value)}
        disabled={disabled}
      />
      <button
        type="submit"
        disabled={
          disabled || !callbackUrl || !events || !signature
        }
      >
        Register Webhook
      </button>
    </form>
  );
};

export default WebhookForm;

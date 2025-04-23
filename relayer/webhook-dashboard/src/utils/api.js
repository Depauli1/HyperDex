import axios from 'axios';

const api = axios.create({ baseURL: '/api' });

export async function fetchWebhooks(trader) {
  const resp = await api.get(`/webhooks/trader/${trader}`);
  return resp.data;
}

export async function registerWebhook(data) {
  const resp = await api.post('/webhooks/register', {
    trader: data.trader,
    callbackUrl: data.callbackUrl,
    events: data.events,
    signature: data.signature
  });
  return resp.data;
}

export async function updateWebhook(id, data) {
  const resp = await api.put(`/webhooks/${id}`, data);
  return resp.data;
}

import React, { useState } from 'react';
import { ethers } from 'ethers';
import { deadlineFromMinutes, encodeInitiateBridge } from '../lib/hyperdex';

/**
 * Bridge form.
 *
 * Builds the `BridgeRequest` the router expects, shows the exact fee it will
 * forward to the adapter, and sends `initiateBridge` from the connected
 * account. The tokens must be approved first; the panel says so rather than
 * failing with a decode error.
 */
export default function BridgePanel({ wallet, account, routerAddress, srcChainId, dstChainId }) {
  const [form, setForm] = useState({
    token: '',
    amount: '',
    fee: '0',
    minutes: 60
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function bridge() {
    setError(null);
    setStatus('Waiting for the wallet…');
    try {
      if (!account) throw new Error('Connect a wallet first');
      if (!ethers.utils.isAddress(form.token)) throw new Error('Token address is not valid');
      if (!ethers.utils.isAddress(routerAddress)) throw new Error('Bridge router is not configured');

      const request = {
        id: 0, // assigned by the router
        srcChainId,
        dstChainId,
        token: form.token,
        amount: ethers.utils.parseUnits(String(form.amount || '0'), 18).toString(),
        user: account,
        deadline: deadlineFromMinutes(form.minutes),
        fee: ethers.utils.parseEther(String(form.fee || '0')).toString()
      };

      const { data, value } = encodeInitiateBridge(request);
      const hash = await wallet.sendTransaction(account, {
        to: routerAddress,
        data,
        value: ethers.utils.hexValue(value)
      });
      setStatus(`Bridging: ${hash}`);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  }

  return (
    <section className="panel" data-testid="bridge-panel">
      <h2>Bridge</h2>
      <p className="hint">
        Approve the token for the router before bridging; the fee is forwarded to the
        destination adapter and refunded only if the transfer fails.
      </p>
      <label>
        Token
        <input
          aria-label="token"
          placeholder="0x…"
          value={form.token}
          onChange={(e) => update('token', e.target.value.trim())}
        />
      </label>
      <label>
        Amount
        <input
          aria-label="bridge amount"
          inputMode="decimal"
          value={form.amount}
          onChange={(e) => update('amount', e.target.value)}
        />
      </label>
      <label>
        Adapter fee (ETH)
        <input
          aria-label="bridge fee"
          inputMode="decimal"
          value={form.fee}
          onChange={(e) => update('fee', e.target.value)}
        />
      </label>
      <label>
        Deadline (minutes)
        <input
          aria-label="bridge deadline"
          type="number"
          min="1"
          value={form.minutes}
          onChange={(e) => update('minutes', e.target.value)}
        />
      </label>

      <button type="button" onClick={bridge} disabled={!account}>
        Bridge to chain {dstChainId}
      </button>

      {status && <p data-testid="bridge-status">{status}</p>}
      {error && <p role="alert" data-testid="bridge-error">{error}</p>}
    </section>
  );
}

import React, { useState } from 'react';
import { ethers } from 'ethers';
import {
  deadlineFromMinutes,
  encodeGaslessSwap,
  gaslessSwapTypedData
} from '../lib/hyperdex';

const RELAYER_URL = process.env.REACT_APP_RELAYER_URL || '';

/**
 * Gasless swap form.
 *
 * The user signs the EIP-712 payload in their wallet and the relayer submits it;
 * the "submit directly" fallback sends the very same struct through
 * `HyperDex.executeGaslessSwap` from the connected account.
 */
export default function SwapPanel({ wallet, account, hyperDexAddress, chainId, nonce = '0' }) {
  const [form, setForm] = useState({
    pool: '',
    zeroForOne: true,
    amountSpecified: '',
    sqrtPriceLimitX96: '4295128740',
    minutes: 20,
    priority: 'medium'
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  function buildStruct() {
    if (!ethers.utils.isAddress(form.pool)) throw new Error('Pool address is not valid');
    if (!account) throw new Error('Connect a wallet first');
    return {
      pool: form.pool,
      trader: account,
      zeroForOne: form.zeroForOne,
      amountSpecified: ethers.utils.parseEther(String(form.amountSpecified || '0')).toString(),
      sqrtPriceLimitX96: form.sqrtPriceLimitX96,
      deadline: deadlineFromMinutes(form.minutes),
      nonce
    };
  }

  async function signAndRelay() {
    setError(null);
    setStatus('Signing…');
    try {
      const struct = buildStruct();
      const signature = await wallet.signTypedData(
        account,
        gaslessSwapTypedData(struct, { chainId, verifyingContract: hyperDexAddress })
      );
      if (!RELAYER_URL) {
        setStatus('Signed. Set REACT_APP_RELAYER_URL to submit through the relayer.');
        return;
      }
      setStatus('Submitting to the relayer…');
      const response = await fetch(`${RELAYER_URL.replace(/\/$/, '')}/api/swap/gasless`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...struct, signature })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'The relayer rejected the swap');
      setStatus(`Submitted: ${body.transactionHash}`);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  }

  async function submitDirectly() {
    setError(null);
    setStatus('Signing…');
    try {
      const struct = buildStruct();
      const signature = await wallet.signTypedData(
        account,
        gaslessSwapTypedData(struct, { chainId, verifyingContract: hyperDexAddress })
      );
      const data = encodeGaslessSwap(struct, signature);
      setStatus('Waiting for the wallet…');
      const hash = await wallet.sendTransaction(account, { to: hyperDexAddress, data });
      setStatus(`Submitted directly: ${hash}`);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  }

  return (
    <section className="panel" data-testid="swap-panel">
      <h2>Swap</h2>
      <label>
        Pool
        <input
          aria-label="pool"
          placeholder="0x…"
          value={form.pool}
          onChange={(e) => update('pool', e.target.value.trim())}
        />
      </label>
      <label>
        Direction
        <select
          aria-label="direction"
          value={form.zeroForOne ? 'zeroForOne' : 'oneForZero'}
          onChange={(e) => update('zeroForOne', e.target.value === 'zeroForOne')}
        >
          <option value="zeroForOne">token0 → token1</option>
          <option value="oneForZero">token1 → token0</option>
        </select>
      </label>
      <label>
        Amount in
        <input
          aria-label="amount"
          inputMode="decimal"
          value={form.amountSpecified}
          onChange={(e) => update('amountSpecified', e.target.value)}
        />
      </label>
      <label>
        Sqrt price limit
        <input
          aria-label="price limit"
          value={form.sqrtPriceLimitX96}
          onChange={(e) => update('sqrtPriceLimitX96', e.target.value.trim())}
        />
      </label>
      <label>
        Deadline (minutes)
        <input
          aria-label="deadline"
          type="number"
          min="1"
          value={form.minutes}
          onChange={(e) => update('minutes', e.target.value)}
        />
      </label>

      <div className="actions">
        <button type="button" onClick={signAndRelay} disabled={!account}>
          Sign &amp; relay (gasless)
        </button>
        <button type="button" onClick={submitDirectly} disabled={!account}>
          Sign &amp; submit directly
        </button>
      </div>

      {status && <p data-testid="swap-status">{status}</p>}
      {error && <p role="alert" data-testid="swap-error">{error}</p>}
    </section>
  );
}

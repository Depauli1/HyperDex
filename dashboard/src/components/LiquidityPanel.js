import React, { useState } from 'react';
import { ethers } from 'ethers';
import { buildMintParams, deadlineFromMinutes, encodeMint } from '../lib/hyperdex';

const FEE_TIERS = [
  { label: '0.05%', value: 500 },
  { label: '0.30%', value: 3000 },
  { label: '1.00%', value: 10000 }
];

/**
 * Provide-liquidity form.
 *
 * Collects a range and two amounts, then calls the canonical Uniswap v3
 * `NonfungiblePositionManager.mint` through the connected wallet. The minimum
 * amounts are derived from the slippage the user accepts, so a hostile price
 * move between signing and mining cannot drain the deposit.
 */
export default function LiquidityPanel({
  wallet,
  account,
  positionManagerAddress,
  defaultToken0 = '',
  defaultToken1 = ''
}) {
  const [form, setForm] = useState({
    token0: defaultToken0,
    token1: defaultToken1,
    fee: 3000,
    tickLower: '-887220',
    tickUpper: '887220',
    amount0: '',
    amount1: '',
    slippageBps: 50,
    minutes: 20
  });
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function addLiquidity() {
    setError(null);
    setStatus('Waiting for the wallet…');
    try {
      if (!account) throw new Error('Connect a wallet first');
      if (!ethers.utils.isAddress(positionManagerAddress)) {
        throw new Error('Position manager is not configured');
      }
      if (!ethers.utils.isAddress(form.token0) || !ethers.utils.isAddress(form.token1)) {
        throw new Error('Both token addresses are required');
      }

      const params = buildMintParams(
        {
          token0: form.token0,
          token1: form.token1,
          fee: Number(form.fee),
          tickLower: Number(form.tickLower),
          tickUpper: Number(form.tickUpper),
          amount0Desired: ethers.utils.parseUnits(String(form.amount0 || '0'), 18).toString(),
          amount1Desired: ethers.utils.parseUnits(String(form.amount1 || '0'), 18).toString(),
          recipient: account,
          deadline: deadlineFromMinutes(form.minutes)
        },
        Number(form.slippageBps)
      );

      const hash = await wallet.sendTransaction(account, {
        to: positionManagerAddress,
        data: encodeMint(params)
      });
      setStatus(`Position submitted: ${hash}`);
    } catch (err) {
      setError(err.message);
      setStatus(null);
    }
  }

  return (
    <section className="panel" data-testid="liquidity-panel">
      <h2>Provide liquidity</h2>
      <label>
        Token A
        <input aria-label="token0" placeholder="0x…" value={form.token0} onChange={(e) => update('token0', e.target.value.trim())} />
      </label>
      <label>
        Token B
        <input aria-label="token1" placeholder="0x…" value={form.token1} onChange={(e) => update('token1', e.target.value.trim())} />
      </label>
      <label>
        Fee tier
        <select aria-label="fee tier" value={form.fee} onChange={(e) => update('fee', e.target.value)}>
          {FEE_TIERS.map((tier) => (
            <option key={tier.value} value={tier.value}>{tier.label}</option>
          ))}
        </select>
      </label>
      <label>
        Lower tick
        <input aria-label="tick lower" value={form.tickLower} onChange={(e) => update('tickLower', e.target.value)} />
      </label>
      <label>
        Upper tick
        <input aria-label="tick upper" value={form.tickUpper} onChange={(e) => update('tickUpper', e.target.value)} />
      </label>
      <label>
        Amount A
        <input aria-label="amount0" inputMode="decimal" value={form.amount0} onChange={(e) => update('amount0', e.target.value)} />
      </label>
      <label>
        Amount B
        <input aria-label="amount1" inputMode="decimal" value={form.amount1} onChange={(e) => update('amount1', e.target.value)} />
      </label>
      <label>
        Slippage (bps)
        <input aria-label="slippage" type="number" min="0" value={form.slippageBps} onChange={(e) => update('slippageBps', e.target.value)} />
      </label>

      <button type="button" onClick={addLiquidity} disabled={!account}>
        Add liquidity
      </button>

      {status && <p data-testid="liquidity-status">{status}</p>}
      {error && <p role="alert" data-testid="liquidity-error">{error}</p>}
    </section>
  );
}

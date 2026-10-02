import React, { useEffect, useState } from 'react';
import { createWalletClient } from '../lib/wallet';

/**
 * Connect/disconnect button plus the active address and chain.
 *
 * The client is created from `window.ethereum`; when no wallet is installed the
 * button explains that instead of failing silently.
 */
export default function WalletConnect({ client, onChange }) {
  const [wallet] = useState(() => client || createWalletClient());
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [error, setError] = useState(null);
  const [available] = useState(() => wallet.isAvailable());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const existing = await wallet.getAccount();
        if (!cancelled && existing) {
          setAddress(existing);
          setChainId(await wallet.getChainId());
        }
      } catch (err) {
        // Nothing to do: the user simply has not connected yet.
      }
    })();

    const offAccounts = wallet.on('accountsChanged', (accounts) => {
      setAddress(accounts && accounts.length > 0 ? accounts[0] : null);
    });
    const offChain = wallet.on('chainChanged', (id) => setChainId(Number(id)));

    return () => {
      cancelled = true;
      offAccounts();
      offChain();
    };
  }, [wallet]);

  useEffect(() => {
    if (onChange) onChange({ address, chainId });
  }, [address, chainId, onChange]);

  async function connect() {
    setError(null);
    try {
      const account = await wallet.connect();
      setAddress(account);
      setChainId(await wallet.getChainId());
    } catch (err) {
      setError(err.message);
    }
  }

  function disconnect() {
    // EIP-1193 has no "disconnect"; forgetting the address is the local effect.
    setAddress(null);
    setChainId(null);
  }

  return (
    <div className="wallet-connect" data-testid="wallet-connect">
      {address ? (
        <>
          <span data-testid="wallet-address">
            {address.slice(0, 6)}…{address.slice(-4)}
          </span>
          {chainId && <span className="wallet-chain">chain {chainId}</span>}
          <button type="button" onClick={disconnect}>Disconnect</button>
        </>
      ) : (
        <button type="button" onClick={connect} disabled={!available}>
          {available ? 'Connect wallet' : 'No wallet detected'}
        </button>
      )}
      {error && <span role="alert" className="wallet-error">{error}</span>}
    </div>
  );
}

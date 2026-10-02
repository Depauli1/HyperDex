import React, { useCallback, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import PriceImpact from './components/PriceImpact';
import Slippage from './components/Slippage';
import Efficiency from './components/Efficiency';
import OraclePrices from './components/OraclePrices';
import WalletConnect from './components/WalletConnect';
import SwapPanel from './components/SwapPanel';
import BridgePanel from './components/BridgePanel';
import LiquidityPanel from './components/LiquidityPanel';
import { createWalletClient } from './lib/wallet';
import './App.css';

const CONFIG = {
  hyperDexAddress: process.env.REACT_APP_HYPERDEX_ADDRESS || '',
  bridgeRouterAddress: process.env.REACT_APP_BRIDGE_ROUTER_ADDRESS || '',
  positionManagerAddress: process.env.REACT_APP_POSITION_MANAGER_ADDRESS || '',
  srcChainId: Number(process.env.REACT_APP_SRC_CHAIN_ID || 11155111),
  dstChainId: Number(process.env.REACT_APP_DST_CHAIN_ID || 10)
};

function App({ walletClient }) {
  const [wallet] = useState(() => walletClient || createWalletClient());
  const [connection, setConnection] = useState({ address: null, chainId: null });
  const onWalletChange = useCallback((next) => setConnection(next), []);

  return (
    <Router>
      <header className="topbar">
        <nav>
          <ul>
            <li><a href="/swap">Swap</a></li>
            <li><a href="/bridge">Bridge</a></li>
            <li><a href="/liquidity">Liquidity</a></li>
            <li><a href="/price-impact">Price Impact</a></li>
            <li><a href="/slippage">Slippage</a></li>
            <li><a href="/efficiency">Efficiency</a></li>
            <li><a href="/oracle-prices">Oracle Prices</a></li>
          </ul>
        </nav>
        <WalletConnect client={wallet} onChange={onWalletChange} />
      </header>

      <main>
        <Routes>
          <Route
            path="/swap"
            element={
              <SwapPanel
                wallet={wallet}
                account={connection.address}
                chainId={connection.chainId || CONFIG.srcChainId}
                hyperDexAddress={CONFIG.hyperDexAddress}
              />
            }
          />
          <Route
            path="/bridge"
            element={
              <BridgePanel
                wallet={wallet}
                account={connection.address}
                routerAddress={CONFIG.bridgeRouterAddress}
                srcChainId={CONFIG.srcChainId}
                dstChainId={CONFIG.dstChainId}
              />
            }
          />
          <Route
            path="/liquidity"
            element={
              <LiquidityPanel
                wallet={wallet}
                account={connection.address}
                positionManagerAddress={CONFIG.positionManagerAddress}
              />
            }
          />
          <Route path="/price-impact" element={<PriceImpact />} />
          <Route path="/slippage" element={<Slippage />} />
          <Route path="/efficiency" element={<Efficiency />} />
          <Route path="/oracle-prices" element={<OraclePrices />} />
          <Route path="/*" element={<Navigate to="/swap" />} />
        </Routes>
      </main>
    </Router>
  );
}

export default App;

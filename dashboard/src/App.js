import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import PriceImpact from './components/PriceImpact';
import Slippage from './components/Slippage';
import Efficiency from './components/Efficiency';
import OraclePrices from './components/OraclePrices';
import './App.css';

function App() {
  return (
    <Router>
      <nav>
        <ul>
          <li><a href="/price-impact">Price Impact</a></li>
          <li><a href="/slippage">Slippage</a></li>
          <li><a href="/efficiency">Efficiency</a></li>
          <li><a href="/oracle-prices">Oracle Prices</a></li>
        </ul>
      </nav>
      <Routes>
        <Route path="/price-impact" element={<PriceImpact />} />
        <Route path="/slippage" element={<Slippage />} />
        <Route path="/efficiency" element={<Efficiency />} />
        <Route path="/oracle-prices" element={<OraclePrices />} />
        <Route path="/*" element={<Navigate to="/price-impact" />} />
      </Routes>
    </Router>
  );
}

export default App;

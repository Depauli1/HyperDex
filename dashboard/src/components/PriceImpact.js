import React, { useEffect, useState } from 'react';
import { VictoryChart, VictoryLine } from 'victory';
import socketIOClient from 'socket.io-client';
import axios from 'axios';
import '../App.css';

const ENDPOINT = process.env.REACT_APP_ANALYTICS_URL;

export default function PriceImpact() {
  const [data, setData] = useState([]);

  useEffect(() => {
    // fetch initial price impact
    axios.get(`${ENDPOINT}/metrics/price-impact`).then((res) => {
      setData([{ x: new Date(), y: res.data.priceImpact || 0 }]);
    });
    // subscribe to live metrics
    const socket = socketIOClient(ENDPOINT);
    socket.on('metrics', (m) => {
      setData((d) => [...d.slice(-20), { x: new Date(), y: m.priceImpact }]);
    });
    return () => socket.disconnect();
  }, []);

  return (
    <div className="chart-wrapper" data-testid="price-impact-chart">
      <VictoryChart>
        <VictoryLine data={data} />
      </VictoryChart>
    </div>
  );
}

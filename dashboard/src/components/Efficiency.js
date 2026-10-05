import React, { useEffect, useState } from 'react';
import { VictoryChart, VictoryLine } from 'victory';
import socketIOClient from 'socket.io-client';
import axios from 'axios';
import '../App.css';

// The analytics service runs on 4000 (see docker-compose.yml); a deployment
// overrides this at build time with REACT_APP_ANALYTICS_URL.
const ENDPOINT = process.env.REACT_APP_ANALYTICS_URL || 'http://localhost:4000';

export default function Efficiency() {
  const [data, setData] = useState([]);

  useEffect(() => {
    axios.get(`${ENDPOINT}/metrics/efficiency`).then((res) => {
      setData([{ x: new Date(), y: res.data.efficiency || 0 }]);
    });
    const socket = socketIOClient(ENDPOINT);
    socket.on('metrics', (m) => {
      setData((d) => [...d.slice(-20), { x: new Date(), y: m.efficiency }]);
    });
    return () => socket.disconnect();
  }, []);

  return (
    <div className="chart-wrapper" data-testid="efficiency-chart">
      <VictoryChart>
        <VictoryLine data={data} />
      </VictoryChart>
    </div>
  );
}

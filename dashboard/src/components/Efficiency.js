import React, { useEffect, useState } from 'react';
import { VictoryChart, VictoryLine } from 'victory';
import socketIOClient from 'socket.io-client';
import axios from 'axios';
import '../App.css';

const ENDPOINT = process.env.REACT_APP_ANALYTICS_URL;

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

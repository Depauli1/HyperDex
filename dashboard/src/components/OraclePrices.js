import React, { useEffect, useState } from 'react';
import { VictoryChart, VictoryLine, VictoryLegend, VictoryAxis } from 'victory';
import socketIOClient from 'socket.io-client';
import axios from 'axios';
import '../App.css';

const ENDPOINT = process.env.REACT_APP_ANALYTICS_URL;

export default function OraclePrices() {
  const [dataMap, setDataMap] = useState({});
  const [feeds, setFeeds] = useState([]);

  useEffect(() => {
    axios.get(`${ENDPOINT}/metrics/oracle-prices`).then(res => {
      const initialMap = {};
      Object.entries(res.data.aggregatorPrices).forEach(([addr, price]) => {
        initialMap[addr] = [{ x: new Date(), y: price }];
      });
      setDataMap(initialMap);
      setFeeds(Object.keys(initialMap));
    });
    const socket = socketIOClient(ENDPOINT);
    socket.on('metrics', m => {
      if (!m.aggregatorPrices) return;
      setDataMap(prev => {
        const newMap = {};
        Object.entries(m.aggregatorPrices).forEach(([addr, price]) => {
          const prevArr = prev[addr] || [];
          newMap[addr] = [...prevArr.slice(-20), { x: new Date(), y: price }];
        });
        return newMap;
      });
      if (feeds.length === 0) {
        setFeeds(Object.keys(m.aggregatorPrices));
      }
    });
    return () => socket.disconnect();
  }, []);

  const colors = ['#8884d8', '#82ca9d', '#ffc658', '#ff7300', '#0088fe'];

  return (
    <div className="chart-wrapper" data-testid="oracle-prices-chart">
      <h2>Oracle Prices</h2>
      <VictoryChart>
        <VictoryLegend
          x={125}
          y={0}
          orientation="horizontal"
          gutter={20}
          data={feeds.map((addr, i) => ({ name: addr.slice(0, 6) + '...' + addr.slice(-4), symbol: { fill: colors[i % colors.length] } }))}
        />
        <VictoryAxis tickFormat={t => `${t.getHours()}:${t.getMinutes()}:${t.getSeconds()}`} />
        {feeds.map((addr, i) => (
          <VictoryLine
            key={addr}
            data={dataMap[addr] || []}
            style={{ data: { stroke: colors[i % colors.length], strokeWidth: 2 } }}
          />
        ))}
      </VictoryChart>
    </div>
  );
}

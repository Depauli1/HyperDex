import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import OraclePrices from './OraclePrices';
import axios from 'axios';
import socketIOClient from 'socket.io-client';

jest.mock('axios');
jest.mock('socket.io-client');

const FEED = '0x694AA1769357215DE4FAC081bf1f309aDC325306';

describe('OraclePrices Component', () => {
  beforeEach(() => {
    const mockSocket = { on: jest.fn(), disconnect: jest.fn() };
    socketIOClient.mockReturnValue(mockSocket);
  });

  it('renders the chart wrapper and calls the metrics API', async () => {
    axios.get.mockResolvedValue({ data: { aggregatorPrices: { [FEED]: 1234.5 } } });

    render(<OraclePrices />);

    await waitFor(() => screen.getByTestId('oracle-prices-chart'));
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/metrics/oracle-prices')
    );
  });

  // The axis asked Victory for tick marks and formatted them as if they were
  // Date objects, which threw during render and blanked the page - the only
  // reason the e2e run could not find this chart. Victory ticks come from the
  // axis domain, so a numeric tick must render too.
  it('renders when the response carries no feed at all', async () => {
    axios.get.mockResolvedValue({ data: {} });

    render(<OraclePrices />);

    await waitFor(() => screen.getByTestId('oracle-prices-chart'));
    expect(screen.getByTestId('oracle-prices-chart')).toBeInTheDocument();
  });

  it('reports the endpoint it actually fetches from', async () => {
    axios.get.mockResolvedValue({ data: { aggregatorPrices: {} } });

    render(<OraclePrices />);

    await waitFor(() => expect(axios.get).toHaveBeenCalled());
    const [url] = axios.get.mock.calls[axios.get.mock.calls.length - 1];
    expect(url.startsWith('undefined/')).toBe(false);
  });
});

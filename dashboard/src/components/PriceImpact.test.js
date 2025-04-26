import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import PriceImpact from './PriceImpact';
import axios from 'axios';
import socketIOClient from 'socket.io-client';

jest.mock('axios');
jest.mock('socket.io-client');

describe('PriceImpact Component', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { priceImpact: 5 } });
    const mockSocket = { on: jest.fn(), disconnect: jest.fn() };
    socketIOClient.mockReturnValue(mockSocket);
  });

  it('renders chart wrapper and calls APIs', async () => {
    render(<PriceImpact />);
    await waitFor(() => screen.getByTestId('price-impact-chart'));
    expect(screen.getByTestId('price-impact-chart')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/metrics/price-impact')
    );
  });
});

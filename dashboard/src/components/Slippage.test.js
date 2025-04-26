import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Slippage from './Slippage';
import axios from 'axios';
import socketIOClient from 'socket.io-client';

jest.mock('axios');
jest.mock('socket.io-client');

describe('Slippage Component', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { slippage: 1.23 } });
    const mockSocket = { on: jest.fn(), disconnect: jest.fn() };
    socketIOClient.mockReturnValue(mockSocket);
  });

  it('renders chart wrapper and calls APIs', async () => {
    render(<Slippage />);
    await waitFor(() => screen.getByTestId('slippage-chart'));
    expect(screen.getByTestId('slippage-chart')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/metrics/slippage')
    );
  });
});

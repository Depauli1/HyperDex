import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import Efficiency from './Efficiency';
import axios from 'axios';
import socketIOClient from 'socket.io-client';

jest.mock('axios');
jest.mock('socket.io-client');

describe('Efficiency Component', () => {
  beforeEach(() => {
    axios.get.mockResolvedValue({ data: { efficiency: 0.42 } });
    const mockSocket = { on: jest.fn(), disconnect: jest.fn() };
    socketIOClient.mockReturnValue(mockSocket);
  });

  it('renders chart wrapper and calls APIs', async () => {
    render(<Efficiency />);
    await waitFor(() => screen.getByTestId('efficiency-chart'));
    expect(screen.getByTestId('efficiency-chart')).toBeInTheDocument();
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/metrics/efficiency')
    );
  });
});

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WalletConnect from './WalletConnect';
import SwapPanel from './SwapPanel';
import BridgePanel from './BridgePanel';
import LiquidityPanel from './LiquidityPanel';
import { createWalletClient, WalletError } from '../lib/wallet';

const POOL = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const TRADER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ROUTER = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';

describe('WalletConnect', () => {
  it('tells the user when no wallet is installed', () => {
    // jsdom has no window.ethereum: this is the real "no provider" path, not a stub.
    const client = createWalletClient();
    expect(client.isAvailable()).toBe(false);

    render(<WalletConnect client={client} />);
    const button = screen.getByRole('button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/no wallet detected/i);
  });

  it('explains that connecting without a provider is impossible', async () => {
    const client = createWalletClient();
    await expect(client.connect()).rejects.toThrow(WalletError);
    await expect(client.connect()).rejects.toThrow(/No Ethereum wallet detected/);
  });

  it('refuses to sign outside a wallet instead of fabricating a signature', async () => {
    const client = createWalletClient();
    await expect(client.signTypedData(TRADER, { types: {}, domain: {} })).rejects.toThrow(
      /No Ethereum wallet detected/
    );
  });
});

describe('SwapPanel', () => {
  const client = createWalletClient();

  it('renders the signed struct fields', () => {
    render(<SwapPanel wallet={client} account={null} hyperDexAddress={POOL} chainId={11155111} />);
    expect(screen.getByTestId('swap-panel')).toBeInTheDocument();
    expect(screen.getByLabelText('pool')).toBeInTheDocument();
    expect(screen.getByLabelText('amount')).toBeInTheDocument();
    expect(screen.getByLabelText('price limit')).toHaveValue('4295128740');
  });

  it('requires a wallet before it will sign anything', async () => {
    render(<SwapPanel wallet={client} account={null} hyperDexAddress={POOL} chainId={11155111} />);
    fireEvent.change(screen.getByLabelText('pool'), { target: { value: POOL } });
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });

    // Buttons are disabled without an account.
    expect(screen.getByText(/sign & relay/i)).toBeDisabled();
    expect(screen.getByText(/submit directly/i)).toBeDisabled();
  });

  it('reports an invalid pool instead of sending a broken transaction', async () => {
    render(<SwapPanel wallet={client} account={TRADER} hyperDexAddress={POOL} chainId={11155111} />);
    fireEvent.change(screen.getByLabelText('pool'), { target: { value: '0xnot-a-pool' } });
    fireEvent.change(screen.getByLabelText('amount'), { target: { value: '1' } });
    fireEvent.click(screen.getByText(/submit directly/i));

    await waitFor(() => expect(screen.getByTestId('swap-error')).toHaveTextContent(/not valid/i));
  });
});

describe('BridgePanel', () => {
  const client = createWalletClient();

  it('explains the approval requirement and shows the destination chain', () => {
    render(
      <BridgePanel
        wallet={client}
        account={null}
        routerAddress={ROUTER}
        srcChainId={11155111}
        dstChainId={10}
      />
    );
    expect(screen.getByTestId('bridge-panel')).toBeInTheDocument();
    expect(screen.getByText(/approve the token/i)).toBeInTheDocument();
    expect(screen.getByText(/bridge to chain 10/i)).toBeInTheDocument();
  });

  it('validates the token address', async () => {
    render(
      <BridgePanel
        wallet={client}
        account={TRADER}
        routerAddress={ROUTER}
        srcChainId={11155111}
        dstChainId={10}
      />
    );
    fireEvent.change(screen.getByLabelText('token'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText(/bridge to chain/i));

    await waitFor(() => expect(screen.getByTestId('bridge-error')).toHaveTextContent(/not valid/i));
  });
});

describe('LiquidityPanel', () => {
  const client = createWalletClient();

  it('offers the standard fee tiers', () => {
    render(
      <LiquidityPanel
        wallet={client}
        account={null}
        positionManagerAddress={ROUTER}
      />
    );
    expect(screen.getByTestId('liquidity-panel')).toBeInTheDocument();
    expect(screen.getByLabelText('fee tier')).toHaveValue('3000');
    expect(screen.getByText('0.05%')).toBeInTheDocument();
  });

  it('validates both token addresses before building the mint call', async () => {
    render(<LiquidityPanel wallet={client} account={TRADER} positionManagerAddress={ROUTER} />);
    fireEvent.change(screen.getByLabelText('token0'), { target: { value: 'nope' } });
    fireEvent.change(screen.getByLabelText('token1'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByText(/add liquidity/i));

    await waitFor(() =>
      expect(screen.getByTestId('liquidity-error')).toHaveTextContent(/token addresses/i)
    );
  });
});

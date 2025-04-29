const { ethers } = require('ethers');
const NonceManager = require('../../src/services/nonce-manager');
const { getTestProvider, getTestWallets } = require('../utils/test-utils');
const { expect } = require('chai');
const sinon = require('sinon');

describe('Nonce Manager', () => {
  let nonceManager;
  let provider;
  let wallets;
  let relayerAddress;

  beforeEach(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    relayerAddress = wallets.relayer.address;
    nonceManager = new NonceManager(provider, wallets.relayer);
  });

  afterEach(() => {
    sinon.restore();
  });

  it('getNonce returns sequential nonces for same address', async () => {
    provider.getTransactionCount.resolves(100);
    const nonce1 = await nonceManager.getNonce(relayerAddress);
    const nonce2 = await nonceManager.getNonce(relayerAddress);
    const nonce3 = await nonceManager.getNonce(relayerAddress);

    expect(nonce1).to.be.equal(100);
    expect(nonce2).to.be.equal(101);
    expect(nonce3).to.be.equal(102);

    // Should have called getTransactionCount once for initial nonce
    expect(provider.getTransactionCount.callCount).to.equal(1);
  });

  it('reserveNonce reserves a specific nonce for a transaction', async () => {
    const txId = 'test-tx-1';
    const nonce = 10;

    const result = await nonceManager.reserveNonce(relayerAddress, txId, nonce);

    // Check the result
    expect(result).to.be.equal(nonce);

    // Check that the reservation is stored
    const reservation = nonceManager.reservations.get(txId);
    expect(reservation).to.be.ok;
    expect(reservation.nonce).to.be.equal(nonce);
    expect(reservation.address).to.be.equal(relayerAddress);
  });

  it('releaseNonce frees up a reserved nonce', async () => {
    const txId = 'test-tx-1';
    const nonce = 10;

    // Reserve a nonce
    await nonceManager.reserveNonce(relayerAddress, txId, nonce);

    // Release the nonce
    await nonceManager.releaseNonce(txId);

    // Verify it's been removed
    expect(nonceManager.reservations.has(txId)).to.be.false;
  });

  it('getNextNonce returns the next available nonce', async () => {
    provider.getTransactionCount.resolves(100);
    // First, get the initial next nonce
    const nonce1 = await nonceManager.getNextNonce(relayerAddress);
    expect(nonce1).to.be.equal(100);

    // Then get another nonce
    const nonce2 = await nonceManager.getNextNonce(relayerAddress);
    expect(nonce2).to.be.equal(101);
  });

  it('handles concurrent nonce requests correctly', async () => {
    provider.getTransactionCount.resolves(100);
    // Override normal sequential execution with delayed promises to simulate race conditions
    const originalGetNonce = nonceManager.getNonce;

    // Create a delayed version that will cause race conditions
    sinon.stub(nonceManager, 'getNonce').callsFake(async (address) => {
      // Simulate network delay that might cause race conditions
      const delay = 10; // Small delay
      await new Promise(resolve => setTimeout(resolve, delay));

      // Then call the original method
      return originalGetNonce.call(nonceManager, address);
    });

    // Make concurrent requests for nonces
    const results = await Promise.all([
      nonceManager.getNextNonce(relayerAddress),
      nonceManager.getNextNonce(relayerAddress),
      nonceManager.getNextNonce(relayerAddress)
    ]);

    // Each should get a unique nonce due to our locking mechanism
    const [nonce1, nonce2, nonce3] = results;

    // Verify each nonce is unique
    expect(nonce1).not.to.be.equal(nonce2);
    expect(nonce2).not.to.be.equal(nonce3);
    expect(nonce1).not.to.be.equal(nonce3);

    // They should be in sequence
    const sortedNonces = [...results].sort((a, b) => a - b);
    expect(sortedNonces[0] + 1).to.be.equal(sortedNonces[1]);
    expect(sortedNonces[1] + 1).to.be.equal(sortedNonces[2]);
  });

  it('handles nonce gaps from failed transactions', async () => {
    provider.getTransactionCount.resolves(100);
    // Get some sequential nonces first
    const tx1 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-1');
    expect(tx1).to.be.equal(100);

    // Reserve a specific nonce for the second transaction
    const tx2 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-2', 101);
    expect(tx2).to.be.equal(101);

    // The next nonce should be tx1 + 2
    // Since we've reserved tx1 (100) and tx1+1 (101), the next one should be tx1+2 (102)
    const tx3 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-3');
    expect(tx3).to.be.equal(102);

    // Mark the middle transaction as failed
    await nonceManager.markTransactionFailed('gap-tx-2');

    // Now if we request a new nonce, we should get the failed one
    const tx4 = await nonceManager.getNextNonce(relayerAddress);
    expect(tx4).to.be.equal(101); // Failed nonce should be reused
  });

  it('resetNonce synchronizes with network nonce', async () => {
    // Create usedNonces structure for the relayer address first
    if (!nonceManager.usedNonces.has(relayerAddress)) {
      nonceManager.usedNonces.set(relayerAddress, new Set());
    }

    // Add some used nonces
    nonceManager.usedNonces.get(relayerAddress).add(10);
    nonceManager.usedNonces.get(relayerAddress).add(11);

    // Add some reservations
    await nonceManager.reserveNonce(relayerAddress, 'reset-test-tx', 15);

    // Patch provider.getTransactionCount just for this test
    provider.getTransactionCount.resolves(200);

    // Reset the nonce
    const nonce = await nonceManager.resetNonce(relayerAddress);

    // Check that we got the updated nonce
    expect(nonce).to.be.equal(200);

    // Next nonce should be the updated one
    const nextNonce = await nonceManager.getNextNonce(relayerAddress);
    expect(nextNonce).to.be.equal(200);

    // Verify all data structures were properly cleared
    expect(nonceManager.usedNonces.get(relayerAddress).size).to.be.equal(1); // Next nonce call adds one entry
    expect(nonceManager.reservations.has('reset-test-tx')).to.be.false; // Reservation should be cleared
  });
});

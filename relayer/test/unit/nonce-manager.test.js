const { ethers } = require('ethers');
const NonceManager = require('../../src/services/nonce-manager');
const { getTestProvider, getTestWallets } = require('../utils/test-utils');

describe('Nonce Manager', () => {
  let nonceManager;
  let provider;
  let wallets;
  let relayerAddress;
  
  beforeEach(() => {
    provider = getTestProvider();
    wallets = getTestWallets(provider);
    relayerAddress = wallets.relayer.address;
    
    // Mock provider
    provider.getTransactionCount = jest.fn().mockImplementation(() => {
      return Promise.resolve(100);
    });
    
    // Initialize nonce manager
    nonceManager = new NonceManager(provider, wallets.relayer);
  });
  
  test('getNonce returns sequential nonces for same address', async () => {
    const nonce1 = await nonceManager.getNonce(relayerAddress);
    const nonce2 = await nonceManager.getNonce(relayerAddress);
    const nonce3 = await nonceManager.getNonce(relayerAddress);
    
    expect(nonce1).toBe(100);
    expect(nonce2).toBe(101);
    expect(nonce3).toBe(102);
    
    // Should have called getTransactionCount once for initial nonce
    expect(provider.getTransactionCount).toHaveBeenCalledTimes(1);
  });
  
  test('reserveNonce reserves a specific nonce for a transaction', async () => {
    const txId = 'test-tx-1';
    const nonce = 10;
    
    const result = await nonceManager.reserveNonce(relayerAddress, txId, nonce);
    
    // Check the result
    expect(result).toBe(nonce);
    
    // Check that the reservation is stored
    const reservation = nonceManager.reservations.get(txId);
    expect(reservation).toBeDefined();
    expect(reservation.nonce).toBe(nonce);
    expect(reservation.address).toBe(relayerAddress);
  });
  
  test('releaseNonce frees up a reserved nonce', async () => {
    const txId = 'test-tx-1';
    const nonce = 10;
    
    // Reserve a nonce
    await nonceManager.reserveNonce(relayerAddress, txId, nonce);
    
    // Release the nonce
    await nonceManager.releaseNonce(txId);
    
    // Verify it's been removed
    expect(nonceManager.reservations.has(txId)).toBe(false);
  });
  
  test('getNextNonce returns the next available nonce', async () => {
    // First, get the initial next nonce
    const nonce1 = await nonceManager.getNextNonce(relayerAddress);
    expect(nonce1).toBe(100);
    
    // Then get another nonce
    const nonce2 = await nonceManager.getNextNonce(relayerAddress);
    expect(nonce2).toBe(101);
  });
  
  test('handles concurrent nonce requests correctly', async () => {
    // Override normal sequential execution with delayed promises to simulate race conditions
    const originalGetNonce = nonceManager.getNonce;
    
    // Create a delayed version that will cause race conditions
    nonceManager.getNonce = jest.fn().mockImplementation(async (address) => {
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
    expect(nonce1).not.toBe(nonce2);
    expect(nonce2).not.toBe(nonce3);
    expect(nonce1).not.toBe(nonce3);
    
    // They should be in sequence
    const sortedNonces = [...results].sort((a, b) => a - b);
    expect(sortedNonces[0] + 1).toBe(sortedNonces[1]);
    expect(sortedNonces[1] + 1).toBe(sortedNonces[2]);
  });
  
  test('handles nonce gaps from failed transactions', async () => {
    // Get some sequential nonces first
    const tx1 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-1');
    expect(tx1).toBe(100);
    
    // Reserve a specific nonce for the second transaction
    const tx2 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-2', 101);
    expect(tx2).toBe(101);
    
    // The next nonce should be tx1 + 2
    // Since we've reserved tx1 (100) and tx1+1 (101), the next one should be tx1+2 (102)
    const tx3 = await nonceManager.reserveNonce(relayerAddress, 'gap-tx-3');
    expect(tx3).toBe(102);
    
    // Mark the middle transaction as failed
    await nonceManager.markTransactionFailed('gap-tx-2');
    
    // Now if we request a new nonce, we should get the failed one
    const tx4 = await nonceManager.getNextNonce(relayerAddress);
    expect(tx4).toBe(101); // Failed nonce should be reused
  });
  
  test('resetNonce synchronizes with network nonce', async () => {
    // Create usedNonces structure for the relayer address first
    if (!nonceManager.usedNonces.has(relayerAddress)) {
      nonceManager.usedNonces.set(relayerAddress, new Set());
    }
    
    // Add some used nonces
    nonceManager.usedNonces.get(relayerAddress).add(10);
    nonceManager.usedNonces.get(relayerAddress).add(11);
    
    // Add some reservations
    await nonceManager.reserveNonce(relayerAddress, 'reset-test-tx', 15);
    
    // Change mock to return a higher nonce
    provider.getTransactionCount.mockResolvedValueOnce(200);
    
    // Reset the nonce
    const nonce = await nonceManager.resetNonce(relayerAddress);
    
    // Check that we got the updated nonce
    expect(nonce).toBe(200);
    
    // Next nonce should be the updated one
    const nextNonce = await nonceManager.getNextNonce(relayerAddress);
    expect(nextNonce).toBe(200);
    
    // Verify all data structures were properly cleared
    expect(nonceManager.usedNonces.get(relayerAddress).size).toBe(1); // Next nonce call adds one entry
    expect(nonceManager.reservations.has('reset-test-tx')).toBe(false); // Reservation should be cleared
  });
});

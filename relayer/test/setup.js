// Setup test environment
process.env.NODE_ENV = 'test';

// Set any other test environment variables needed
// Hardhat's publicly documented dev account #0
// (0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266). It is a fixture of every local
// Hardhat node and holds nothing anywhere, so it is safe to commit.
process.env.PRIVATE_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
process.env.HYPERDEX_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
process.env.RPC_URL = 'http://localhost:8545';

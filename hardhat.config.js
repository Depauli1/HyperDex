const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require("@nomicfoundation/hardhat-toolbox");

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } }
  },
  networks: {
    hardhat: {},
    hyperEvmTestnet: {
      url: "https://rpc.hyperliquid-testnet.xyz/evm", 
      chainId: 998, 
      accounts: [process.env.PRIVATE_KEY],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test"
  },
  mocha: {
    timeout: 120000
  }
};
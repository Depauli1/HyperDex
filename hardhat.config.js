require('dotenv').config();
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.7.6",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
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
  },
  // Add this to help resolve imports
  mocha: {
    timeout: 40000
  }
};
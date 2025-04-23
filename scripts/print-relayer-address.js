// scripts/print-relayer-address.js
// Prints the relayer wallet address from the PRIVATE_KEY in .env
const { Wallet } = require('ethers');
require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

const key = process.env.PRIVATE_KEY;
if (!key) throw new Error('PRIVATE_KEY not set in .env');
const wallet = new Wallet(key);
console.log('RELAYER_ADDRESS=' + wallet.address);

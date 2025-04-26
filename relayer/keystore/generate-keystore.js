const { Wallet } = require('ethers');
const fs = require('fs');

const privateKey = process.env.PRIVATE_KEY || '8fe06e94fcd993658477cc2234245dff65a11f07619e08f42883b5f06d02feb9';
const password = process.env.KEYSTORE_PASSWORD || 'testpassword';
const keystorePath = './keystore/test-keystore.json';

async function main() {
  const wallet = new Wallet(privateKey);
  const json = await wallet.encrypt(password);
  fs.writeFileSync(keystorePath, json);
  console.log('Keystore generated at', keystorePath);
}

main();

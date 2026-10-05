/**
 * API integration tests.
 *
 * The gasless-swap endpoint is exercised end to end against the real
 * controller, the real signature module and a real `ContractService` talking to
 * the in-process chain - a signed request goes in over HTTP and a transaction
 * comes out the other side. The previous version stubbed the signature verifier
 * to `true` and sent a fabricated signature, so it could not detect the domain
 * mismatch that made the endpoint unusable.
 *
 * The status and health endpoints keep lightweight service doubles for the
 * parts of the relayer that are not under test here (database, mempool).
 */
const request = require('supertest');
const express = require('express');
const { ethers } = require('ethers');
const routes = require('../../src/api/routes');
const ContractService = require('../../src/services/contract-service');
const signatureUtils = require('../../src/utils/signature');
const { GASLESS_SWAP_TYPES, gaslessSwapDomain, toStruct } = require('../../src/config/eip712');
const { TEST_ACCOUNTS, getTestProvider } = require('../utils/test-utils');
const sinon = require('sinon');
const { expect } = require('chai');

const HyperDexABI = require('../../abi/HyperDex.json');
const { createChain } = require('../utils/fake-chain');

const HYPERDEX = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const POOL = '0x9A676e781A523b5d0C0e43731313A708CB607508';
const CHAIN_ID = 31337;

describe('API Integration Tests', () => {
  let app;
  let chain;
  let contractService;
  let mockServices;
  let traderWallet;
  let strangerWallet;

  beforeAll(async () => {
    chain = await createChain({
      chainId: CHAIN_ID,
      contracts: { [HYPERDEX]: HyperDexABI }
    });
    chain.onCall(HYPERDEX, 'executeGaslessSwap', () => undefined);
    chain.onStaticCall(HYPERDEX, 'getNonce', ethers.BigNumber.from(0));

    const provider = new ethers.providers.JsonRpcProvider(chain.url);
    const relayerWallet = ethers.Wallet.createRandom().connect(provider);
    traderWallet = new ethers.Wallet(TEST_ACCOUNTS.trader.privateKey);
    strangerWallet = new ethers.Wallet(TEST_ACCOUNTS.user.privateKey);

    contractService = new ContractService({
      provider,
      wallet: relayerWallet,
      hyperDexAddress: HYPERDEX
    });

    mockServices = {
      mempoolManager: {
        queueTransaction: sinon.stub().resolves({ transactionHash: '0x' + '1'.repeat(64) }),
        getTransactionStatus: sinon.stub().callsFake((txHash) => ({
          status: 'confirmed',
          txHash,
          blockNumber: 12345678
        }))
      },
      contractService,
      // The real verifier: no bypass option exists.
      signatureUtils,
      nonceManager: { getNonce: sinon.stub().resolves(0), reserveNonce: sinon.stub().resolves(0) },
      dbService: {
        sequelize: { authenticate: sinon.stub().resolves() },
        verifyAuthToken: sinon.stub().resolves(TEST_ACCOUNTS.trader.address),
        getGasPriceHistory: sinon.stub().resolves([])
      },
      providerManager: {
        getHealthStatus: sinon.stub().resolves({ hasHealthyProvider: true, providers: [] }),
        executeWithProvider: sinon.stub().resolves(12345678)
      }
    };

    app = express();
    app.use(express.json());
    app.use('/api', routes(mockServices));
  });

  afterAll(async () => {
    sinon.restore();
    await chain.close();
  });

  async function signedSwap(signer, params = {}) {
    const body = {
      pool: POOL,
      trader: signer.address,
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther('1').toString(),
      sqrtPriceLimitX96: '4295128740',
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: '0',
      ...params
    };
    body.signature = await signer._signTypedData(
      gaslessSwapDomain(CHAIN_ID, HYPERDEX),
      GASLESS_SWAP_TYPES,
      toStruct(body)
    );
    return body;
  }

  describe('POST /api/swap/gasless', () => {
    it('executes a swap signed by the trader', async () => {
      const before = chain.sent.length;

      const response = await request(app).post('/api/swap/gasless').send(await signedSwap(traderWallet));

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'submitted');
      expect(response.body.transactionHash).to.match(/^0x[0-9a-f]{64}$/);

      // The relayer really submitted it: one more transaction on the chain,
      // carrying the trader's struct and signature.
      expect(chain.sent.length).to.equal(before + 1);
      const sent = chain.sent[chain.sent.length - 1];
      expect(sent.to).to.equal(HYPERDEX);
      const iface = new ethers.utils.Interface(HyperDexABI);
      const [struct, signature] = iface.decodeFunctionData('executeGaslessSwap', sent.data);
      expect(struct[0]).to.equal(POOL);
      expect(struct[1]).to.equal(traderWallet.address);
      expect(signature).to.match(/^0x[0-9a-f]{130}$/);
    });

    it('rejects a signature from a different account with 401', async () => {
      const body = await signedSwap(traderWallet);
      // Signed by someone else over the same payload.
      body.signature = (await signedSwap(strangerWallet)).signature;

      const response = await request(app).post('/api/swap/gasless').send(body);
      expect(response.status).to.equal(401);
      expect(response.body.error).to.match(/Signature does not match trader/);
    });

    it('rejects a payload tampered with after signing with 401', async () => {
      const body = await signedSwap(traderWallet);
      body.amountSpecified = ethers.utils.parseEther('100').toString();

      const response = await request(app).post('/api/swap/gasless').send(body);
      expect(response.status).to.equal(401);
    });

    it('rejects the legacy poolAddress field with 400', async () => {
      const body = await signedSwap(traderWallet);
      body.poolAddress = body.pool;
      delete body.pool;

      const response = await request(app).post('/api/swap/gasless').send(body);
      expect(response.status).to.equal(400);
      expect(response.body.error).to.match(/pool/);
    });

    it('handles missing parameters', async () => {
      const response = await request(app)
        .post('/api/swap/gasless')
        .send({ trader: TEST_ACCOUNTS.trader.address, signature: '0x' + 'ab'.repeat(65) });

      expect(response.status).to.equal(400);
      expect(response.body).to.have.property('error');
    });

    it('rejects an expired deadline with 400', async () => {
      const body = await signedSwap(traderWallet, { deadline: Math.floor(Date.now() / 1000) - 60 });
      const response = await request(app).post('/api/swap/gasless').send(body);
      expect(response.status).to.equal(400);
      expect(response.body.error).to.match(/deadline/i);
    });
  });

  describe('GET /api/status/:txHash', () => {
    it('retrieves transaction status', async () => {
      const txHash = '0x' + '1'.repeat(64);
      const response = await request(app).get(`/api/status/${txHash}`);

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'confirmed');
      expect(response.body).to.have.property('txHash', txHash);
      expect(response.body).to.have.property('blockNumber', 12345678);
    });

    it('handles unknown transaction', async () => {
      mockServices.mempoolManager.getTransactionStatus.resolves(null);
      const response = await request(app).get(`/api/status/0x${'9'.repeat(64)}`);

      expect(response.status).to.equal(404);
      expect(response.body.error).to.contain('Transaction not found');
    });

    it('validates transaction hash format', async () => {
      const response = await request(app).get('/api/status/not-a-valid-tx-hash');

      expect(response.status).to.equal(400);
      expect(response.body.error).to.contain('Invalid transaction hash');
    });
  });

  describe('GET /api/health', () => {
    it('returns proper health status', async () => {
      const response = await request(app).get('/api/health');

      expect(response.status).to.equal(200);
      expect(response.body).to.have.property('status', 'ok');
      expect(response.body).to.have.property('timestamp');
      expect(response.body).to.have.property('uptime');
      expect(response.body).to.have.property('version');
    });
  });
});

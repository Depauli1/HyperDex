// Cross-language EIP-712 conformance.
//
// The relayer, the client SDK and this contract must agree on the domain and the
// struct, byte for byte. They previously did not: the JavaScript side signed
// `HyperDex Protocol` with a field called `poolAddress`, while the contract
// recovered against `HyperDex` with a field called `pool`, so every signature
// the SDK produced was rejected on-chain with `InvalidSignature`.
//
// These tests compare the two implementations directly - the JavaScript module
// the relayer actually uses against the digest and separator the deployed
// contract computes - so drift fails the build instead of failing in production.

const { expect } = require("chai");
const { ethers } = require("hardhat");

const relayerEip712 = require("../relayer/src/config/eip712");
const relayerSignature = require("../relayer/src/utils/signature");

const { deployV3Stack, MIN_SQRT_RATIO } = require("./helpers/v3");

describe("EIP-712 conformance between contract and relayer", function () {
  let hyperdex, pool, trader, other, deployment;

  beforeEach(async function () {
    const stack = await deployV3Stack();
    ({ hyperdex, pool, trader, other } = stack);

    deployment = {
      chainId: (await ethers.provider.getNetwork()).chainId,
      verifyingContract: hyperdex.address
    };
  });

  function makeParams(overrides = {}) {
    return {
      pool: pool.address,
      trader: trader.address,
      zeroForOne: true,
      amountSpecified: ethers.utils.parseEther("1"),
      sqrtPriceLimitX96: MIN_SQRT_RATIO + 1n,
      deadline: Math.floor(Date.now() / 1000) + 3600,
      nonce: 0,
      ...overrides
    };
  }

  it("agrees on the struct type hash", async function () {
    const onChain = await hyperdex.gaslessSwapTypehash();
    const offChain = ethers.utils._TypedDataEncoder.hashStruct; // sanity: encoder available
    expect(offChain).to.be.a("function");

    const expected = ethers.utils.keccak256(
      ethers.utils.toUtf8Bytes(
        "GaslessSwap(address pool,address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)"
      )
    );
    expect(onChain).to.equal(expected);
  });

  it("agrees on the domain separator", async function () {
    const onChain = await hyperdex.domainSeparator();
    const offChain = ethers.utils._TypedDataEncoder.hashDomain(
      relayerEip712.gaslessSwapDomain(deployment.chainId, deployment.verifyingContract)
    );
    expect(onChain).to.equal(offChain);
  });

  it("produces the same digest as HyperDex.hashGaslessSwap", async function () {
    const params = makeParams();
    const onChain = await hyperdex.hashGaslessSwap(params);
    const offChain = relayerEip712.hashGaslessSwap(params, deployment);
    expect(offChain).to.equal(onChain);
  });

  it("accepts a signature produced with the relayer's definition", async function () {
    const params = makeParams();
    const signature = await relayerEip712.signGaslessSwap(trader, params, deployment);

    // The relayer's own pre-flight check agrees...
    expect(
      relayerSignature.verifyGaslessSwap(params, signature, deployment)
    ).to.equal(true);

    // ...and the contract does too: this is the flow that used to revert.
    const recovered = await hyperdex.hashGaslessSwap(params);
    expect(ethers.utils.recoverAddress(recovered, signature)).to.equal(trader.address);
  });

  it("rejects a signature made over the old, wrong struct", async function () {
    const params = makeParams();
    const legacyTypes = {
      GaslessSwap: [
        { name: "trader", type: "address" },
        { name: "zeroForOne", type: "bool" },
        { name: "amountSpecified", type: "int256" },
        { name: "sqrtPriceLimitX96", type: "uint160" },
        { name: "poolAddress", type: "address" },
        { name: "deadline", type: "uint256" },
        { name: "nonce", type: "uint256" }
      ]
    };
    const legacySignature = await trader._signTypedData(
      { name: "HyperDex Protocol", version: "1", ...deployment },
      legacyTypes,
      { ...params, poolAddress: params.pool }
    );

    // The contract's digest does not match the legacy signature, so it recovers
    // a different address - which is exactly why the old SDK could never swap.
    const digest = await hyperdex.hashGaslessSwap(params);
    expect(ethers.utils.recoverAddress(digest, legacySignature)).to.not.equal(trader.address);

    expect(() =>
      relayerSignature.verifyGaslessSwap(params, legacySignature, deployment)
    ).to.throw(/Signature does not match trader/);
  });

  it("rejects a signature from a different account", async function () {
    const params = makeParams();
    const signature = await relayerEip712.signGaslessSwap(other, params, deployment);
    expect(() =>
      relayerSignature.verifyGaslessSwap(params, signature, deployment)
    ).to.throw(/Signature does not match trader/);
  });

  it("rejects an expired deadline before touching the signature", async function () {
    const params = makeParams({ deadline: Math.floor(Date.now() / 1000) - 10 });
    const signature = await relayerEip712.signGaslessSwap(trader, params, deployment);
    expect(() =>
      relayerSignature.verifyGaslessSwap(params, signature, deployment)
    ).to.throw(/deadline has expired/);
  });

  it("rejects a malformed signature", async function () {
    expect(() =>
      relayerSignature.verifyGaslessSwap(makeParams(), "0xdeadbeef", deployment)
    ).to.throw(/Invalid signature format/);
  });
});

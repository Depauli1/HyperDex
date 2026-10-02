const { expect } = require("chai");
const { ethers } = require("hardhat");
const {
  MIN_SQRT_RATIO,
  getMinTick,
  getMaxTick,
  deployV3Stack,
} = require("./helpers/v3");

const FEE = 500;
const TICK_SPACING = 10;
const LIQUIDITY = 1000000000000000000n;

const GASLESS_SWAP_TYPES = {
  GaslessSwap: [
    { name: "pool", type: "address" },
    { name: "trader", type: "address" },
    { name: "zeroForOne", type: "bool" },
    { name: "amountSpecified", type: "int256" },
    { name: "sqrtPriceLimitX96", type: "uint160" },
    { name: "deadline", type: "uint256" },
    { name: "nonce", type: "uint256" },
  ],
};

/**
 * Gasless-swap gateway tests.
 *
 * The swap is executed against a real `UniswapV3Pool`; HyperDex only verifies
 * the trader's EIP-712 signature and settles the pool's swap callback.
 */
describe("HyperDex gasless swaps", function () {
  let stack, hyperdex, hyperdexFactory, pool, token0, token1;
  let owner, relayer, trader, other;
  let domain;

  beforeEach(async function () {
    stack = await deployV3Stack({ fee: FEE, tickSpacing: TICK_SPACING });
    ({ hyperdex, hyperdexFactory, pool, token0, token1, owner, relayer, trader, other } =
      stack);

    const chainId = (await ethers.provider.getNetwork()).chainId;
    domain = {
      name: "HyperDex",
      version: "1",
      chainId,
      verifyingContract: hyperdex.address,
    };

    // Liquidity for the pool to trade against.
    await token0.approve(stack.callee.address, ethers.constants.MaxUint256);
    await token1.approve(stack.callee.address, ethers.constants.MaxUint256);
    await stack.callee.mint(
      pool.address,
      owner.address,
      getMinTick(TICK_SPACING),
      getMaxTick(TICK_SPACING),
      LIQUIDITY
    );
  });

  /** Builds params and the trader's signature over them. */
  async function signedParams(overrides = {}, signer = trader) {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
    const params = {
      pool: pool.address,
      trader: trader.address,
      zeroForOne: true,
      amountSpecified: 1000000n,
      sqrtPriceLimitX96: MIN_SQRT_RATIO + 1n,
      deadline,
      nonce: (await hyperdex.getNonce(trader.address)).toBigInt(),
      ...overrides,
    };
    const signature = await signer._signTypedData(domain, GASLESS_SWAP_TYPES, params);
    return { params, signature };
  }

  /** Funds the trader with token0 and lets the gateway pull it. */
  async function fundTrader(amount) {
    await token0.transfer(trader.address, amount);
    await token0.connect(trader).approve(hyperdex.address, amount);
  }

  it("executes a trader-signed swap through the real pool", async function () {
    await fundTrader(1000000n);
    const { params, signature } = await signedParams();

    const t0Before = (await token0.balanceOf(trader.address)).toBigInt();
    const t1Before = (await token1.balanceOf(trader.address)).toBigInt();
    const priceBefore = (await pool.slot0()).sqrtPriceX96.toBigInt();

    await expect(hyperdex.connect(relayer).executeGaslessSwap(params, signature))
      .to.emit(hyperdex, "GaslessSwapExecuted")
      .withArgs(
        trader.address,
        relayer.address,
        pool.address,
        true,
        params.amountSpecified,
        // token1 is the output leg, so its delta is negative.
        (v) => v.toBigInt() < 0n
      );

    const t0After = (await token0.balanceOf(trader.address)).toBigInt();
    const t1After = (await token1.balanceOf(trader.address)).toBigInt();

    expect(t0Before - t0After).to.equal(1000000n);
    expect(t1After > t1Before, "trader received no output").to.be.true;
    expect((await pool.slot0()).sqrtPriceX96.toBigInt() < priceBefore).to.be.true;
    expect((await hyperdex.getNonce(trader.address)).toBigInt()).to.equal(1n);
  });

  it("rejects a swap the trader never signed", async function () {
    await fundTrader(1000000n);
    // Signed by a different account, submitted as if it were the trader's.
    const { params, signature } = await signedParams({}, other);
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "InvalidSignature");
  });

  it("rejects a swap submitted by anyone but the relayer", async function () {
    await fundTrader(1000000n);
    const { params, signature } = await signedParams();
    await expect(
      hyperdex.connect(other).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "InvalidRelayer");
  });

  it("rejects a replay of the same signature", async function () {
    await fundTrader(2000000n);
    const { params, signature } = await signedParams();
    await hyperdex.connect(relayer).executeGaslessSwap(params, signature);
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "InvalidNonce");
  });

  it("rejects a swap whose signature names a pool that is not ours", async function () {
    await fundTrader(1000000n);
    const { params, signature } = await signedParams({ pool: other.address });
    // The signature is over a different pool, so it cannot be replayed against
    // the real one; and that address is not a registered pool either.
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "UnknownPool");
  });

  it("rejects an expired swap", async function () {
    await fundTrader(1000000n);
    const past = (await ethers.provider.getBlock("latest")).timestamp - 10;
    const { params, signature } = await signedParams({ deadline: past });
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "DeadlineExpired");
  });

  it("rejects a zero amount", async function () {
    await fundTrader(1000000n);
    const { params, signature } = await signedParams({ amountSpecified: 0n });
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap(params, signature)
    ).to.be.revertedWithCustomError(hyperdex, "ZeroAmount");
  });

  it("refuses swap callbacks from a contract that is not a registered pool", async function () {
    await fundTrader(1000000n);
    // Any caller can invoke the callback directly; without the registry check a
    // malicious pool could drain the trader's approval.
    await expect(
      hyperdex.uniswapV3SwapCallback(1n, 0n, ethers.utils.defaultAbiCoder.encode(
        ["address"],
        [trader.address]
      ))
    ).to.be.revertedWithCustomError(hyperdex, "UnauthorizedCallback");
  });

  it("only the owner may change the relayer", async function () {
    await expect(
      hyperdex.connect(other).setRelayer(other.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("registers pools created through the HyperDex factory", async function () {
    expect(await hyperdexFactory.isPool(pool.address)).to.be.true;
    expect(await hyperdexFactory.isPool(other.address)).to.be.false;

    const info = await hyperdexFactory.getPoolInfo(
      await token0.address,
      await token1.address,
      FEE
    );
    expect(info.poolAddress).to.equal(pool.address);
    expect(Number(info.tickSpacing)).to.equal(TICK_SPACING);
    expect(info.enabled).to.be.true;
  });
});

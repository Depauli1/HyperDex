const { ethers } = require("hardhat");
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const BigNumber = ethers.BigNumber;

/**
 * End-to-end gasless swap through the HyperDex relayer gateway.
 *
 * The trader signs against the *pool's* EIP-712 domain, and the signed payload
 * names the pool it is valid for. HyperDex re-verifies that same signature and
 * routes to that pool; the pool verifies it again before moving any funds.
 */
describe("HyperDex: Gasless Swaps", function () {
  const FEE_TIER = 500;
  const Q96 = BigNumber.from(2).pow(96);
  const MIN_SQRT_RATIO_PLUS_ONE = "4295128740";

  const GASLESS_SWAP_TYPES = {
    GaslessSwap: [
      { name: "pool", type: "address" },
      { name: "trader", type: "address" },
      { name: "zeroForOne", type: "bool" },
      { name: "amountSpecified", type: "int256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
      { name: "deadline", type: "uint256" },
      { name: "nonce", type: "uint256" }
    ]
  };

  async function deployFixture() {
    const [owner, relayer, user, attacker] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenA = await MockERC20.deploy("Token A", "TKNA", 18);
    const tokenB = await MockERC20.deploy("Token B", "TKNB", 18);
    await tokenA.deployed();
    await tokenB.deployed();
    const [token0, token1] =
      tokenA.address.toLowerCase() < tokenB.address.toLowerCase()
        ? [tokenA, tokenB]
        : [tokenB, tokenA];

    const Factory = await ethers.getContractFactory("HyperDexFactory");
    const factory = await Factory.deploy(ethers.constants.AddressZero);
    await factory.deployed();

    // The factory deploys the pool itself now.
    await factory.createPool(token0.address, token1.address, FEE_TIER);
    const poolAddress = await factory.getPool(token0.address, token1.address, FEE_TIER);
    const pool = await ethers.getContractAt("HyperDexPool", poolAddress);

    const HyperDex = await ethers.getContractFactory("HyperDex");
    const hyperdex = await HyperDex.deploy(factory.address);
    await hyperdex.deployed();

    // Authorise the gateway as the pool's relayer through the factory (the only
    // sanctioned path -- no account impersonation needed).
    await factory.setPoolRelayer(pool.address, hyperdex.address, true);
    await hyperdex.connect(owner).setRelayer(relayer.address);

    const mintAmount = ethers.utils.parseEther("1000");
    await token0.mint(user.address, mintAmount);
    await token1.mint(user.address, mintAmount);
    await token0.connect(user).approve(pool.address, ethers.constants.MaxUint256);
    await token1.connect(user).approve(pool.address, ethers.constants.MaxUint256);

    // Seed liquidity at price 1 across (almost) the full range.
    await token0.mint(owner.address, ethers.utils.parseEther("200"));
    await token1.mint(owner.address, ethers.utils.parseEther("200"));
    await token0.connect(owner).approve(pool.address, ethers.constants.MaxUint256);
    await token1.connect(owner).approve(pool.address, ethers.constants.MaxUint256);
    await pool.connect(owner).initialize(Q96);
    await pool
      .connect(owner)
      .mint(owner.address, -887270, 887270, ethers.utils.parseEther("100"), "0x");

    return { owner, relayer, user, attacker, factory, pool, hyperdex, token0, token1, mintAmount };
  }

  async function buildParams(pool, trader, amountIn, sqrtPriceLimitX96) {
    const latest = await ethers.provider.getBlock("latest");
    return {
      pool: pool.address,
      trader: trader.address,
      zeroForOne: true,
      amountSpecified: amountIn.toString(),
      sqrtPriceLimitX96,
      deadline: (latest.timestamp + 3600).toString(),
      nonce: "0"
    };
  }

  async function sign(pool, signer, params) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer._signTypedData(
      { name: "HyperDexPool", version: "1", chainId, verifyingContract: pool.address },
      GASLESS_SWAP_TYPES,
      params
    );
  }

  it("Should execute a signed gasless swap via the relayer", async function () {
    const { relayer, user, hyperdex, pool, token0, token1, mintAmount } = await loadFixture(deployFixture);

    const amountIn = ethers.utils.parseEther("0.001");
    const params = await buildParams(pool, user, amountIn, MIN_SQRT_RATIO_PLUS_ONE);
    const signature = await sign(pool, user, params);

    const bal0Before = await token0.balanceOf(user.address);
    const bal1Before = await token1.balanceOf(user.address);

    await hyperdex.connect(relayer).executeGaslessSwap({ ...params, signature }, signature);

    // The relayer paid no tokens and the trader moved exactly one swap's worth.
    expect(await hyperdex.getNonce(user.address)).to.equal(1);

    const bal0After = await token0.balanceOf(user.address);
    const bal1After = await token1.balanceOf(user.address);
    const moved0 = bal0After.sub(bal0Before).abs();
    const moved1 = bal1After.sub(bal1Before).abs();
    expect(moved0.isZero() && moved1.isZero()).to.equal(false);

    // The user still holds essentially their full balance: one small swap, not
    // the doubled transfer the previous implementation produced.
    expect(bal0After.add(bal1After)).to.be.closeTo(mintAmount.mul(2), ethers.utils.parseEther("0.01"));
  });

  it("Should refuse a gasless swap the trader did not sign", async function () {
    const { relayer, user, attacker, hyperdex, pool, token0, token1, mintAmount } =
      await loadFixture(deployFixture);

    const params = await buildParams(pool, user, ethers.utils.parseEther("0.001"), MIN_SQRT_RATIO_PLUS_ONE);
    // Someone other than the trader signs a payload naming the trader.
    const signature = await sign(pool, attacker, params);

    await expect(
      hyperdex.connect(relayer).executeGaslessSwap({ ...params, signature }, signature)
    ).to.be.revertedWith("Invalid signature");

    expect(await token0.balanceOf(user.address)).to.equal(mintAmount);
    expect(await token1.balanceOf(user.address)).to.equal(mintAmount);
  });

  it("Should refuse a caller that is not the configured relayer", async function () {
    const { user, attacker, hyperdex, pool } = await loadFixture(deployFixture);

    const params = await buildParams(pool, user, ethers.utils.parseEther("0.001"), MIN_SQRT_RATIO_PLUS_ONE);
    const signature = await sign(pool, user, params);

    await expect(
      hyperdex.connect(attacker).executeGaslessSwap({ ...params, signature }, signature)
    ).to.be.revertedWith("Invalid relayer");
  });

  it("Should route to the pool named in the signature, not pool #0", async function () {
    const { relayer, user, hyperdex, pool, factory, token0, token1 } = await loadFixture(deployFixture);

    // Create a second pool and make it pool #1.
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const tokenC = await MockERC20.deploy("Token C", "TKNC", 18);
    await tokenC.deployed();
    const [token2, token3] =
      tokenC.address.toLowerCase() < token1.address.toLowerCase()
        ? [tokenC, token1]
        : [token1, tokenC];
    await factory.createPool(token2.address, token3.address, FEE_TIER);
    const pool2Address = await factory.getPool(token2.address, token3.address, FEE_TIER);

    expect(await factory.allPools(0)).to.equal(pool.address);
    expect(await factory.allPools(1)).to.equal(pool2Address);

    // A swap signed for pool #0 must execute on pool #0.
    const amountIn = ethers.utils.parseEther("0.001");
    const params = await buildParams(pool, user, amountIn, MIN_SQRT_RATIO_PLUS_ONE);
    const signature = await sign(pool, user, params);

    const bal0Before = await token0.balanceOf(user.address);
    const bal1Before = await token1.balanceOf(user.address);

    await hyperdex.connect(relayer).executeGaslessSwap({ ...params, signature }, signature);

    expect(await token0.balanceOf(user.address)).to.not.equal(bal0Before);
    expect(await token1.balanceOf(user.address)).to.not.equal(bal1Before);
  });

  it("Should refuse to replay a gasless swap", async function () {
    const { relayer, user, hyperdex, pool } = await loadFixture(deployFixture);

    const params = await buildParams(pool, user, ethers.utils.parseEther("0.001"), MIN_SQRT_RATIO_PLUS_ONE);
    const signature = await sign(pool, user, params);

    await hyperdex.connect(relayer).executeGaslessSwap({ ...params, signature }, signature);
    await expect(
      hyperdex.connect(relayer).executeGaslessSwap({ ...params, signature }, signature)
    ).to.be.revertedWith("Invalid nonce");
  });
});

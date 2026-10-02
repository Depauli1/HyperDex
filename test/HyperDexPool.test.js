const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Regression tests for the pool-level defects:
 *   C1  gaslessSwap did not verify the trader's signature
 *   C2  swap() executed every swap twice
 *   C6  the factory never deployed a pool
 *   C7  every gasless swap was routed to pool #0
 */
describe("HyperDexPool", function () {
  const FEE_TIER = 500;
  const TICK_SPACING = 10;
  const Q96 = ethers.BigNumber.from(2).pow(96);

  // EIP-712 domain/types the pool verifies against.
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

  function poolDomain(pool) {
    return { name: "HyperDexPool", version: "1", chainId: 31337, verifyingContract: pool.address };
  }

  async function signGaslessSwap(signer, pool, params) {
    const chainId = (await ethers.provider.getNetwork()).chainId;
    return signer._signTypedData({ ...poolDomain(pool), chainId }, GASLESS_SWAP_TYPES, params);
  }

  async function deployFixture() {
    const [owner, relayer, trader, other] = await ethers.getSigners();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    let tokenA = await MockERC20.deploy("Token A", "TKNA", 18);
    let tokenB = await MockERC20.deploy("Token B", "TKNB", 18);
    await tokenA.deployed();
    await tokenB.deployed();
    let [token0, token1] =
      tokenA.address.toLowerCase() < tokenB.address.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];

    const Factory = await ethers.getContractFactory("HyperDexFactory");
    const factory = await Factory.deploy(ethers.constants.AddressZero);
    await factory.deployed();

    // The factory now really deploys the pool (C6).
    await factory.createPool(token0.address, token1.address, FEE_TIER);
    const poolAddress = await factory.getPool(token0.address, token1.address, FEE_TIER);
    const pool = await ethers.getContractAt("HyperDexPool", poolAddress);

    await factory.setPoolRelayer(pool.address, relayer.address, true);

    // A second pool, to prove routing is per-pool (C7).
    const tokenC = await MockERC20.deploy("Token C", "TKNC", 18);
    await tokenC.deployed();
    let [token2, token3] =
      tokenC.address.toLowerCase() < token1.address.toLowerCase()
        ? [tokenC, token1]
        : [token1, tokenC];
    await factory.createPool(token2.address, token3.address, FEE_TIER);
    const pool2Address = await factory.getPool(token2.address, token3.address, FEE_TIER);
    const pool2 = await ethers.getContractAt("HyperDexPool", pool2Address);
    await factory.setPoolRelayer(pool2.address, relayer.address, true);

    // Seed the first pool with liquidity.
    await token0.mint(owner.address, ethers.utils.parseEther("1000"));
    await token1.mint(owner.address, ethers.utils.parseEther("1000"));
    await token0.connect(owner).approve(pool.address, ethers.constants.MaxUint256);
    await token1.connect(owner).approve(pool.address, ethers.constants.MaxUint256);
    await pool.connect(owner).initialize(Q96); // price = 1
    await pool
      .connect(owner)
      .mint(owner.address, -887270, 887270, ethers.utils.parseEther("100"), "0x");

    // Fund and approve the trader.
    const traderBalance = ethers.utils.parseEther("100");
    await token0.mint(trader.address, traderBalance);
    await token1.mint(trader.address, traderBalance);
    await token0.connect(trader).approve(pool.address, ethers.constants.MaxUint256);
    await token1.connect(trader).approve(pool.address, ethers.constants.MaxUint256);

    return { owner, relayer, trader, other, factory, pool, pool2, token0, token1, traderBalance };
  }

  async function swapParams(pool, trader, amountIn) {
    const latest = await ethers.provider.getBlock("latest");
    return {
      pool: pool.address,
      trader: trader.address,
      zeroForOne: true,
      amountSpecified: amountIn.toString(),
      sqrtPriceLimitX96: "4295128740", // MIN_SQRT_RATIO + 1
      deadline: (latest.timestamp + 3600).toString(),
      nonce: "0"
    };
  }

  describe("Factory pool deployment (C6)", function () {
    it("Should deploy a pool that actually has code behind it", async function () {
      const { factory, pool, token0, token1 } = await loadFixture(deployFixture);

      const code = await ethers.provider.getCode(pool.address);
      expect(code).to.not.equal("0x");
      expect(code.length).to.be.greaterThan(100);

      expect(await factory.getPool(token0.address, token1.address, FEE_TIER)).to.equal(pool.address);
      expect(await pool.factory()).to.equal(factory.address);
      expect(await pool.token0()).to.equal(token0.address);
      expect(await pool.token1()).to.equal(token1.address);
      expect(await pool.fee()).to.equal(FEE_TIER);
      expect(await pool.tickSpacing()).to.equal(TICK_SPACING);
    });

    it("Should refuse to create the same pool twice", async function () {
      const { factory, token0, token1 } = await loadFixture(deployFixture);
      await expect(
        factory.createPool(token0.address, token1.address, FEE_TIER)
      ).to.be.revertedWith("Pool already exists");
    });
  });

  describe("Gasless swap authorisation (C1)", function () {
    it("Should reject a swap the trader never signed", async function () {
      const { pool, relayer, trader, token0, token1, traderBalance } = await loadFixture(deployFixture);

      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      // 65 bytes of 0x11 -- the exact probe that used to drain an approved balance.
      const forged = "0x" + "11".repeat(65);

      const bal0Before = await token0.balanceOf(trader.address);
      const bal1Before = await token1.balanceOf(trader.address);

      await expect(
        pool.connect(relayer).gaslessSwap({ ...params, signature: forged })
      ).to.be.reverted;

      // The trader's balances must be untouched.
      expect(await token0.balanceOf(trader.address)).to.equal(bal0Before);
      expect(await token1.balanceOf(trader.address)).to.equal(bal1Before);
      expect(bal0Before).to.equal(traderBalance);
    });

    it("Should reject a signature made by someone other than the trader", async function () {
      const { pool, relayer, trader, other, token0 } = await loadFixture(deployFixture);

      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      // `other` signs a payload that claims `trader` as its author.
      const signature = await signGaslessSwap(other, pool, params);

      const bal0Before = await token0.balanceOf(trader.address);
      await expect(
        pool.connect(relayer).gaslessSwap({ ...params, signature })
      ).to.be.revertedWith("Invalid signature");
      expect(await token0.balanceOf(trader.address)).to.equal(bal0Before);
    });

    it("Should reject a swap from a caller that is not an authorized relayer", async function () {
      const { pool, other, trader } = await loadFixture(deployFixture);
      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      const signature = await signGaslessSwap(trader, pool, params);

      await expect(
        pool.connect(other).gaslessSwap({ ...params, signature })
      ).to.be.revertedWith("Not authorized relayer");
    });

    it("Should execute a correctly signed swap and advance the nonce", async function () {
      const { pool, relayer, trader } = await loadFixture(deployFixture);

      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      expect(await pool.traderNonces(trader.address)).to.equal(0);

      const signature = await signGaslessSwap(trader, pool, params);
      await pool.connect(relayer).gaslessSwap({ ...params, signature });

      expect(await pool.traderNonces(trader.address)).to.equal(1);
    });

    it("Should refuse to replay the same signature", async function () {
      const { pool, relayer, trader } = await loadFixture(deployFixture);

      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      const signature = await signGaslessSwap(trader, pool, params);

      await pool.connect(relayer).gaslessSwap({ ...params, signature });
      await expect(
        pool.connect(relayer).gaslessSwap({ ...params, signature })
      ).to.be.revertedWith("Invalid nonce");
    });

    it("Should refuse an expired swap", async function () {
      const { pool, relayer, trader } = await loadFixture(deployFixture);

      const params = await swapParams(pool, trader, ethers.utils.parseEther("0.001"));
      params.deadline = "1"; // long past
      const signature = await signGaslessSwap(trader, pool, params);

      await expect(
        pool.connect(relayer).gaslessSwap({ ...params, signature })
      ).to.be.revertedWith("Swap expired");
    });
  });

  describe("Pool-bound signatures (C7)", function () {
    it("Should reject a signature bound to a different pool", async function () {
      const { pool, pool2, relayer, trader } = await loadFixture(deployFixture);

      // Signed for pool2, submitted to pool.
      const params = await swapParams(pool2, trader, ethers.utils.parseEther("0.001"));
      const signature = await signGaslessSwap(trader, pool2, params);

      await expect(
        pool.connect(relayer).gaslessSwap({ ...params, signature })
      ).to.be.revertedWith("Wrong pool");
    });
  });

  describe("Swap executes once (C2)", function () {
    it("Should move exactly the amounts reported by the Swap event", async function () {
      const { pool, owner, token0, token1 } = await loadFixture(deployFixture);

      const amountIn = ethers.utils.parseEther("0.001");
      const bal0Before = await token0.balanceOf(owner.address);
      const bal1Before = await token1.balanceOf(owner.address);

      const tx = await pool.connect(owner).swap({
        zeroForOne: true,
        amountSpecified: amountIn,
        sqrtPriceLimitX96: ethers.BigNumber.from("4295128740"),
        data: "0x"
      });
      const receipt = await tx.wait();
      const event = receipt.events.find((e) => e.event === "Swap");
      expect(event, "Swap event").to.not.be.undefined;

      const delta0 = (await token0.balanceOf(owner.address)).sub(bal0Before);
      const delta1 = (await token1.balanceOf(owner.address)).sub(bal1Before);

      // The event must describe exactly what moved. Under the duplicated
      // implementation the balances moved 2x the reported amounts.
      expect(delta0.abs()).to.equal(event.args.amount0.abs());
      expect(delta1.abs()).to.equal(event.args.amount1.abs());
      expect(delta0.isZero() && delta1.isZero()).to.equal(false);
    });
  });
});

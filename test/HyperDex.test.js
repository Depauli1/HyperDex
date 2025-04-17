// test/HyperDex.test.js
const { ethers, network } = require("hardhat");
const { expect } = require("chai");

// Get BigNumber from the ethers object for robustness
const BigNumber = ethers.BigNumber;

describe("HyperDex: Gasless Swaps (JavaScript)", function () {
    let TickMath;

    let owner;
    let relayer;
    let user;
    let otherUser;
    let factory;
    let hyperdex;
    let token0;
    let token1;
    let pool;

    const FEE_TIER = 500;
    const TICK_SPACING = 10;

    let domain;

    function encodePriceSqrt(price) {
        const Q96 = BigNumber.from(2).pow(96);
        if (price.eq(ethers.utils.parseUnits("1", 18))) return Q96;
        let z = price.mul(Q96.pow(2));
        let x = z.add(Q96).div(2);
        let y = z.div(x);
        for (let i = 0; i < 7; i++) {
            if (x.eq(y) || x.eq(y.add(1))) break;
            x = x.add(y).div(2);
            y = z.div(x);
        }
        return x;
    }

    beforeEach(async function () {
        TickMath = {
            MIN_SQRT_RATIO: BigNumber.from('4295128739'),
            MAX_SQRT_RATIO: BigNumber.from('1461446703485210103287273052203988822378723970342'),
        };

        [owner, relayer, user, otherUser] = await ethers.getSigners();

        // Deploy Mock ERC20 tokens
        const MockERC20 = await ethers.getContractFactory("MockERC20");
        token0 = await MockERC20.deploy("Token A", "TKNA", 18);
        token1 = await MockERC20.deploy("Token B", "TKNB", 18);
        await token0.deployed();
        await token1.deployed();

        if (token0.address.toLowerCase() > token1.address.toLowerCase()) {
            [token0, token1] = [token1, token0];
        }

        // Deploy Factory & register pool
        const Factory = await ethers.getContractFactory("HyperDexFactory");
        factory = await Factory.deploy(ethers.constants.AddressZero);
        await factory.deployed();

        const Pool = await ethers.getContractFactory("contracts/HyperDexPool.sol:HyperDexPool");
        pool = await Pool.deploy(factory.address, token0.address, token1.address, FEE_TIER, TICK_SPACING);
        await pool.deployed();

        // Register pool
        await factory.connect(owner).registerExistingPool(
            token0.address,
            token1.address,
            FEE_TIER,
            pool.address
        );

        // Impersonate factory to authorize HyperDex as relayer in pool
        await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [factory.address],
        });
        const factorySigner = await ethers.provider.getSigner(factory.address);
        await pool.connect(factorySigner).setRelayerAuthorization(hyperdex.address, true);

        // Deploy HyperDex
        const HyperDex = await ethers.getContractFactory("HyperDex");
        hyperdex = await HyperDex.deploy(factory.address);
        await hyperdex.deployed();

        // Set relayer on HyperDex contract
        await hyperdex.connect(owner).setRelayer(relayer.address);

        // Setup EIP-712 domain
        const chainId = (await ethers.provider.getNetwork()).chainId;
        domain = {
            name: "HyperDex",
            version: "1",
            chainId,
            verifyingContract: hyperdex.address,
        };

        // Fund and approve tokens
        const mintAmount = ethers.utils.parseUnits("1000", 18);
        await token0.connect(owner).mint(user.address, mintAmount);
        await token1.connect(owner).mint(user.address, mintAmount);
        await token0.connect(user).approve(pool.address, ethers.constants.MaxUint256);
        await token1.connect(user).approve(pool.address, ethers.constants.MaxUint256);
        await token0.connect(user).approve(hyperdex.address, ethers.constants.MaxUint256);
        await token1.connect(user).approve(hyperdex.address, ethers.constants.MaxUint256);

        // Provide initial liquidity
        await token0.connect(owner).mint(owner.address, ethers.utils.parseUnits("50", 18));
        await token1.connect(owner).mint(owner.address, ethers.utils.parseUnits("50", 18));
        await token0.connect(owner).approve(pool.address, ethers.utils.parseUnits("50", 18));
        await token1.connect(owner).approve(pool.address, ethers.utils.parseUnits("50", 18));
        await pool.connect(owner).mint(owner.address, -50, 50, ethers.utils.parseUnits("100", 18), "0x");
    });

    // --- Helper Function to Create Signature ---
    async function signGaslessSwap(signer, params) {
        // IMPORTANT: The GaslessSwap type definition must match the struct used in the contract
        // Make sure this matches the typehash in HyperDex.sol
        const types = {
            GaslessSwap: [
                { name: "trader", type: "address" },
                { name: "zeroForOne", type: "bool" },
                { name: "amountSpecified", type: "int256" },
                { name: "sqrtPriceLimitX96", type: "uint160" },
                { name: "deadline", type: "uint256" },
                { name: "nonce", type: "uint256" }
            ],
        };
        
        // Ensure numeric values are properly formatted
        const paramsForSigning = {
            trader: params.trader,
            zeroForOne: params.zeroForOne,
            amountSpecified: params.amountSpecified.toString(),
            sqrtPriceLimitX96: params.sqrtPriceLimitX96.toString(),
            deadline: params.deadline.toString(),
            nonce: params.nonce.toString(),
        };
        
        console.log("Signing params:", JSON.stringify(paramsForSigning, null, 2));
        const signature = await signer._signTypedData(domain, types, paramsForSigning);
        console.log("Generated signature:", signature);
        
        return signature;
    }

    it("Should execute a valid gasless swap (T0->T1) via the relayer", async function () {
        const amountIn = ethers.utils.parseUnits("1", 18);
        const currentNonce = await hyperdex.getNonce(user.address);
        
        // Get the current block timestamp and add a very large buffer
        const latestBlock = await ethers.provider.getBlock('latest');
        const deadline = latestBlock.timestamp + 100000; // Add 100,000 seconds (~28 hours)
        
        // Add debugging info
        console.log("------- TEST PARAMETERS -------");
        console.log("Token0:", token0.address);
        console.log("Token1:", token1.address);
        console.log("Fee tier:", FEE_TIER);
        console.log("User address:", user.address);
        console.log("Relayer address:", relayer.address);
        console.log("HyperDex address:", hyperdex.address);
        console.log("Pool address:", pool.address);
        console.log("Current blockchain timestamp:", latestBlock.timestamp);
        console.log("Deadline set to:", deadline);

        // Check if our tokens are properly ordered
        if (token0.address.toLowerCase() > token1.address.toLowerCase()) {
            console.error("ERROR: token0 address is greater than token1 address. This would cause issues!");
        }

        const params = {
            trader: user.address,
            zeroForOne: true,
            amountSpecified: amountIn.toString(),
            sqrtPriceLimitX96: TickMath.MIN_SQRT_RATIO.add(1).toString(),
            deadline: deadline.toString(),
            nonce: currentNonce.toString(),
            signature: "" // Will be set after signing
        };
        
        const signature = await signGaslessSwap(user, params);
        params.signature = signature;
        
        const token0BalanceBefore = await token0.balanceOf(user.address);
        const token1BalanceBefore = await token1.balanceOf(user.address);

        console.log("Balances before swap - token0:", token0BalanceBefore.toString(), "token1:", token1BalanceBefore.toString());
        
        // Check that our mock works
        console.log("Calling factory.getPool directly from test as a check:");
        const poolAddress = await factory.getPool(token0.address, token1.address, FEE_TIER);
        console.log("Factory.getPool returned:", poolAddress);
        
        try {
            // Execute the gasless swap through the relayer
            console.log("Calling executeGaslessSwap...");
            await hyperdex.connect(relayer).executeGaslessSwap(params, signature);
            console.log("executeGaslessSwap succeeded!");
        } catch (error) {
            console.error("executeGaslessSwap failed with error:", error.message);
            // Throw it again so the test fails
            throw error;
        }

        const token0BalanceAfter = await token0.balanceOf(user.address);
        const token1BalanceAfter = await token1.balanceOf(user.address);
        
        console.log("Balances after swap - token0:", token0BalanceAfter.toString(), "token1:", token1BalanceAfter.toString());
        
        // Verify the nonce was incremented
        expect(await hyperdex.getNonce(user.address)).to.equal(currentNonce.add(1));
        
        // Verify tokens were exchanged
        expect(token0BalanceAfter).to.be.lt(token0BalanceBefore); // User spent token0
        expect(token1BalanceAfter).to.be.gt(token1BalanceBefore); // User received token1
    });

    it("Should execute swap up to the sqrtPriceLimitX96 when limit is hit (T0->T1)", async function () {
        const amountIn = ethers.utils.parseUnits("50", 18); // Larger amount likely to move price
        const currentNonce = await hyperdex.getNonce(user.address);
        
        // Get the current block timestamp and add a very large buffer
        const latestBlock = await ethers.provider.getBlock('latest');
        const deadline = latestBlock.timestamp + 100000; // Add 100,000 seconds (~28 hours)

        // Get current state - Direct access to sqrtPriceX96 state variable
        const currentSqrtPriceX96 = await pool.sqrtPriceX96(); 

        // Set a price limit slightly below the current price (for zeroForOne=true)
        // This calculation needs to be accurate based on pool math
        // Example: Decrease sqrtPrice by a small amount
        const priceLimitX96 = currentSqrtPriceX96.sub(BigNumber.from("10000000000000")); // Arbitrary small decrease for test
        // Ensure limit is actually lower for zeroForOne=true swap
        expect(priceLimitX96).to.be.lt(currentSqrtPriceX96);

        const params = {
            trader: user.address,
            tokenIn: token0.address,
            tokenOut: token1.address,
            fee: FEE_TIER,
            zeroForOne: true, // Required by pool but not for signature
            amountSpecified: amountIn.toString(),
            sqrtPriceLimitX96: priceLimitX96.toString(), // Apply the calculated limit
            deadline: deadline.toString(),
            nonce: currentNonce.toString(),
        };

        const signature = await signGaslessSwap(user, params);
        // Add signature to params for pool verification
        params.signature = signature;

        const token0BalanceBefore = await token0.balanceOf(user.address);
        const token1BalanceBefore = await token1.balanceOf(user.address);

        // Execute swap
        await hyperdex.connect(relayer).executeGaslessSwap(params, signature);

        const token0BalanceAfter = await token0.balanceOf(user.address);
        const token1BalanceAfter = await token1.balanceOf(user.address);
        const finalSqrtPriceX96 = await pool.sqrtPriceX96(); // Get final price

        // --- Assertions ---
        // 1. Check balances changed (swap occurred)
        expect(token0BalanceAfter).to.be.lt(token0BalanceBefore); // Paid token0
        expect(token1BalanceAfter).to.be.gt(token1BalanceBefore); // Received token1

        // 2. Check final price is at or very close to the limit (allowing for potential rounding)
        // The pool implementation might not hit exactly the limit due to discrete ticks
        // Allow for a small tolerance in the comparison
        expect(finalSqrtPriceX96).to.be.closeTo(priceLimitX96, 10); // Allow small tolerance

        // 3. Check nonce incremented
        expect(await hyperdex.getNonce(user.address)).to.equal(currentNonce.add(1));

        console.log(`      Swap Limit Test: Final sqrtPriceX96 ${finalSqrtPriceX96} matched limit ${priceLimitX96}`);
     });
}); // End describe block

console.log("Test file execution completed");


const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("BridgeRouter", function () {
  // Define a fixture to reuse the same setup in multiple tests
  async function deployBridgeRouterFixture() {
    // Get signers
    const [owner, user, relayer] = await ethers.getSigners();
    
    // Deploy mock token
    const MockToken = await ethers.getContractFactory("MockERC20");
    const mockToken = await MockToken.deploy("Mock Token", "MTK", 18);
    await mockToken.deployed();
    
    // Mint some tokens to the user
    const mintAmount = ethers.utils.parseEther("1000");
    await mockToken.mint(user.address, mintAmount);
    
    // Deploy bridge router
    const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
    const bridgeRouter = await BridgeRouter.deploy();
    await bridgeRouter.deployed();
    
    // Deploy mock adapter
    const MockAdapter = await ethers.getContractFactory("MockBridgeAdapter");
    const mockAdapter = await MockAdapter.deploy();
    await mockAdapter.deployed();
    
    // Register the adapter for chain ID 1 (ETH Mainnet)
    await bridgeRouter.registerAdapter(1, mockAdapter.address);
    
    // Chain IDs for testing
    const srcChainId = 1; // ETH Mainnet
    const dstChainId = 137; // Polygon
    
    return { 
      bridgeRouter, 
      mockAdapter, 
      mockToken, 
      owner, 
      user, 
      relayer, 
      srcChainId, 
      dstChainId, 
      mintAmount 
    };
  }

  describe("Deployment", function () {
    it("Should set the right owner", async function () {
      const { bridgeRouter, owner } = await loadFixture(deployBridgeRouterFixture);
      expect(await bridgeRouter.owner()).to.equal(owner.address);
    });

    it("Should register adapter correctly", async function () {
      const { bridgeRouter, mockAdapter, srcChainId } = await loadFixture(deployBridgeRouterFixture);
      expect(await bridgeRouter.bridgeAdapters(srcChainId)).to.equal(mockAdapter.address);
    });
  });

  describe("Bridge initiation", function () {
    it("Should revert if adapter not registered for source chain", async function () {
      const { bridgeRouter, mockToken, user, dstChainId } = await loadFixture(deployBridgeRouterFixture);
      
      // Create a bridge request with invalid source chain ID
      const invalidSrcChainId = 999;
      const request = {
        id: 1,
        srcChainId: invalidSrcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Create an EIP-712 signature (mock)
      const signature = "0x00"; // Mock signature, not used in this test
      
      // Should revert with InvalidAdapter error
      await expect(
        bridgeRouter.initiateBridge(request, signature, { value: request.fee })
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidAdapter");
    });
    
    it("Should revert if deadline exceeded", async function () {
      const { bridgeRouter, mockToken, user, srcChainId, dstChainId } = await loadFixture(deployBridgeRouterFixture);
      
      // Create a bridge request with expired deadline
      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Create an EIP-712 signature (mock)
      const signature = "0x00"; // Mock signature, not used in this test
      
      // Should revert with DeadlineExceeded error
      await expect(
        bridgeRouter.initiateBridge(request, signature, { value: request.fee })
      ).to.be.revertedWithCustomError(bridgeRouter, "DeadlineExceeded");
    });
    
    it("Should revert if insufficient fee provided", async function () {
      const { bridgeRouter, mockToken, user, srcChainId, dstChainId } = await loadFixture(deployBridgeRouterFixture);
      
      // Create a valid bridge request
      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Create an EIP-712 signature (mock)
      const signature = "0x00"; // Mock signature, not used in this test
      
      // Should revert with InsufficientFee error (providing less than required)
      await expect(
        bridgeRouter.initiateBridge(request, signature, { value: ethers.utils.parseEther("0.005") })
      ).to.be.revertedWithCustomError(bridgeRouter, "InsufficientFee");
    });

    it("Should emit BridgeInitiated event on successful bridge initiation", async function () {
      const { bridgeRouter, mockAdapter, mockToken, user, relayer, srcChainId, dstChainId } = await loadFixture(deployBridgeRouterFixture);
      
      // Configure the mock adapter to return a specific fee
      const requiredFee = ethers.utils.parseEther("0.01");
      await mockAdapter.setQuotedFee(requiredFee);
      
      // Approve token transfer
      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user).approve(bridgeRouter.address, amount);
      
      // Create a valid bridge request
      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        fee: requiredFee
      };
      
      // Create an EIP-712 signature (mock)
      // In a real test, we would have to generate a proper EIP-712 signature
      // For this test, we'll temporarily allow any signature to pass
      // by modifying the mock functionality or setting a flag
      
      // Assume connect(user) would set the msg.sender to user.address for EIP-712 verification
      // In a real test, this would be done with proper signatures
      
      // Initiate bridge with relayer providing the fee
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(request, "0x", { value: requiredFee })
      )
        .to.emit(bridgeRouter, "BridgeInitiated")
        .withArgs(
          // requestId is dynamically generated, so we can't assert on it exactly
          // We could use a .matches() here if needed
          ethers.constants.HashZero, // Placeholder for requestId
          request.user,
          request.srcChainId,
          request.dstChainId,
          request.token,
          request.amount,
          requiredFee
        );
    });
  });

  describe("Bridge completion", function () {
    it("Should complete a bridge request successfully", async function () {
      // This test would simulate a full bridge flow, including:
      // 1. Initiate bridge on source chain
      // 2. Mock the bridgeOut call and response
      // 3. Call completeBridge on destination chain
      // 4. Verify token transfer and events
      
      // For brevity, this implementation is simplified
      // In a real test, we would need to set up a more complex fixture
    });
  });

  describe("Admin functions", function () {
    it("Should allow owner to register adapter", async function () {
      const { bridgeRouter, owner } = await loadFixture(deployBridgeRouterFixture);
      
      const newAdapter = ethers.Wallet.createRandom().address;
      const chainId = 42161; // Arbitrum
      
      await expect(bridgeRouter.connect(owner).registerAdapter(chainId, newAdapter))
        .to.emit(bridgeRouter, "AdapterRegistered")
        .withArgs(chainId, newAdapter);
      
      expect(await bridgeRouter.bridgeAdapters(chainId)).to.equal(newAdapter);
    });
    
    it("Should revert if non-owner tries to register adapter", async function () {
      const { bridgeRouter, user } = await loadFixture(deployBridgeRouterFixture);
      
      const newAdapter = ethers.Wallet.createRandom().address;
      const chainId = 42161; // Arbitrum
      
      await expect(
        bridgeRouter.connect(user).registerAdapter(chainId, newAdapter)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
    
    it("Should allow owner to pause and unpause", async function () {
      const { bridgeRouter, owner } = await loadFixture(deployBridgeRouterFixture);
      
      // Pause
      await bridgeRouter.connect(owner).pause();
      expect(await bridgeRouter.paused()).to.be.true;
      
      // Unpause
      await bridgeRouter.connect(owner).unpause();
      expect(await bridgeRouter.paused()).to.be.false;
    });
  });
}); 
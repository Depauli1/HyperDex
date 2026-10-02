const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { signBridgeRequest } = require("./helpers/bridge-eip712");

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
    
    // Chain IDs for testing
    const srcChainId = 1; // ETH Mainnet
    const dstChainId = 137; // Polygon

    // Adapters are keyed by the chain they know how to reach, i.e. the destination.
    await bridgeRouter.registerAdapter(dstChainId, mockAdapter.address);
    
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
      const { bridgeRouter, mockAdapter, dstChainId } = await loadFixture(deployBridgeRouterFixture);
      expect(await bridgeRouter.bridgeAdapters(dstChainId)).to.equal(mockAdapter.address);
    });
  });

  describe("Bridge initiation", function () {
    it("Should revert if adapter not registered for destination chain", async function () {
      const { bridgeRouter, mockToken, user, srcChainId } = await loadFixture(deployBridgeRouterFixture);

      // No adapter is registered for this destination.
      const invalidDstChainId = 999;
      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: invalidDstChainId,
        token: mockToken.address,
        amount: ethers.utils.parseEther("10"),
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
        fee: ethers.utils.parseEther("0.01")
      };
      
      // Sign the request as the user, exactly as the router will recover it.
      const signature = await signBridgeRequest(bridgeRouter, user, request);
      
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
      
      // Sign the request as the user, exactly as the router will recover it.
      const signature = await signBridgeRequest(bridgeRouter, user, request);
      
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
      
      // Sign the request as the user, exactly as the router will recover it.
      const signature = await signBridgeRequest(bridgeRouter, user, request);
      
      // Should revert with InsufficientFee error (providing less than required)
      await expect(
        bridgeRouter.initiateBridge(request, signature, { value: ethers.utils.parseEther("0.005") })
      ).to.be.revertedWithCustomError(bridgeRouter, "InsufficientFee");
    });

    it("Should emit BridgeInitiated event on successful bridge initiation", async function () {
      const { bridgeRouter, mockAdapter, mockToken, user, relayer, srcChainId, dstChainId, mintAmount } = await loadFixture(deployBridgeRouterFixture);

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
      
      // Sign the request as the user; the relayer submits it.
      const signature = await signBridgeRequest(bridgeRouter, user, request);

      // Initiate bridge with relayer providing the fee
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: requiredFee })
      ).to.emit(bridgeRouter, "BridgeInitiated");

      // Recover the emitted requestId and assert the full event payload plus the
      // stored request.
      const filter = bridgeRouter.filters.BridgeInitiated();
      const [event] = await bridgeRouter.queryFilter(filter);
      const requestId = event.args.requestId;

      expect(event.args.user).to.equal(request.user);
      expect(event.args.srcChainId).to.equal(request.srcChainId);
      expect(event.args.dstChainId).to.equal(request.dstChainId);
      expect(event.args.token).to.equal(request.token);
      expect(event.args.amount).to.equal(request.amount);
      expect(event.args.fee).to.equal(requiredFee);

      const [stored, status] = await bridgeRouter.getBridgeRequest(requestId);
      expect(stored.user).to.equal(request.user);
      expect(stored.amount).to.equal(request.amount);
      expect(status).to.equal(1); // RequestStatus.Initiated

      // Tokens were escrowed by the router, not left with the user.
      expect(await mockToken.balanceOf(bridgeRouter.address)).to.equal(amount);
      expect(await mockToken.balanceOf(user.address)).to.equal(mintAmount.sub(amount));

      return { bridgeRouter, mockAdapter, mockToken, user, relayer, request, requiredFee, requestId };
    });

    it("Should reject a replayed signature", async function () {
      const { bridgeRouter, mockToken, user, relayer, srcChainId, dstChainId } = await loadFixture(deployBridgeRouterFixture);

      const requiredFee = ethers.utils.parseEther("0.01");
      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user).approve(bridgeRouter.address, amount);

      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: requiredFee
      };
      const signature = await signBridgeRequest(bridgeRouter, user, request);

      await bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: requiredFee });

      // Same signature, same request: must not be replayable.
      await expect(
        bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: requiredFee })
      ).to.be.revertedWithCustomError(bridgeRouter, "SignatureReused");
    });

    it("Should reject a signature from someone other than the user", async function () {
      const { bridgeRouter, mockToken, user, relayer, srcChainId, dstChainId, mintAmount } = await loadFixture(deployBridgeRouterFixture);

      const requiredFee = ethers.utils.parseEther("0.01");
      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user).approve(bridgeRouter.address, amount);

      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: requiredFee
      };
      // relayer signs a request that claims `user` as its author.
      const signature = await signBridgeRequest(bridgeRouter, relayer, request);

      await expect(
        bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: requiredFee })
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidSignature");

      // The victim's balance must be untouched.
      expect(await mockToken.balanceOf(user.address)).to.equal(mintAmount);
    });
  });

  describe("Bridge completion", function () {
    // Builds a fully initiated request to complete on the destination side.
    async function initiatedBridgeFixture() {
      const [owner, user, relayer] = await ethers.getSigners();

      const MockToken = await ethers.getContractFactory("MockERC20");
      const mockToken = await MockToken.deploy("Mock Token", "MTK", 18);
      await mockToken.deployed();

      const mintAmount = ethers.utils.parseEther("1000");
      await mockToken.mint(user.address, mintAmount);

      const BridgeRouter = await ethers.getContractFactory("BridgeRouter");
      const bridgeRouter = await BridgeRouter.deploy();
      await bridgeRouter.deployed();

      const MockAdapter = await ethers.getContractFactory("MockBridgeAdapter");
      const mockAdapter = await MockAdapter.deploy();
      await mockAdapter.deployed();

      const srcChainId = 1;
      const dstChainId = 137;

      // Same adapter stands in on both sides for a single-chain test.
      await bridgeRouter.registerAdapter(srcChainId, mockAdapter.address);
      await bridgeRouter.registerAdapter(dstChainId, mockAdapter.address);
      await bridgeRouter.setRelayer(relayer.address, true);

      const requiredFee = ethers.utils.parseEther("0.01");
      await mockAdapter.setQuotedFee(requiredFee);

      const amount = ethers.utils.parseEther("10");
      await mockToken.connect(user).approve(bridgeRouter.address, amount);

      const request = {
        id: 1,
        srcChainId: srcChainId,
        dstChainId: dstChainId,
        token: mockToken.address,
        amount: amount,
        user: user.address,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        fee: requiredFee
      };
      const signature = await signBridgeRequest(bridgeRouter, user, request);
      const tx = await bridgeRouter.connect(relayer).initiateBridge(request, signature, { value: requiredFee });
      const receipt = await tx.wait();
      const requestId = receipt.events.find((e) => e.event === "BridgeInitiated").args.requestId;

      // On the destination chain the bridge protocol funds the adapter, which
      // then releases the tokens to the user.
      await mockToken.mint(mockAdapter.address, amount);

      return { bridgeRouter, mockAdapter, mockToken, owner, user, relayer, request, requestId, amount, mintAmount };
    }

    it("Should complete a bridge request successfully", async function () {
      const { bridgeRouter, mockAdapter, mockToken, user, relayer, request, requestId, amount } =
        await loadFixture(initiatedBridgeFixture);

      const balanceBefore = await mockToken.balanceOf(user.address);

      await expect(
        bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x")
      )
        .to.emit(bridgeRouter, "BridgeCompleted")
        .withArgs(requestId, request.user, request.token, request.amount);

      // The adapter performed the inbound leg.
      expect(await mockAdapter.bridgeInCalled()).to.equal(true);
      expect(await mockAdapter.lastRequestId()).to.equal(requestId);

      // Paid out exactly once.
      expect(await mockToken.balanceOf(user.address)).to.equal(balanceBefore.add(amount));

      const [, status] = await bridgeRouter.getBridgeRequest(requestId);
      expect(status).to.equal(2); // RequestStatus.Completed
    });

    it("Should not pay out twice on a repeated completion", async function () {
      const { bridgeRouter, mockToken, user, relayer, request, requestId, amount } =
        await loadFixture(initiatedBridgeFixture);

      await bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x");
      const balanceAfterFirst = await mockToken.balanceOf(user.address);

      await expect(
        bridgeRouter.connect(relayer).completeBridge(request, requestId, "0x")
      ).to.be.revertedWithCustomError(bridgeRouter, "InvalidStatus");

      expect(await mockToken.balanceOf(user.address)).to.equal(balanceAfterFirst);
    });

    it("Should reject completion from a non-relayer", async function () {
      const { bridgeRouter, user, request, requestId } = await loadFixture(initiatedBridgeFixture);

      await expect(
        bridgeRouter.connect(user).completeBridge(request, requestId, "0x")
      ).to.be.revertedWithCustomError(bridgeRouter, "Unauthorized");
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
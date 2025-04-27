// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
pragma abicoder v2;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/math/SafeMath.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "./vendor/TickMath.sol";
import "./vendor/FullMath.sol";
import "./vendor/FixedPoint96.sol";
import "./vendor/BitMath.sol";

// Define an interface for ERC20 metadata to get decimals
interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

/**
 * @title HyperDexPool
 * @author HyperDex Team
 * @notice Implementation of concentrated liquidity pool with Hyperliquid-specific optimizations
 * @dev Enhanced version with gasless operations, auto-rebalancing, and real-time analytics
 */
contract HyperDexPool is ReentrancyGuard {
    using SafeERC20 for IERC20;
    
    // Pool constants
    address public immutable factory;
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;
    int24 public immutable tickSpacing;
    
    // Current pool state
    uint160 public sqrtPriceX96;
    int24 public currentTick;
    uint128 public liquidity;
    
    // Fee accounting
    uint256 public feeGrowthGlobal0X128;
    uint256 public feeGrowthGlobal1X128;
    uint256 public protocolFeesCollected0;
    uint256 public protocolFeesCollected1;
    
    // Last observation for TWAPs
    uint32 public blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;
    
    // Tick state organized for efficient access
    mapping(int24 => Tick) public ticks;
    mapping(int24 => int24) public nextInitializedTick;
    
    // Position management
    mapping(bytes32 => Position) public positions;
    
    // Hyperliquid-specific: Analytics tracking
    uint256 public totalValueLocked;
    uint256 public volume24h;
    uint256 public volumeAllTime;
    uint32 public swapCount24h;
    uint32 public lastAnalyticsUpdate;
    
    // Hyperliquid-specific: Auto-rebalancing settings
    bool public autoRebalancingEnabled;
    uint32 public rebalanceThresholdBps = 500; // 5% price movement triggers rebalance
    uint32 public lastRebalanceTimestamp;
    
    // Hyperliquid-specific: Gasless operations
    mapping(address => bool) public authorizedRelayers;
    mapping(bytes32 => bool) public executedMetaTxs;
    uint256 public metaTxNonce;
    
    // Structs
    struct Tick {
        bool initialized;
        uint128 liquidityGross;
        int128 liquidityNet;
        uint256 feeGrowthOutside0X128;
        uint256 feeGrowthOutside1X128;
        int56 tickCumulativeOutside;
        uint160 secondsPerLiquidityOutsideX128;
        uint32 secondsOutside;
    }
    
    struct Position {
        uint128 liquidity;
        uint256 feeGrowthInside0LastX128;
        uint256 feeGrowthInside1LastX128;
        uint128 tokensOwed0;
        uint128 tokensOwed1;
        int24 tickLower;
        int24 tickUpper;
        uint32 lastUpdateTimestamp;
    }
    
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        bytes data;
    }
    
    struct GaslessSwapParams {
        address trader;
        bool zeroForOne;
        int256 amountSpecified;
        uint160 sqrtPriceLimitX96;
        uint256 deadline;
        uint256 nonce;
        bytes signature;
    }
    
    // Events
    event Initialize(uint160 sqrtPriceX96);
    event Mint(
        address indexed sender,
        address indexed owner,
        int24 indexed tickLower,
        int24 tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    event Burn(
        address indexed owner,
        int24 indexed tickLower,
        int24 tickUpper,
        uint128 amount,
        uint256 amount0,
        uint256 amount1
    );
    event Swap(
        address indexed sender,
        address indexed recipient,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96,
        uint128 liquidity,
        int24 tick
    );
    event GaslessSwap(
        address indexed trader,
        address indexed relayer,
        int256 amount0,
        int256 amount1,
        uint160 sqrtPriceX96
    );
    event CollectProtocol(
        address indexed recipient,
        uint256 amount0,
        uint256 amount1
    );
    event AutoRebalance(
        int24 oldTick,
        int24 newTick,
        uint160 oldSqrtPriceX96,
        uint160 newSqrtPriceX96
    );
    event AnalyticsUpdated(
        uint256 tvl,
        uint256 volume24h,
        uint32 swapCount24h
    );
    
    /**
     * @notice Constructor initializes pool state
     * @param _factory Factory address
     * @param _token0 First token address
     * @param _token1 Second token address
     * @param _fee Fee tier
     * @param _tickSpacing Spacing between ticks
     */
    constructor(
        address _factory,
        address _token0,
        address _token1,
        uint24 _fee,
        int24 _tickSpacing
    ) {
        factory = _factory;
        token0 = _token0;
        token1 = _token1;
        fee = _fee;
        tickSpacing = _tickSpacing;
        
        // Authorize factory as relayer by default
        authorizedRelayers[_factory] = true;
    }
    
    /**
     * @notice Initialize the pool with first price
     * @param priceX96 Initial price
     */
    function initialize(uint160 priceX96) external {
        require(priceX96 > 0, "Price must be > 0");
        require(priceX96 >= TickMath.MIN_SQRT_RATIO, "Price too low");
        require(priceX96 < TickMath.MAX_SQRT_RATIO, "Price too high");
        require(sqrtPriceX96 == 0, "Already initialized");
        
        // Initial price and tick
        int24 initialTick = TickMath.getTickAtSqrtRatio(priceX96);
        sqrtPriceX96 = priceX96;
        currentTick = initialTick;
        
        // Initialize time tracking
        blockTimestampLast = uint32(block.timestamp);
        lastAnalyticsUpdate = uint32(block.timestamp);
        lastRebalanceTimestamp = uint32(block.timestamp);
        
        emit Initialize(sqrtPriceX96);
    }
    
    /**
     * @notice Mint function - Add liquidity to a position
     * @param recipient Owner of the position
     * @param tickLower Lower tick boundary
     * @param tickUpper Upper tick boundary
     * @param liquidityAmount Liquidity amount to add
     * @return amount0 Token0 amount required
     * @return amount1 Token1 amount required
     */
    function mint(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidityAmount,
        bytes calldata
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(recipient != address(0), "Invalid recipient");
        require(liquidityAmount > 0, "Amount = 0");
        require(tickLower < tickUpper, "Invalid tick range");
        require(tickLower >= TickMath.MIN_TICK, "Tick too low");
        require(tickUpper <= TickMath.MAX_TICK, "Tick too high");
        require(tickLower % tickSpacing == 0, "Lower tick not spaced");
        require(tickUpper % tickSpacing == 0, "Upper tick not spaced");
        
        // Calculate token amounts needed for the requested liquidity
        (amount0, amount1) = _calculateTokenAmounts(tickLower, tickUpper, liquidityAmount);
        
        // Update position
        bytes32 positionKey = keccak256(abi.encodePacked(recipient, tickLower, tickUpper));
        Position storage position = positions[positionKey];
        
        _updateTick(tickLower, liquidityAmount, true);
        _updateTick(tickUpper, liquidityAmount, false);
        
        // Update global liquidity if position is in current price range
        if (tickLower <= currentTick && currentTick < tickUpper) {
            liquidity = liquidity + liquidityAmount;
        }
        
        // Update position state
        (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) = 
            _getFeeGrowthInside(tickLower, tickUpper, currentTick, feeGrowthGlobal0X128, feeGrowthGlobal1X128);
            
        position.liquidity += liquidityAmount;
        position.feeGrowthInside0LastX128 = feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside1X128;
        position.lastUpdateTimestamp = uint32(block.timestamp);
        
        // Update analytics
        _updateTVL();
        
        // Transfer tokens from minter to pool (would use callbacks in production)
        if (amount0 > 0) IERC20(token0).safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(token1).safeTransferFrom(msg.sender, address(this), amount1);
        
        emit Mint(msg.sender, recipient, tickLower, tickUpper, liquidityAmount, amount0, amount1);
        return (amount0, amount1);
    }
    
    /**
     * @notice Remove liquidity from a position
     * @param tickLower Lower tick boundary
     * @param tickUpper Upper tick boundary
     * @param amount Liquidity amount to remove
     * @return amount0 Token0 amount removed
     * @return amount1 Token1 amount removed
     */
    function burn(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) external nonReentrant returns (uint256 amount0, uint256 amount1) {
        require(amount > 0, "Amount = 0");
        
        // Get position
        bytes32 positionKey = keccak256(abi.encodePacked(msg.sender, tickLower, tickUpper));
        Position storage position = positions[positionKey];
        require(position.liquidity >= amount, "Insufficient liquidity");
        
        // Calculate token amounts to return
        (amount0, amount1) = _calculateTokenAmounts(tickLower, tickUpper, amount);
        
        // Update position state
        (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128) = 
            _getFeeGrowthInside(tickLower, tickUpper, currentTick, feeGrowthGlobal0X128, feeGrowthGlobal1X128);
            
        // Compute fees earned
        uint256 tokensOwed0 = position.tokensOwed0 + uint128(
            FullMath.mulDiv(
                feeGrowthInside0X128 - position.feeGrowthInside0LastX128,
                position.liquidity,
                FixedPoint96.Q96
            )
        );
        
        uint256 tokensOwed1 = position.tokensOwed1 + uint128(
            FullMath.mulDiv(
                feeGrowthInside1X128 - position.feeGrowthInside1LastX128,
                position.liquidity,
                FixedPoint96.Q96
            )
        );
        
        // Update position
        position.liquidity -= amount;
        position.feeGrowthInside0LastX128 = feeGrowthInside0X128;
        position.feeGrowthInside1LastX128 = feeGrowthInside1X128;
        position.tokensOwed0 = uint128(tokensOwed0);
        position.tokensOwed1 = uint128(tokensOwed1);
        position.lastUpdateTimestamp = uint32(block.timestamp);
        
        // Update ticks
        _updateTick(tickLower, amount, false);
        _updateTick(tickUpper, amount, true);
        
        // Update global liquidity if position is in current price range
        if (tickLower <= currentTick && currentTick < tickUpper) {
            liquidity = liquidity - amount;
        }
        
        // Update analytics
        _updateTVL();
        
        // Transfer tokens to the burner
        if (amount0 > 0) IERC20(token0).safeTransfer(msg.sender, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(msg.sender, amount1);
        
        emit Burn(msg.sender, tickLower, tickUpper, amount, amount0, amount1);
        return (amount0, amount1);
    }
    
    /**
     * @notice Collect fees accumulated in a position
     * @param recipient Recipient of collected fees
     * @param tickLower Lower tick boundary
     * @param tickUpper Upper tick boundary
     * @param amount0Requested Amount of token0 to collect
     * @param amount1Requested Amount of token1 to collect
     * @return amount0 Actual token0 amount collected
     * @return amount1 Actual token1 amount collected
     */
    function collect(
        address recipient,
        int24 tickLower,
        int24 tickUpper,
        uint128 amount0Requested,
        uint128 amount1Requested
    ) external nonReentrant returns (uint128 amount0, uint128 amount1) {
        require(recipient != address(0), "Invalid recipient");
        
        // Get position
        bytes32 positionKey = keccak256(abi.encodePacked(msg.sender, tickLower, tickUpper));
        Position storage position = positions[positionKey];
        
        // Calculate collectable amounts
        amount0 = amount0Requested > position.tokensOwed0 ? position.tokensOwed0 : amount0Requested;
        amount1 = amount1Requested > position.tokensOwed1 ? position.tokensOwed1 : amount1Requested;
        
        // Update position
        position.tokensOwed0 -= amount0;
        position.tokensOwed1 -= amount1;
        
        // Transfer tokens
        if (amount0 > 0) IERC20(token0).safeTransfer(recipient, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(recipient, amount1);
        
        return (amount0, amount1);
    }
    
    /**
     * @notice Execute a swap in the pool
     * @param params Swap parameters
     * @return amount0 Token0 amount swapped
     * @return amount1 Token1 amount swapped
     */
    function swap(
        SwapParams calldata params
    ) external nonReentrant returns (int256 amount0, int256 amount1) {
        require(params.amountSpecified != 0, "Amount = 0");
        require(params.sqrtPriceLimitX96 > 0, "Invalid price limit");
        
        // Compute swap result based on current state
        (amount0, amount1) = _internalSwap(params, msg.sender);
        
        // Update pool state with new price and tick
        if (params.zeroForOne) {
            sqrtPriceX96 = params.sqrtPriceLimitX96 < sqrtPriceX96 ? params.sqrtPriceLimitX96 : sqrtPriceX96;
        } else {
            sqrtPriceX96 = params.sqrtPriceLimitX96 > sqrtPriceX96 ? params.sqrtPriceLimitX96 : sqrtPriceX96;
        }
        currentTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        
        // Update TWAP accumulators
        uint32 blockTimestamp = uint32(block.timestamp);
        uint32 timeElapsed = blockTimestamp - blockTimestampLast;
        if (timeElapsed > 0) {
            price0CumulativeLast += uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * timeElapsed / 2**192;
            price1CumulativeLast += 2**192 * timeElapsed / (uint256(sqrtPriceX96) * uint256(sqrtPriceX96));
            blockTimestampLast = blockTimestamp;
        }
        
        // Protocol fee calculation
        uint32 protocolFeeBps = IHyperDexFactory(factory).getProtocolFee(address(this));
        
        // Calculate and collect protocol fees
        if (protocolFeeBps > 0) {
            uint256 protocolFee0 = amount0 > 0 ? FullMath.mulDiv(uint256(amount0), protocolFeeBps, 10000) : 0;
            uint256 protocolFee1 = amount1 > 0 ? FullMath.mulDiv(uint256(amount1), protocolFeeBps, 10000) : 0;
            
            protocolFeesCollected0 += protocolFee0;
            protocolFeesCollected1 += protocolFee1;
        }
        
        // Update fee growth accumulators
        if (liquidity > 0) {
            require(liquidity != 0, "Liquidity is zero during fee growth");
            uint256 absAmount0 = amount0 > 0 ? uint256(amount0) : uint256(-amount0);
            uint256 absAmount1 = amount1 > 0 ? uint256(amount1) : uint256(-amount1);
            feeGrowthGlobal0X128 += FullMath.mulDiv(absAmount0, FixedPoint96.Q96, liquidity);
            feeGrowthGlobal1X128 += FullMath.mulDiv(absAmount1, FixedPoint96.Q96, liquidity);
        }
        
        // Update analytics
        _updateSwapAnalytics(amount0);
        
        // Check for auto rebalancing
        if (autoRebalancingEnabled) {
            _checkAndTriggerRebalance();
        }
        
        // Transfer tokens (would use callbacks in production)
        if (amount0 < 0) {
            IERC20(token0).safeTransferFrom(msg.sender, address(this), uint256(-amount0));
        }
        if (amount1 < 0) {
            IERC20(token1).safeTransferFrom(msg.sender, address(this), uint256(-amount1));
        }
        if (amount0 > 0) {
            IERC20(token0).safeTransfer(msg.sender, uint256(amount0));
        }
        if (amount1 > 0) {
            IERC20(token1).safeTransfer(msg.sender, uint256(amount1));
        }
        
        emit Swap(msg.sender, msg.sender, amount0, amount1, sqrtPriceX96, liquidity, currentTick);
        return (amount0, amount1);
    }
    
    /**
     * @notice Execute a gasless swap (via relayer)
     * @param params Gasless swap parameters with signature
     * @return amount0 Token0 amount swapped
     * @return amount1 Token1 amount swapped
     */
    function gaslessSwap(
        GaslessSwapParams calldata params
    ) external nonReentrant returns (int256 amount0, int256 amount1) {
        require(authorizedRelayers[msg.sender], "Not authorized relayer");
        require(block.timestamp <= params.deadline, "Swap expired");
        
        // Verify the swap hasn't been executed already
        bytes32 metaTxId = keccak256(abi.encode(params.trader, params.nonce));
        require(!executedMetaTxs[metaTxId], "Swap already executed");
        executedMetaTxs[metaTxId] = true;
        
        // Execute the swap using the same logic as regular swap
        SwapParams memory swapParams = SwapParams({
            zeroForOne: params.zeroForOne,
            amountSpecified: params.amountSpecified,
            sqrtPriceLimitX96: params.sqrtPriceLimitX96,
            data: ""
        });
        
        (amount0, amount1) = _internalSwap(swapParams, params.trader);
        
        emit GaslessSwap(params.trader, msg.sender, amount0, amount1, sqrtPriceX96);
        return (amount0, amount1);
    }
    
    /**
     * @notice Internal swap implementation
     * @param params Swap parameters
     * @param account Account executing the swap
     * @return amount0 Token0 amount swapped
     * @return amount1 Token1 amount swapped
     */
    function _internalSwap(
        SwapParams memory params,
        address account
    ) private returns (int256 amount0, int256 amount1) {
        require(params.amountSpecified != 0, "Amount = 0");
        require(params.sqrtPriceLimitX96 > 0, "Invalid price limit");
        
        // Current state variables
        uint160 currentSqrtPriceX96 = sqrtPriceX96;
        uint128 currentLiquidity = liquidity;
        
        // --- DEBUGGING: Add checks before swap math ---
        require(currentLiquidity > 0, "No liquidity in pool");
        require(params.amountSpecified != 0, "Amount specified is zero");
        require(
            (params.zeroForOne && params.sqrtPriceLimitX96 < currentSqrtPriceX96) ||
            (!params.zeroForOne && params.sqrtPriceLimitX96 > currentSqrtPriceX96),
            "Invalid sqrtPriceLimitX96 for direction"
        );
        // Defensive: check denominators for mulDiv in _computeSwapStep
        // (We can't check inside FullMath, but we can check before calling)
        // --- END DEBUGGING ---
        (amount0, amount1) = _computeSwapStep(
            currentSqrtPriceX96,
            params.zeroForOne ? 
                (params.sqrtPriceLimitX96 < currentSqrtPriceX96 ? params.sqrtPriceLimitX96 : TickMath.MIN_SQRT_RATIO + 1) : 
                (params.sqrtPriceLimitX96 > currentSqrtPriceX96 ? params.sqrtPriceLimitX96 : TickMath.MAX_SQRT_RATIO - 1),
            currentLiquidity,
            params.amountSpecified,
            params.zeroForOne
        );
        
        // Update pool state
        if (params.zeroForOne) {
            sqrtPriceX96 = params.sqrtPriceLimitX96 < currentSqrtPriceX96 ? params.sqrtPriceLimitX96 : currentSqrtPriceX96;
        } else {
            sqrtPriceX96 = params.sqrtPriceLimitX96 > currentSqrtPriceX96 ? params.sqrtPriceLimitX96 : currentSqrtPriceX96;
        }
        currentTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        
        // Update TWAP accumulators
        uint32 blockTimestamp = uint32(block.timestamp);
        uint32 timeElapsed = blockTimestamp - blockTimestampLast;
        if (timeElapsed > 0) {
            price0CumulativeLast += uint256(sqrtPriceX96) * uint256(sqrtPriceX96) * timeElapsed / 2**192;
            price1CumulativeLast += 2**192 * timeElapsed / (uint256(sqrtPriceX96) * uint256(sqrtPriceX96));
            blockTimestampLast = blockTimestamp;
        }
        
        // Protocol fee calculation
        uint32 protocolFeeBps = IHyperDexFactory(factory).getProtocolFee(address(this));
        // Defensive: protocolFeeBps should not exceed 10000
        require(protocolFeeBps <= 10000, "Protocol fee too high");
        
        // Calculate and collect protocol fees
        if (protocolFeeBps > 0) {
            uint256 protocolFee0 = amount0 > 0 ? FullMath.mulDiv(uint256(amount0), protocolFeeBps, 10000) : 0;
            uint256 protocolFee1 = amount1 > 0 ? FullMath.mulDiv(uint256(amount1), protocolFeeBps, 10000) : 0;
            
            protocolFeesCollected0 += protocolFee0;
            protocolFeesCollected1 += protocolFee1;
        }
        
        // Update fee growth accumulators
        if (liquidity > 0) {
            require(liquidity != 0, "Liquidity is zero during fee growth");
            uint256 absAmount0 = amount0 > 0 ? uint256(amount0) : uint256(-amount0);
            uint256 absAmount1 = amount1 > 0 ? uint256(amount1) : uint256(-amount1);
            feeGrowthGlobal0X128 += FullMath.mulDiv(absAmount0, FixedPoint96.Q96, liquidity);
            feeGrowthGlobal1X128 += FullMath.mulDiv(absAmount1, FixedPoint96.Q96, liquidity);
        }
        
        // Update analytics
        _updateSwapAnalytics(amount0);
        
        // Check for auto rebalancing
        if (autoRebalancingEnabled) {
            _checkAndTriggerRebalance();
        }
        
        // Token transfers for trader
        if (amount0 < 0) {
            IERC20(token0).safeTransferFrom(account, address(this), uint256(-amount0));
        }
        if (amount1 < 0) {
            IERC20(token1).safeTransferFrom(account, address(this), uint256(-amount1));
        }
        if (amount0 > 0) {
            IERC20(token0).safeTransfer(account, uint256(amount0));
        }
        if (amount1 > 0) {
            IERC20(token1).safeTransfer(account, uint256(amount1));
        }
        
        return (amount0, amount1);
    }
    
    /**
     * @notice Hash gasless swap parameters for verification
     * @param params Gasless swap parameters
     * @return digest EIP-712 compatible message hash
     */
    function _hashGaslessSwap(GaslessSwapParams calldata params) private view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("GaslessSwap(address trader,bool zeroForOne,int256 amountSpecified,uint160 sqrtPriceLimitX96,uint256 deadline,uint256 nonce)"),
                params.trader,
                params.zeroForOne,
                params.amountSpecified,
                params.sqrtPriceLimitX96,
                params.deadline,
                params.nonce
            )
        );
        
        bytes32 DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("HyperDexPool"),
                keccak256("1"),
                uint256(31337),
                address(this)
            )
        );
        
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }
    
    /**
     * @notice Verify signature for gasless operations
     * @param signer Address that supposedly signed the message
     * @param digest Message hash
     * @param signature Signature bytes
     * @return True if signature is valid
     */
    function _isValidSignature(
        address signer,
        bytes32 digest,
        bytes memory signature
    ) private pure returns (bool) {
        require(signature.length == 65, "Invalid signature length");
        
        bytes32 r;
        bytes32 s;
        uint8 v;
        
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        
        if (v < 27) {
            v += 27;
        }
        
        address recoveredAddress = ecrecover(digest, v, r, s);
        return recoveredAddress != address(0) && recoveredAddress == signer;
    }
    
    /**
     * @notice Add or remove authorized relayer
     * @param relayer Relayer address
     * @param authorized Status to set
     */
    function setRelayerAuthorization(address relayer, bool authorized) external {
        require(msg.sender == factory, "Only factory can authorize");
        authorizedRelayers[relayer] = authorized;
    }
    
    /**
     * @notice Enable or disable auto rebalancing
     * @param enabled Status to set
     * @param thresholdBps Price movement threshold in basis points
     */
    function setAutoRebalancing(bool enabled, uint32 thresholdBps) external {
        require(msg.sender == factory, "Only factory can set");
        autoRebalancingEnabled = enabled;
        if (thresholdBps > 0) {
            rebalanceThresholdBps = thresholdBps;
        }
    }
    
    /**
     * @notice Check if rebalance is needed and trigger if necessary
     */
    function _checkAndTriggerRebalance() internal {
        // Only check if sufficient time has passed
        uint32 timeSinceLastRebalance = uint32(block.timestamp) - lastRebalanceTimestamp;
        if (timeSinceLastRebalance < 1 hours) return;
        
        // Check price movement
        int24 idealTick = TickMath.getTickAtSqrtRatio(sqrtPriceX96);
        int256 rangeInt = (int256(int32(rebalanceThresholdBps)) * int256(tickSpacing)) / 10000;
        int24 tickRange = int24(rangeInt);
        
        // Skip if current tick is close enough to ideal
        if (idealTick - tickRange <= currentTick && currentTick <= idealTick + tickRange) {
            return;
        }
        
        // Simple rebalancing: update liquidity ranges by shifting ticks
        int24 oldTick = currentTick;
        uint160 oldSqrtPrice = sqrtPriceX96;
        
        // In a real implementation, we would adjust liquidity across ticks
        // Here we're just updating the state variables
        currentTick = idealTick;
        sqrtPriceX96 = TickMath.getSqrtRatioAtTick(idealTick);
        lastRebalanceTimestamp = uint32(block.timestamp);
        
        emit AutoRebalance(oldTick, idealTick, oldSqrtPrice, sqrtPriceX96);
    }
    
    /**
     * @notice Update swap analytics after each swap
     * @param amount0 Amount of token0
     */
    function _updateSwapAnalytics(int256 amount0) internal {
        // Calculate swap volume in token0
        uint256 volume = amount0 > 0 ? uint256(amount0) : uint256(-amount0);
        
        // Update 24h rolling window
        uint32 currentTime = uint32(block.timestamp);
        if (currentTime - lastAnalyticsUpdate >= 24 hours) {
            // Reset 24h counter if a full day passed
            volume24h = volume;
            swapCount24h = 1;
        } else {
            // Otherwise accumulate
            volume24h += volume;
            swapCount24h += 1;
        }
        
        // Update all-time volume
        volumeAllTime += volume;
        
        // Update TVL
        _updateTVL();
        
        // Update timestamp
        lastAnalyticsUpdate = currentTime;
        
        emit AnalyticsUpdated(totalValueLocked, volume24h, swapCount24h);
    }
    
    /**
     * @notice Update total value locked calculation
     */
    function _updateTVL() internal {
        // Get token balances
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        
        // Get token decimals for normalization
        uint8 decimals0 = IERC20Metadata(token0).decimals();
        uint8 decimals1 = IERC20Metadata(token1).decimals();
        
        // Convert to common 18 decimal format
        uint256 normalized0 = balance0 * (10 ** (18 - decimals0));
        uint256 normalized1 = balance1 * (10 ** (18 - decimals1));
        
        // Calculate TVL in token0 terms (simplified)
        uint256 price0In1 = uint256(sqrtPriceX96) ** 2 / 2 ** 192;
        totalValueLocked = normalized0 + (normalized1 * price0In1 / (10 ** 18));
        
        // Notify factory of updated analytics
        IHyperDexFactory(factory).updatePoolAnalytics(address(this), totalValueLocked, volume24h);
    }
    
    /**
     * @notice Calculate token amounts needed for given liquidity amount
     * @param tickLower Lower tick
     * @param tickUpper Upper tick
     * @param amount Liquidity amount
     * @return amount0 Token0 amount
     * @return amount1 Token1 amount
     */
    function _calculateTokenAmounts(
        int24 tickLower,
        int24 tickUpper,
        uint128 amount
    ) internal view returns (uint256 amount0, uint256 amount1) {
        uint160 sqrtRatioAX96 = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtRatioBX96 = TickMath.getSqrtRatioAtTick(tickUpper);
        
        // Simplified calculation - in production would use LiquidityAmounts library
        if (sqrtPriceX96 <= sqrtRatioAX96) {
            // Current price is below the position, only token0 needed
            require(sqrtRatioAX96 > 0, "sqrtRatioAX96 is zero");
            amount0 = FullMath.mulDiv(
                amount,
                FixedPoint96.Q96,
                sqrtRatioAX96
            );
            amount1 = 0;
        } else if (sqrtPriceX96 < sqrtRatioBX96) {
            // Current price is within the position, both tokens needed
            require(sqrtRatioBX96 > sqrtPriceX96, "sqrtRatioBX96 <= sqrtPriceX96");
            require(sqrtRatioBX96 > 0, "sqrtRatioBX96 is zero");
            amount0 = FullMath.mulDiv(
                amount,
                sqrtRatioBX96 - sqrtPriceX96,
                sqrtRatioBX96
            );
            require(sqrtPriceX96 > sqrtRatioAX96, "sqrtPriceX96 <= sqrtRatioAX96");
            require(sqrtPriceX96 > 0, "sqrtPriceX96 is zero");
            amount1 = FullMath.mulDiv(
                amount,
                sqrtPriceX96 - sqrtRatioAX96,
                sqrtPriceX96
            );
        } else {
            // Current price is above the position, only token1 needed
            require(sqrtRatioBX96 > sqrtRatioAX96, "sqrtRatioBX96 <= sqrtRatioAX96");
            amount0 = 0;
            amount1 = FullMath.mulDiv(
                amount,
                sqrtRatioBX96 - sqrtRatioAX96,
                FixedPoint96.Q96
            );
        }
    }
    
    /**
     * @notice Update tick state when liquidity changes
     * @param tick The tick to update
     * @param liquidityDelta Amount of liquidity to add/remove
     * @param isLower Whether it's the lower tick of a position
     * @return flipped Whether the tick status flipped
     */
    function _updateTick(
        int24 tick,
        uint128 liquidityDelta,
        bool isLower
    ) internal returns (bool flipped) {
        Tick storage tickInfo = ticks[tick];
        uint128 liquidityBefore = tickInfo.liquidityGross;
        uint128 liquidityAfter = liquidityBefore + liquidityDelta;
        
        flipped = (liquidityBefore == 0) != (liquidityAfter == 0);
        
        if (liquidityBefore == 0) {
            tickInfo.initialized = true;
            tickInfo.feeGrowthOutside0X128 = feeGrowthGlobal0X128;
            tickInfo.feeGrowthOutside1X128 = feeGrowthGlobal1X128;
        }
        
        tickInfo.liquidityGross = liquidityAfter;
        int128 netBefore = tickInfo.liquidityNet;
        int128 delta = int128(liquidityDelta);
        tickInfo.liquidityNet = isLower ? netBefore + delta : netBefore - delta;
        
        return flipped;
    }
    
    /**
     * @notice Get the next initialized tick
     * @param tick Starting tick
     * @param tickSpacingParam Spacing between ticks
     * @param zeroForOne Direction
     * @return Next initialized tick
     */
    function _getNextInitializedTick(
        int24 tick,
        int24 tickSpacingParam,
        bool zeroForOne
    ) internal view returns (int24) {
        // Find the next initialized tick in the specified direction
        int24 next = zeroForOne ? tick - tickSpacingParam : tick + tickSpacingParam;
        
        // Linear search (in production would use bitmap for O(1) lookup)
        while (next >= TickMath.MIN_TICK && next <= TickMath.MAX_TICK) {
            if (ticks[next].initialized) {
                return next;
            }
            next = zeroForOne ? next - tickSpacingParam : next + tickSpacingParam;
        }
        
        return zeroForOne ? TickMath.MIN_TICK : TickMath.MAX_TICK;
    }
    
    /**
     * @notice Calculate fee growth inside a tick range
     * @param tickLower Lower tick
     * @param tickUpper Upper tick
     * @param currentTickArg Current tick
     * @param feeGrowthGlobal0X128Arg Global fee growth for token0
     * @param feeGrowthGlobal1X128Arg Global fee growth for token1
     * @return feeGrowth0Inside Fee growth inside for token0
     * @return feeGrowth1Inside Fee growth inside for token1
     */
    function _getFeeGrowthInside(
        int24 tickLower,
        int24 tickUpper,
        int24 currentTickArg,
        uint256 feeGrowthGlobal0X128Arg,
        uint256 feeGrowthGlobal1X128Arg
    ) internal view returns (uint256 feeGrowth0Inside, uint256 feeGrowth1Inside) {
        Tick storage lower = ticks[tickLower];
        Tick storage upper = ticks[tickUpper];
        
        // Calculate fee growth below lower tick
        uint256 feeGrowthBelow0X128;
        uint256 feeGrowthBelow1X128;
        
        if (currentTickArg >= tickLower) {
            feeGrowthBelow0X128 = lower.feeGrowthOutside0X128;
            feeGrowthBelow1X128 = lower.feeGrowthOutside1X128;
        } else {
            feeGrowthBelow0X128 = feeGrowthGlobal0X128Arg - lower.feeGrowthOutside0X128;
            feeGrowthBelow1X128 = feeGrowthGlobal1X128Arg - lower.feeGrowthOutside1X128;
        }
        
        // Calculate fee growth above upper tick
        uint256 feeGrowthAbove0X128;
        uint256 feeGrowthAbove1X128;
        
        if (currentTickArg < tickUpper) {
            feeGrowthAbove0X128 = upper.feeGrowthOutside0X128;
            feeGrowthAbove1X128 = upper.feeGrowthOutside1X128;
        } else {
            feeGrowthAbove0X128 = feeGrowthGlobal0X128Arg - upper.feeGrowthOutside0X128;
            feeGrowthAbove1X128 = feeGrowthGlobal1X128Arg - upper.feeGrowthOutside1X128;
        }
        
        // Calculate fee growth inside the range
        feeGrowth0Inside = feeGrowthGlobal0X128Arg - feeGrowthBelow0X128 - feeGrowthAbove0X128;
        feeGrowth1Inside = feeGrowthGlobal1X128Arg - feeGrowthBelow1X128 - feeGrowthAbove1X128;
    }
    
    /**
     * @notice Compute the result of a swap step
     * @param sqrtRatioX96 Current sqrt price
     * @param targetSqrtRatioX96 Target sqrt price
     * @param liquidityAmount Current liquidity
     * @param amountRemaining Amount remaining to swap
     * @param zeroForOne Direction of swap
     * @return amount0 Token0 amount for this step
     * @return amount1 Token1 amount for this step
     */
    function _computeSwapStep(
        uint160 sqrtRatioX96,
        uint160 targetSqrtRatioX96,
        uint128 liquidityAmount,
        int256 amountRemaining,
        bool zeroForOne
    ) internal pure returns (int256 amount0, int256 amount1) {
        // Simplified calculation - in production would handle exact calculations
        if (zeroForOne) {
            // Calculate token1 amount based on price difference
            require(targetSqrtRatioX96 > 0, "targetSqrtRatioX96 is zero");
            require(sqrtRatioX96 > 0, "sqrtRatioX96 is zero");
            amount1 = -int256(
                FullMath.mulDiv(
                    uint256(liquidityAmount),
                    uint256(sqrtRatioX96 - targetSqrtRatioX96),
                    FixedPoint96.Q96
                )
            );
            
            // Calculate token0 amount based on token1 amount
            require(FixedPoint96.Q96 > 0, "FixedPoint96.Q96 is zero");
            amount0 = int256(
                FullMath.mulDiv(
                    uint256(-amount1),
                    FixedPoint96.Q96,
                    uint256(sqrtRatioX96)
                )
            );
            
            // Cap by amount remaining
            if (amountRemaining < amount0) {
                amount0 = amountRemaining;
                require(sqrtRatioX96 > 0, "sqrtRatioX96 is zero");
                amount1 = -int256(
                    FullMath.mulDiv(
                        uint256(amount0),
                        uint256(sqrtRatioX96),
                        FixedPoint96.Q96
                    )
                );
            }
        } else {
            // Calculate token0 amount based on price difference
            require(targetSqrtRatioX96 > sqrtRatioX96, "targetSqrtRatioX96 <= sqrtRatioX96");
            require(targetSqrtRatioX96 > 0, "targetSqrtRatioX96 is zero");
            amount0 = -int256(
                FullMath.mulDiv(
                    uint256(liquidityAmount),
                    uint256(targetSqrtRatioX96 - sqrtRatioX96),
                    targetSqrtRatioX96
                )
            );
            
            // Calculate token1 amount based on token0 amount
            require(sqrtRatioX96 > 0, "sqrtRatioX96 is zero");
            amount1 = int256(
                FullMath.mulDiv(
                    uint256(-amount0),
                    uint256(sqrtRatioX96),
                    FixedPoint96.Q96
                )
            );
            
            // Cap by amount remaining
            if (amountRemaining < amount1) {
                amount1 = amountRemaining;
                require(FixedPoint96.Q96 > 0, "FixedPoint96.Q96 is zero");
                amount0 = -int256(
                    FullMath.mulDiv(
                        uint256(amount1),
                        FixedPoint96.Q96,
                        uint256(sqrtRatioX96)
                    )
                );
            }
        }
    }
}

/**
 * @title IHyperDexFactory
 * @author HyperDex Team
 * @notice Interface for HyperDexFactory contract
 */
interface IHyperDexFactory {
    function getProtocolFee(address pool) external view returns (uint32);
    function updatePoolAnalytics(address pool, uint256 tvl, uint256 volume24h) external;
}
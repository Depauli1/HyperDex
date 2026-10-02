// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/**
 * @title INonfungiblePositionManager
 * @notice The subset of Uniswap's canonical `NonfungiblePositionManager` this
 *         contract uses. Declared here rather than imported so the manager can
 *         be deployed against the canonical periphery already deployed on each
 *         network instead of vendoring a whole periphery fork.
 */
interface INonfungiblePositionManager {
    struct MintParams {
        address token0;
        address token1;
        uint24 fee;
        int24 tickLower;
        int24 tickUpper;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        address recipient;
        uint256 deadline;
    }

    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct DecreaseLiquidityParams {
        uint256 tokenId;
        uint128 liquidity;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }

    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function mint(MintParams calldata params)
        external
        payable
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1);

    function increaseLiquidity(IncreaseLiquidityParams calldata params)
        external
        payable
        returns (uint128 liquidity, uint256 amount0, uint256 amount1);

    function decreaseLiquidity(DecreaseLiquidityParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function collect(CollectParams calldata params)
        external
        payable
        returns (uint256 amount0, uint256 amount1);

    function burn(uint256 tokenId) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

/**
 * @title PositionManager
 * @notice Lets a user hold a Uniswap v3 liquidity position through this
 *         contract, which enforces who may change it.
 *
 * The canonical periphery stores a position in an NFT and treats whoever holds
 * the NFT as its owner. If users held the NFT directly, any logic built around
 * a position (fees, restrictions, automation) would be unenforceable - the
 * holder could always operate the position behind the contract's back. This
 * manager therefore keeps the NFT and tracks the beneficial owner in
 * `positionOwner`, so every call passes through the checks below. `withdraw`
 * hands the NFT over when a user wants full custody.
 */
contract PositionManager is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @notice Canonical Uniswap v3 NonfungiblePositionManager.
    INonfungiblePositionManager public immutable positionManager;

    /// @notice Beneficial owner of each position held by this contract.
    mapping(uint256 => address) public positionOwner;

    /// @notice Positions whose NFT has been handed to the beneficial owner.
    mapping(uint256 => bool) public withdrawn;

    event PositionMinted(uint256 indexed tokenId, address indexed owner, uint128 liquidity);
    event LiquidityIncreased(uint256 indexed tokenId, uint128 liquidity);
    event LiquidityDecreased(
        uint256 indexed tokenId,
        uint128 liquidity,
        uint256 amount0,
        uint256 amount1
    );
    event FeesCollected(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event PositionBurned(uint256 indexed tokenId, uint256 amount0, uint256 amount1);
    event PositionWithdrawn(uint256 indexed tokenId, address indexed owner);

    error ZeroAddress();
    error NotPositionOwner(uint256 tokenId);
    error AlreadyWithdrawn(uint256 tokenId);
    error DeadlineExpired();
    error UnknownPosition(uint256 tokenId);

    modifier onlyPositionOwner(uint256 tokenId) {
        if (positionOwner[tokenId] != msg.sender) revert NotPositionOwner(tokenId);
        if (withdrawn[tokenId]) revert AlreadyWithdrawn(tokenId);
        _;
    }

    modifier notExpired(uint256 deadline) {
        if (block.timestamp > deadline) revert DeadlineExpired();
        _;
    }

    /**
     * @param _positionManager address of the canonical NonfungiblePositionManager
     */
    constructor(address _positionManager) {
        if (_positionManager == address(0)) revert ZeroAddress();
        positionManager = INonfungiblePositionManager(_positionManager);
    }

    /**
     * @notice The position data the periphery records for `tokenId`.
     * @dev Bubbles the periphery's own revert when the position does not exist.
     */
    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        )
    {
        return positionManager.positions(tokenId);
    }

    /**
     * @notice Mints a new position held by this contract on the caller's behalf.
     * @dev The caller must have approved this contract for both tokens.
     */
    function mint(INonfungiblePositionManager.MintParams calldata params)
        external
        nonReentrant
        notExpired(params.deadline)
        returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        _pull(params.token0, params.amount0Desired);
        _pull(params.token1, params.amount1Desired);

        INonfungiblePositionManager.MintParams memory mintParams = params;
        // The NFT stays here; `positionOwner` is the source of truth.
        mintParams.recipient = address(this);

        (tokenId, liquidity, amount0, amount1) = positionManager.mint(mintParams);

        positionOwner[tokenId] = msg.sender;
        emit PositionMinted(tokenId, msg.sender, liquidity);

        _refund(params.token0, params.amount0Desired, amount0);
        _refund(params.token1, params.amount1Desired, amount1);
    }

    /**
     * @notice Adds liquidity to an existing position.
     * @dev The caller must have approved this contract for both tokens.
     */
    function increaseLiquidity(INonfungiblePositionManager.IncreaseLiquidityParams calldata params)
        external
        nonReentrant
        onlyPositionOwner(params.tokenId)
        notExpired(params.deadline)
        returns (uint128 liquidity, uint256 amount0, uint256 amount1)
    {
        (, , address token0, address token1, , , , , , , , ) = positionManager.positions(params.tokenId);

        _pull(token0, params.amount0Desired);
        _pull(token1, params.amount1Desired);

        (liquidity, amount0, amount1) = positionManager.increaseLiquidity(params);

        emit LiquidityIncreased(params.tokenId, liquidity);
        _refund(token0, params.amount0Desired, amount0);
        _refund(token1, params.amount1Desired, amount1);
    }

    /**
     * @notice Removes liquidity from a position.
     * @dev The released tokens stay in the periphery until `collectPosition`.
     */
    function decreaseLiquidity(INonfungiblePositionManager.DecreaseLiquidityParams calldata params)
        external
        onlyPositionOwner(params.tokenId)
        notExpired(params.deadline)
        returns (uint256 amount0, uint256 amount1)
    {
        (amount0, amount1) = positionManager.decreaseLiquidity(params);
        emit LiquidityDecreased(params.tokenId, params.liquidity, amount0, amount1);
    }

    /**
     * @notice Collects the tokens owed to a position and forwards them.
     * @param tokenId the position
     * @param amount0Max maximum of token0 to collect
     * @param amount1Max maximum of token1 to collect
     */
    function collectPosition(
        uint256 tokenId,
        uint128 amount0Max,
        uint128 amount1Max
    ) external onlyPositionOwner(tokenId) returns (uint256 amount0, uint256 amount1) {
        (amount0, amount1) = positionManager.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: address(this),
                amount0Max: amount0Max,
                amount1Max: amount1Max
            })
        );

        (, , address token0, address token1, , , , , , , , ) = positionManager.positions(tokenId);
        if (amount0 > 0) IERC20(token0).safeTransfer(msg.sender, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(msg.sender, amount1);

        emit FeesCollected(tokenId, amount0, amount1);
    }

    /**
     * @notice Burns an empty position and returns any remaining tokens.
     * @dev Reverts in the periphery while liquidity or fees remain.
     */
    function burnPosition(uint256 tokenId)
        external
        onlyPositionOwner(tokenId)
        returns (uint256 amount0, uint256 amount1)
    {
        (, , address token0, address token1, , , , , , , , ) = positionManager.positions(tokenId);

        (amount0, amount1) = positionManager.burn(tokenId);

        if (amount0 > 0) IERC20(token0).safeTransfer(msg.sender, amount0);
        if (amount1 > 0) IERC20(token1).safeTransfer(msg.sender, amount1);

        emit PositionBurned(tokenId, amount0, amount1);
    }

    /**
     * @notice Transfers the position NFT to its beneficial owner, giving up the
     *         contract's custody.
     */
    function withdraw(uint256 tokenId) external onlyPositionOwner(tokenId) {
        withdrawn[tokenId] = true;
        IERC721(address(positionManager)).safeTransferFrom(address(this), msg.sender, tokenId);
        emit PositionWithdrawn(tokenId, msg.sender);
    }

    // --- Internals -----------------------------------------------------------

    function _pull(address token, uint256 amount) private {
        if (amount == 0) return;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(token).safeApprove(address(positionManager), 0);
        IERC20(token).safeApprove(address(positionManager), amount);
    }

    function _refund(address token, uint256 requested, uint256 used) private {
        if (requested > used) {
            IERC20(token).safeTransfer(msg.sender, requested - used);
        }
    }
}

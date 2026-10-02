// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./HyperDexPool.sol";

/**
 * @title HyperDexPoolDeployer
 * @notice Holds `HyperDexPool`'s creation code and performs the CREATE2 deployment.
 * @dev `HyperDexPool`'s creation code is ~22 KB. Inlining it into
 *      `HyperDexFactory` (via `type(HyperDexPool).creationCode`) pushed the
 *      factory's deployed size to 28,855 bytes, past the 24,576-byte EIP-170
 *      limit, so the factory could not be deployed at all. Keeping the bytecode
 *      in a single-purpose deployer -- the same split Uniswap v3 uses between
 *      `UniswapV3Factory` and `UniswapV3PoolDeployer` -- keeps both contracts
 *      deployable.
 */
contract HyperDexPoolDeployer {
    /// @notice The only address allowed to deploy pools.
    address public immutable factory;

    error OnlyFactory();

    constructor(address _factory) {
        factory = _factory;
    }

    /**
     * @notice Deploys a pool at a deterministic address.
     * @param token0 Sorted token address.
     * @param token1 Sorted token address.
     * @param fee Fee tier.
     * @param tickSpacing Tick spacing for the fee tier.
     * @return pool The deployed pool address.
     */
    function deploy(
        address token0,
        address token1,
        uint24 fee,
        int24 tickSpacing
    ) external returns (address pool) {
        if (msg.sender != factory) revert OnlyFactory();

        pool = address(
            new HyperDexPool{salt: keccak256(abi.encodePacked(token0, token1, fee))}(
                factory,
                token0,
                token1,
                fee,
                tickSpacing
            )
        );
    }
}

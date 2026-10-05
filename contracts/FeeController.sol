// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@chainlink/contracts/src/v0.8/interfaces/AggregatorV3Interface.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import { IFeeController } from "./interfaces/IFeeController.sol";

/**
 * @title FeeController
 * @notice Volatility-driven protocol-fee policy.
 *
 * @dev Uniswap v3 does not let anyone change a pool's LP fee tier, but it does
 *      let the factory owner choose the protocol's cut of that fee, as a
 *      divisor: `setFeeProtocol(4..10)` makes the protocol keep 1/4 down to
 *      1/10 of the swap fee charged to traders. That is the only fee lever the
 *      AMM exposes, so this controller is a *protocol-fee policy*, not a
 *      trader-facing fee schedule.
 *
 *      Policy: the protocol takes more when the market is volatile. Volatility
 *      is measured from a Chainlink price feed as an EWMA of the absolute
 *      relative move between consecutive observations, in basis points:
 *
 *          vol_now  = |p_now - p_last| / p_last * 10_000
 *          vol_ewma = alpha * vol_now + (1 - alpha) * vol_ewma
 *
 *      `update()` is permissionless and rate-limited by `updateCooldown`; the
 *      resulting denominator is clamped to `[minDenominator, baseDenominator]`
 *      so the take never exceeds 1/minDenominator and never falls below
 *      1/baseDenominator.
 */
contract FeeController is IFeeController, Ownable, Pausable {
    /// @dev Chainlink feeds report with their own decimals; only relative moves
    ///      are used, so the raw answer is enough.
    AggregatorV3Interface public immutable priceFeed;

    /// @notice Divisor applied when volatility is at or below the floor.
    uint8 public baseDenominator;
    /// @notice Most aggressive divisor the policy may apply (larger take).
    uint8 public minDenominator;

    /// @notice Weight (bps) given to the newest observation in the EWMA.
    uint256 public alphaBps = 2000; // 20%
    /// @notice Volatility (bps) at or above which the take is maximal.
    uint256 public volatilityCeilingBps = 2000; // 20%
    /// @notice Minimum seconds between observations.
    uint256 public updateCooldown = 5 minutes;

    /// @notice Last computed EWMA volatility, in basis points.
    uint256 public volatilityBps;
    /// @notice Timestamp of the last accepted observation.
    uint256 public lastUpdate;
    /// @notice Raw feed answer at the last observation.
    int256 public lastAnswer;

    uint256[] private history;

    event FeeUpdated(uint8 denominator, uint256 volatilityBps, uint256 timestamp);
    event ParametersUpdated(uint8 baseDenominator, uint8 minDenominator);

    error InvalidParameter();
    error FeedError();
    error CooldownActive();

    /// @param _priceFeed Chainlink feed used to observe market moves.
    /// @param _baseDenominator Divisor applied in calm markets (4..10).
    /// @param _minDenominator Most aggressive divisor allowed (4..10).
    constructor(address _priceFeed, uint8 _baseDenominator, uint8 _minDenominator) {
        if (_priceFeed == address(0)) revert InvalidParameter();
        if (!_validDenominator(_baseDenominator) || !_validDenominator(_minDenominator)) {
            revert InvalidParameter();
        }
        if (_minDenominator > _baseDenominator) revert InvalidParameter();

        priceFeed = AggregatorV3Interface(_priceFeed);
        baseDenominator = _baseDenominator;
        minDenominator = _minDenominator;
    }

    // --- Policy hook ---

    /// @inheritdoc IFeeController
    function getProtocolFeeDenominator() external view returns (uint8 denominator) {
        if (history.length == 0) return baseDenominator;
        return uint8(history[history.length - 1]);
    }

    /// @notice Records a new observation and updates the policy.
    function update() external whenNotPaused {
        if (block.timestamp < lastUpdate + updateCooldown) revert CooldownActive();

        (, int256 answer, , , ) = priceFeed.latestRoundData();
        if (answer <= 0) revert FeedError();

        int256 previous = lastAnswer;
        if (previous > 0) {
            uint256 move = _absDiffBps(answer, previous);
            volatilityBps = (alphaBps * move + (10_000 - alphaBps) * volatilityBps) / 10_000;
        } else {
            volatilityBps = 0;
        }

        lastAnswer = answer;
        lastUpdate = block.timestamp;

        uint8 denominator = _denominatorFor(volatilityBps);
        history.push(denominator);
        emit FeeUpdated(denominator, volatilityBps, block.timestamp);
    }

    // --- Views ---

    /// @notice Current policy output, without waiting for `update()`.
    function currentDenominator() external view returns (uint8) {
        if (history.length == 0) return baseDenominator;
        return uint8(history[history.length - 1]);
    }

    /// @notice Number of recorded observations.
    function historyLength() external view returns (uint256) {
        return history.length;
    }

    /// @notice Denominator recorded at `index`.
    function getFeeHistory(uint256 start, uint256 end) external view returns (uint256[] memory out) {
        if (end <= start || end > history.length) revert InvalidParameter();
        out = new uint256[](end - start);
        for (uint256 i = 0; i < out.length; i++) {
            out[i] = history[start + i];
        }
    }

    // --- Admin ---

    function setParameters(
        uint8 _baseDenominator,
        uint8 _minDenominator,
        uint256 _alphaBps,
        uint256 _volatilityCeilingBps,
        uint256 _updateCooldown
    ) external onlyOwner {
        if (!_validDenominator(_baseDenominator) || !_validDenominator(_minDenominator)) {
            revert InvalidParameter();
        }
        if (_minDenominator > _baseDenominator) revert InvalidParameter();
        if (_alphaBps == 0 || _alphaBps > 10_000) revert InvalidParameter();
        if (_volatilityCeilingBps == 0) revert InvalidParameter();

        baseDenominator = _baseDenominator;
        minDenominator = _minDenominator;
        alphaBps = _alphaBps;
        volatilityCeilingBps = _volatilityCeilingBps;
        updateCooldown = _updateCooldown;

        emit ParametersUpdated(_baseDenominator, _minDenominator);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --- Internals ---

    function _denominatorFor(uint256 vol) private view returns (uint8) {
        if (vol == 0) return baseDenominator;
        if (vol >= volatilityCeilingBps) return minDenominator;

        uint256 span = baseDenominator - minDenominator;
        uint256 step = (span * vol) / volatilityCeilingBps;
        return uint8(baseDenominator - step);
    }

    function _absDiffBps(int256 a, int256 b) private pure returns (uint256) {
        int256 diff = a > b ? a - b : b - a;
        return (uint256(diff) * 10_000) / uint256(b);
    }

    /// @dev v3 accepts 0 (off) or 4..10 (1/4..1/10 of the LP fee).
    function _validDenominator(uint8 d) private pure returns (bool) {
        return d == 0 ? false : (d >= 4 && d <= 10);
    }
}

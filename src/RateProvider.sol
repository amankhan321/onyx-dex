// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Supplies the fair exchange rate of coin1 in units of coin0, 1e18-scaled.
///         For USDC/EURC this is the EUR/USD price (~1.08e18).
///         For a par pair (e.g. USDC/USYC) this is exactly 1e18.
interface IRateProvider {
    /// @return rate Value of 1 unit of coin1 denominated in coin0, 1e18 fixed point.
    function getRate() external view returns (uint256 rate);
}

/// @title ParRateProvider
/// @notice Immutable 1:1 rate. Correct for genuinely pegged pairs. Zero trust surface.
contract ParRateProvider is IRateProvider {
    function getRate() external pure returns (uint256) {
        return 1e18;
    }
}

/// @title GuardedRateProvider
/// @notice Pushed FX rate with hard guardrails. Used for USDC/EURC on Arc, where no
///         canonical EUR/USD feed exists yet.
/// @dev The updater is the single trusted component in the system. It is deliberately
///      fenced in three ways so that a compromised updater cannot instantly drain the pool:
///        1. MAX_DEVIATION_BPS caps how far one update may move the rate.
///        2. MIN_UPDATE_INTERVAL caps how often it may move.
///        3. Consumers MUST treat a stale rate as fatal (see `getRate` revert).
///
///      ROTATION. The testnet version made `updater` immutable. That meant a leaked
///      updater key could only be "fixed" by redeploying this contract — and because
///      StableSwap stores its rate provider immutably too, by redeploying the pool and
///      migrating every LP. On mainnet that is not an acceptable incident response.
///      So an `owner` (intended to be a Safe multisig) may replace the updater.
///
///      The owner's power is deliberately narrow:
///        - it can change WHO may push a rate, and nothing else;
///        - it cannot push a rate itself, nor bypass any of the three fences above;
///        - ownership moves in two steps, so a typo cannot hand it to a dead address.
///      Even a compromised owner can therefore only install an updater that is subject
///      to the same 1%-per-5-minutes cap as everyone else.
///
///      Swap this out for a Chainlink adapter the moment an EUR/USD feed lands on Arc.
contract GuardedRateProvider is IRateProvider {
    uint256 public constant MAX_DEVIATION_BPS = 100; // 1% per update
    uint256 public constant MIN_UPDATE_INTERVAL = 5 minutes;
    uint256 public constant STALENESS_WINDOW = 6 hours;

    address public owner;
    address public pendingOwner;
    address public updater;
    uint256 public rate;
    uint256 public updatedAt;

    error NotUpdater();
    error NotOwner();
    error NotPendingOwner();
    error ZeroAddress();
    error TooSoon();
    error DeviationTooLarge();
    error StaleRate();
    error ZeroRate();

    event RateUpdated(uint256 oldRate, uint256 newRate, uint256 timestamp);
    event UpdaterChanged(address indexed previousUpdater, address indexed newUpdater);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    constructor(address owner_, address updater_, uint256 initialRate) {
        if (owner_ == address(0) || updater_ == address(0)) revert ZeroAddress();
        if (initialRate == 0) revert ZeroRate();
        owner = owner_;
        updater = updater_;
        rate = initialRate;
        updatedAt = block.timestamp;
        emit OwnershipTransferred(address(0), owner_);
        emit UpdaterChanged(address(0), updater_);
    }

    function setRate(uint256 newRate) external {
        if (msg.sender != updater) revert NotUpdater();
        if (newRate == 0) revert ZeroRate();
        if (block.timestamp < updatedAt + MIN_UPDATE_INTERVAL) revert TooSoon();

        uint256 old = rate;
        uint256 diff = newRate > old ? newRate - old : old - newRate;
        if (diff * 10_000 > old * MAX_DEVIATION_BPS) revert DeviationTooLarge();

        rate = newRate;
        updatedAt = block.timestamp;
        emit RateUpdated(old, newRate, block.timestamp);
    }

    /// @notice Replace the updater, e.g. after its key leaks. Takes effect immediately:
    ///         the old key can no longer push from the very next block.
    /// @dev Does not touch `rate` or `updatedAt` — rotating the key is not a price event,
    ///      and resetting `updatedAt` here would let the owner un-stale a dead feed.
    function setUpdater(address newUpdater) external {
        if (msg.sender != owner) revert NotOwner();
        if (newUpdater == address(0)) revert ZeroAddress();
        emit UpdaterChanged(updater, newUpdater);
        updater = newUpdater;
    }

    /// @notice Step 1 of 2. The new owner must call `acceptOwnership` to complete.
    function transferOwnership(address newOwner) external {
        if (msg.sender != owner) revert NotOwner();
        if (newOwner == address(0)) revert ZeroAddress();
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Step 2 of 2. Proves the new owner can actually sign before it takes over.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    /// @dev Reverts rather than returning a stale rate. A frozen oracle must halt the
    ///      AMM, not silently let it price off a dead feed.
    function getRate() external view returns (uint256) {
        if (block.timestamp > updatedAt + STALENESS_WINDOW) revert StaleRate();
        return rate;
    }
}

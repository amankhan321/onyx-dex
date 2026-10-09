// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {StableSwap} from "../src/StableSwap.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Router} from "../src/Router.sol";
import {Quoter} from "../src/Quoter.sol";
import {TwapExecutor} from "../src/TwapExecutor.sol";
import {GuardedRateProvider} from "../src/RateProvider.sol";

/// @notice Deploys the full Onyx stack to Arc Mainnet (5042) or Arc Testnet (5042002).
///
///   PRIVATE_KEY=…  OWNER=<Safe>  UPDATER=<keeper EOA>  EURUSD_RATE=<1e18 rate> \
///   forge script script/Deploy.s.sol:Deploy --rpc-url $ARC_RPC_URL --broadcast -vvv
///
/// Mainnet refuses to run unless every one of these holds — each guards a mistake that
/// is cheap to make and expensive to undo once real liquidity is in the pool:
///
///   - token addresses come from the chain id, never from a default. The testnet EURC
///     address on mainnet is a different contract entirely.
///   - EURUSD_RATE is REQUIRED and must sit inside a sane band. A stale default opening
///     rate is a free arbitrage against the first liquidity provider.
///   - OWNER must be a contract (a Safe). It can rotate the rate updater after a key
///     leak — the incident response that does not exist if updater is immutable.
///   - UPDATER, OWNER and the deployer must be three different addresses. The deployer
///     key's job ends when this script does; it must not be the one pricing the pool.
///
/// @dev No calls into the token contracts. Decimals are constants (Arc's USDC and EURC
///      ERC-20 interfaces are both 6-decimal), so the script has no external dependency
///      that can fail half-way through a broadcast.
contract Deploy is Script {
    uint256 constant ARC_MAINNET = 5042;
    uint256 constant ARC_TESTNET = 5042002;

    // Both from docs.arc.io/arc/references/contract-addresses. USDC is the same on both;
    // EURC is NOT.
    address constant USDC = 0x3600000000000000000000000000000000000000;
    address constant EURC_MAINNET = 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1;
    address constant EURC_TESTNET = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;

    uint8 constant DECIMALS = 6;

    // A = 200 (amp is A * 100). High amplification is right for a tight FX pair.
    uint256 constant AMP = 20_000;
    // 4 bps LP fee on the AMM, 2 bps taker fee on the book. Both immutable forever.
    uint256 constant POOL_FEE_BPS = 4;
    uint256 constant TAKER_FEE_BPS = 2;

    // Plausible EUR/USD. Anything outside is a typo or a decimal slip, not a market.
    uint256 constant RATE_MIN = 0.8e18;
    uint256 constant RATE_MAX = 1.6e18;

    error UnsupportedChain(uint256 chainId);
    error RateRequired();
    error RateOutOfBand(uint256 rate);
    error OwnerMustBeContract(address owner);
    error RolesMustDiffer();

    struct Deployed {
        address rateProvider;
        address pool;
        address book;
        address router;
        address quoter;
        address twap;
    }

    struct Config {
        uint256 pk;
        address owner;
        address updater;
        uint256 initialRate;
    }

    /// @notice Entry point for `forge script`: reads the environment, then deploys.
    function run() external returns (Deployed memory) {
        return deploy(
            Config({
                pk: vm.envUint("PRIVATE_KEY"),
                owner: vm.envAddress("OWNER"),
                updater: vm.envAddress("UPDATER"),
                // No default on either network: the right opening rate is whatever the
                // market is on deploy day; the keeper moves it only 1% per 5 min after.
                initialRate: vm.envOr("EURUSD_RATE", uint256(0))
            })
        );
    }

    /// @notice Validates every guard, then deploys. Split from `run` so the guards can
    ///         be tested with explicit values instead of mutating the process env.
    function deploy(Config memory c) public returns (Deployed memory d) {
        uint256 chainId = block.chainid;
        bool mainnet = chainId == ARC_MAINNET;
        if (!mainnet && chainId != ARC_TESTNET) revert UnsupportedChain(chainId);

        address eurc = mainnet ? EURC_MAINNET : EURC_TESTNET;

        uint256 pk = c.pk;
        address deployer = vm.addr(pk);
        address owner = c.owner;
        address updater = c.updater;
        uint256 initialRate = c.initialRate;
        if (initialRate == 0) revert RateRequired();
        if (initialRate < RATE_MIN || initialRate > RATE_MAX) revert RateOutOfBand(initialRate);

        if (owner == updater || owner == deployer || updater == deployer) revert RolesMustDiffer();
        if (mainnet && owner.code.length == 0) revert OwnerMustBeContract(owner);

        console2.log("network      ", mainnet ? "Arc Mainnet" : "Arc Testnet");
        console2.log("deployer     ", deployer);
        console2.log("owner (Safe) ", owner);
        console2.log("updater      ", updater);
        console2.log("USDC         ", USDC);
        console2.log("EURC         ", eurc);
        console2.log("EUR/USD rate ", initialRate);
        console2.log("");

        vm.startBroadcast(pk);

        GuardedRateProvider rp = new GuardedRateProvider(owner, updater, initialRate);
        StableSwap pool = new StableSwap(
            USDC, eurc, address(rp), DECIMALS, DECIMALS, AMP, POOL_FEE_BPS, "Onyx USDC/EURC LP", "onyx-USDC-EURC"
        );
        OrderBook book = new OrderBook(address(pool), TAKER_FEE_BPS);
        Router router = new Router(address(pool), address(book));
        Quoter quoter = new Quoter(address(pool), address(book));
        TwapExecutor twap = new TwapExecutor(address(router));

        vm.stopBroadcast();

        d = Deployed(address(rp), address(pool), address(book), address(router), address(quoter), address(twap));

        console2.log("=== Onyx deployed ===");
        console2.log("RateProvider ", d.rateProvider);
        console2.log("StableSwap   ", d.pool);
        console2.log("OrderBook    ", d.book);
        console2.log("Router       ", d.router);
        console2.log("Quoter       ", d.quoter);
        console2.log("TwapExecutor ", d.twap);
    }
}

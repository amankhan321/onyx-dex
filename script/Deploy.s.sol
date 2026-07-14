// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console2} from "forge-std/Script.sol";

import {StableSwap} from "../src/StableSwap.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Router} from "../src/Router.sol";
import {Quoter} from "../src/Quoter.sol";
import {TwapExecutor} from "../src/TwapExecutor.sol";
import {GuardedRateProvider} from "../src/RateProvider.sol";

/// @notice Deploys the full ArcBook stack to Arc Testnet (chain 5042002).
///
///   forge script script/Deploy.s.sol:Deploy \
///     --rpc-url https://rpc.testnet.arc.network \
///     --private-key $PRIVATE_KEY \
///     --broadcast -vvv
///
/// @dev This script deliberately makes NO calls into the token contracts.
///      Arc's USDC lives at a system precompile (0x3600...0000) with no EVM bytecode.
///      Any typed Solidity call into it — including a harmless `decimals()` — trips the
///      compiler's extcodesize check and reverts with "call to non-contract address".
///      Decimals are therefore passed in as constants, not read on-chain.
contract Deploy is Script {
    // Arc Testnet canonical tokens.
    address constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address constant ARC_EURC = 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a;

    // Arc docs: the native USDC *gas* token uses 18 decimals, but the USDC *ERC-20
    // interface* uses 6. We only ever touch the ERC-20 interface.
    uint8 constant USDC_DECIMALS = 6;
    uint8 constant EURC_DECIMALS = 6;

    // A = 200 (amp is A * 100). High amplification is right for a tight FX pair.
    uint256 constant AMP = 20_000;
    // 4 bps LP fee on the AMM, 2 bps taker fee on the book. Both immutable forever.
    uint256 constant POOL_FEE_BPS = 4;
    uint256 constant TAKER_FEE_BPS = 2;

    function run() external {
        address usdc = vm.envOr("USDC", ARC_USDC);
        address eurc = vm.envOr("EURC", ARC_EURC);
        uint8 dec0 = uint8(vm.envOr("USDC_DECIMALS", uint256(USDC_DECIMALS)));
        uint8 dec1 = uint8(vm.envOr("EURC_DECIMALS", uint256(EURC_DECIMALS)));
        // EUR/USD, 1e18. Update via GuardedRateProvider.setRate from your keeper.
        uint256 initialRate = vm.envOr("EURUSD_RATE", uint256(1.08e18));

        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);

        console2.log("deployer     ", deployer);
        console2.log("USDC         ", usdc);
        console2.log("EURC         ", eurc);
        console2.log("EUR/USD rate ", initialRate);
        console2.log("");

        vm.startBroadcast(pk);

        // The deployer is the rate updater. This is the ONLY privileged role anywhere in
        // the system, and it is fenced by a deviation cap, an update cooldown, and a
        // staleness window that halts the AMM rather than pricing off a dead feed.
        GuardedRateProvider rp = new GuardedRateProvider(deployer, initialRate);

        StableSwap pool = new StableSwap(
            usdc, eurc, address(rp), dec0, dec1, AMP, POOL_FEE_BPS, "ArcBook USDC/EURC LP", "ab-USDC-EURC"
        );

        OrderBook book = new OrderBook(address(pool), TAKER_FEE_BPS);
        Router router = new Router(address(pool), address(book));
        Quoter quoter = new Quoter(address(pool), address(book));
        TwapExecutor twap = new TwapExecutor(address(router));

        vm.stopBroadcast();

        console2.log("=== ArcBook deployed ===");
        console2.log("RateProvider ", address(rp));
        console2.log("StableSwap   ", address(pool));
        console2.log("OrderBook    ", address(book));
        console2.log("Router       ", address(router));
        console2.log("Quoter       ", address(quoter));
        console2.log("TwapExecutor ", address(twap));
        console2.log("");
        console2.log("Explorer: https://testnet.arcscan.app/address/%s", address(router));
    }
}

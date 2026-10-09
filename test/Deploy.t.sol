// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {GuardedRateProvider} from "../src/RateProvider.sol";
import {StableSwap} from "../src/StableSwap.sol";

/// @notice Runs the real deploy script under each guard. A guard that is only read,
///         never exercised, is a guard nobody knows works.
contract DeployScriptTest is Test {
    uint256 constant PK = 0xA11CE;
    address safe = makeAddr("safe");
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.etch(safe, hex"00"); // a Safe is a contract; give the address code
    }

    function cfg() internal view returns (Deploy.Config memory) {
        return Deploy.Config({pk: PK, owner: safe, updater: keeper, initialRate: 1.13e18});
    }

    function test_mainnet_deploysWithMainnetEurcAndRoles() public {
        vm.chainId(5042);
        Deploy.Deployed memory d = new Deploy().deploy(cfg());
        GuardedRateProvider rp = GuardedRateProvider(d.rateProvider);
        assertEq(rp.owner(), safe);
        assertEq(rp.updater(), keeper);
        assertEq(rp.rate(), 1.13e18);
        assertEq(address(StableSwap(d.pool).coin1()), 0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1, "mainnet EURC");
        assertEq(address(StableSwap(d.pool).coin0()), 0x3600000000000000000000000000000000000000, "USDC");
    }

    function test_testnet_usesTestnetEurc() public {
        vm.chainId(5042002);
        Deploy.Deployed memory d = new Deploy().deploy(cfg());
        assertEq(address(StableSwap(d.pool).coin1()), 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a);
    }

    function test_refusesUnknownChain() public {
        vm.chainId(1);
        Deploy s = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.UnsupportedChain.selector, 1));
        s.deploy(cfg());
    }

    function test_refusesMissingRate() public {
        vm.chainId(5042);
        Deploy.Config memory c = cfg();
        c.initialRate = 0;
        Deploy s = new Deploy();
        vm.expectRevert(Deploy.RateRequired.selector);
        s.deploy(c);
    }

    function test_refusesOutOfBandRate() public {
        vm.chainId(5042);
        Deploy.Config memory c = cfg();
        c.initialRate = 1130000; // decimal slip: 1.13e6 instead of 1.13e18
        Deploy s = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.RateOutOfBand.selector, 1130000));
        s.deploy(c);
    }

    function test_mainnet_refusesEoaOwner() public {
        vm.chainId(5042);
        Deploy.Config memory c = cfg();
        c.owner = makeAddr("eoa-owner");
        Deploy s = new Deploy();
        vm.expectRevert(abi.encodeWithSelector(Deploy.OwnerMustBeContract.selector, c.owner));
        s.deploy(c);
    }

    function test_refusesDeployerAsUpdater() public {
        vm.chainId(5042);
        Deploy.Config memory c = cfg();
        c.updater = vm.addr(PK);
        Deploy s = new Deploy();
        vm.expectRevert(Deploy.RolesMustDiffer.selector);
        s.deploy(c);
    }

    function test_refusesOwnerAsUpdater() public {
        vm.chainId(5042);
        Deploy.Config memory c = cfg();
        c.updater = safe;
        Deploy s = new Deploy();
        vm.expectRevert(Deploy.RolesMustDiffer.selector);
        s.deploy(c);
    }
}

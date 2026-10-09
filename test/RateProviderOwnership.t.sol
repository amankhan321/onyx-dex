// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {GuardedRateProvider} from "../src/RateProvider.sol";

/// @notice The mainnet oracle adds exactly one power: an owner (a Safe) may replace
///         the updater. These tests pin down that it is ONLY that power — the owner can
///         never push a price, never bypass the fences, and never un-stale a dead feed.
contract RateProviderOwnershipTest is Test {
    GuardedRateProvider rp;
    address safe = makeAddr("safe");
    address keeper = makeAddr("keeper");
    address leaked = makeAddr("leaked");
    address stranger = makeAddr("stranger");
    uint256 constant RATE = 1.08e18;

    function setUp() public {
        rp = new GuardedRateProvider(safe, keeper, RATE);
    }

    // ---- construction ----

    function test_constructor_setsRoles() public view {
        assertEq(rp.owner(), safe);
        assertEq(rp.updater(), keeper);
        assertEq(rp.rate(), RATE);
    }

    function test_constructor_rejectsZeroOwner() public {
        vm.expectRevert(GuardedRateProvider.ZeroAddress.selector);
        new GuardedRateProvider(address(0), keeper, RATE);
    }

    function test_constructor_rejectsZeroUpdater() public {
        vm.expectRevert(GuardedRateProvider.ZeroAddress.selector);
        new GuardedRateProvider(safe, address(0), RATE);
    }

    function test_constructor_rejectsZeroRate() public {
        vm.expectRevert(GuardedRateProvider.ZeroRate.selector);
        new GuardedRateProvider(safe, keeper, 0);
    }

    // ---- rotation: the incident response this exists for ----

    function test_rotation_oldKeyStopsWorkingImmediately() public {
        // Absolute timestamps: chained `block.timestamp + x` warps can read a cached
        // value under via_ir and silently land inside the cooldown.
        vm.warp(1_000_000);
        GuardedRateProvider r2 = new GuardedRateProvider(safe, leaked, RATE);
        vm.prank(safe);
        r2.setUpdater(keeper);

        vm.warp(1_000_000 + 6 minutes);
        vm.prank(leaked);
        vm.expectRevert(GuardedRateProvider.NotUpdater.selector);
        r2.setRate(RATE);

        vm.prank(keeper);
        r2.setRate(RATE + 1e15); // the new key works, within the 1% cap
        assertEq(r2.rate(), RATE + 1e15);
    }

    function test_rotation_onlyOwner() public {
        vm.prank(stranger);
        vm.expectRevert(GuardedRateProvider.NotOwner.selector);
        rp.setUpdater(stranger);
        // the updater itself cannot hand its role on either
        vm.prank(keeper);
        vm.expectRevert(GuardedRateProvider.NotOwner.selector);
        rp.setUpdater(stranger);
    }

    function test_rotation_rejectsZero() public {
        vm.prank(safe);
        vm.expectRevert(GuardedRateProvider.ZeroAddress.selector);
        rp.setUpdater(address(0));
    }

    // ---- the owner's power is narrow ----

    function test_owner_cannotPushARate() public {
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(safe);
        vm.expectRevert(GuardedRateProvider.NotUpdater.selector);
        rp.setRate(RATE);
    }

    function test_rotation_doesNotUnstaleADeadFeed() public {
        vm.warp(block.timestamp + 7 hours);
        vm.expectRevert(GuardedRateProvider.StaleRate.selector);
        rp.getRate();
        uint256 before = rp.updatedAt();
        vm.prank(safe);
        rp.setUpdater(leaked);
        assertEq(rp.updatedAt(), before, "rotation must not refresh updatedAt");
        vm.expectRevert(GuardedRateProvider.StaleRate.selector);
        rp.getRate();
    }

    function test_newUpdater_stillFencedByDeviationCap() public {
        vm.prank(safe);
        rp.setUpdater(leaked);
        vm.warp(block.timestamp + 6 minutes);
        vm.prank(leaked);
        vm.expectRevert(GuardedRateProvider.DeviationTooLarge.selector);
        rp.setRate(RATE * 2);
    }

    function test_newUpdater_stillFencedByCooldown() public {
        vm.prank(safe);
        rp.setUpdater(leaked);
        vm.prank(leaked);
        vm.expectRevert(GuardedRateProvider.TooSoon.selector);
        rp.setRate(RATE);
    }

    // ---- two-step ownership ----

    function test_ownership_twoStep() public {
        vm.prank(safe);
        rp.transferOwnership(stranger);
        assertEq(rp.owner(), safe, "owner must not change until accepted");
        assertEq(rp.pendingOwner(), stranger);
        vm.prank(stranger);
        rp.acceptOwnership();
        assertEq(rp.owner(), stranger);
        assertEq(rp.pendingOwner(), address(0));
    }

    function test_ownership_onlyPendingCanAccept() public {
        vm.prank(safe);
        rp.transferOwnership(stranger);
        vm.prank(keeper);
        vm.expectRevert(GuardedRateProvider.NotPendingOwner.selector);
        rp.acceptOwnership();
    }

    function test_ownership_onlyOwnerCanStart() public {
        vm.prank(keeper);
        vm.expectRevert(GuardedRateProvider.NotOwner.selector);
        rp.transferOwnership(keeper);
    }

    function test_ownership_rejectsZero() public {
        vm.prank(safe);
        vm.expectRevert(GuardedRateProvider.ZeroAddress.selector);
        rp.transferOwnership(address(0));
    }

    function test_frozenConstantsUnchanged() public view {
        assertEq(rp.MAX_DEVIATION_BPS(), 100);
        assertEq(rp.MIN_UPDATE_INTERVAL(), 5 minutes);
        assertEq(rp.STALENESS_WINDOW(), 6 hours);
    }

    function testFuzz_onlyOwnerRotates(address caller, address next) public {
        vm.assume(caller != safe && next != address(0));
        vm.prank(caller);
        vm.expectRevert(GuardedRateProvider.NotOwner.selector);
        rp.setUpdater(next);
    }
}

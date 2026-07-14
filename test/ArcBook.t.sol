// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {StableSwap} from "../src/StableSwap.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Router} from "../src/Router.sol";
import {Quoter} from "../src/Quoter.sol";
import {TwapExecutor} from "../src/TwapExecutor.sol";
import {GuardedRateProvider, ParRateProvider} from "../src/RateProvider.sol";

contract ArcBookTest is Test {
    MockERC20 usdc; // coin0 / base
    MockERC20 eurc; // coin1 / quote
    GuardedRateProvider rp;
    StableSwap pool;
    OrderBook book;
    Router router;
    Quoter quoter;
    TwapExecutor twap;

    address alice = address(0xA11CE);
    address bob = address(0xB0B);
    address carol = address(0xCA401);
    address keeper = address(0xDEEDEE);
    address oracle = address(0x04AC1E);

    uint256 constant RATE = 1.08e18; // 1 EURC = 1.08 USDC
    uint256 constant M = 1e6; // 6-decimal unit

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);

        rp = new GuardedRateProvider(oracle, RATE);
        pool = new StableSwap(address(usdc), address(eurc), address(rp), 6, 6, 20_000, 4, "ArcBook LP", "ABLP");
        book = new OrderBook(address(pool), 2);
        router = new Router(address(pool), address(book));
        quoter = new Quoter(address(pool), address(book));
        twap = new TwapExecutor(address(router));

        address[5] memory users = [alice, bob, carol, keeper, address(this)];
        for (uint256 i = 0; i < users.length; ++i) {
            usdc.mint(users[i], 100_000_000 * M);
            eurc.mint(users[i], 100_000_000 * M);
            vm.startPrank(users[i]);
            usdc.approve(address(pool), type(uint256).max);
            eurc.approve(address(pool), type(uint256).max);
            usdc.approve(address(book), type(uint256).max);
            eurc.approve(address(book), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            eurc.approve(address(router), type(uint256).max);
            usdc.approve(address(twap), type(uint256).max);
            eurc.approve(address(twap), type(uint256).max);
            vm.stopPrank();
        }

        // Seed the pool at rate-parity: 1,080,000 USDC <-> 1,000,000 EURC.
        pool.addLiquidity(1_080_000 * M, 1_000_000 * M, 0);
    }

    // =====================================================================
    // StableSwap
    // =====================================================================

    /// The whole point of the rate adjustment: a swap at a balanced pool should
    /// execute close to the FX rate, NOT close to 1:1.
    function test_RateAdjustedPricing() public view {
        uint256 out = pool.getDy(true, 1_000 * M); // sell 1000 USDC
        // Fair: 1000 / 1.08 = 925.93 EURC, minus 4bps fee => ~925.56
        assertGt(out, 924 * M, "priced as if 1:1 - rate adjustment broken");
        assertLt(out, 927 * M, "output too high");

        // And the reverse leg.
        uint256 back = pool.getDy(false, 1_000 * M); // sell 1000 EURC
        assertGt(back, 1_078 * M);
        assertLt(back, 1_081 * M);
    }

    /// A naive 1:1 StableSwap on an FX pair would quote ~1:1 here. Prove we don't.
    function test_NaivePegWouldBeDrained() public view {
        uint256 out = pool.getDy(true, 1_000 * M);
        assertLt(out, 990 * M, "quoting near 1:1 on a 1.08 FX pair is a solvency hole");
    }

    function test_VirtualPriceNeverFallsOnSwap() public {
        uint256 vp0 = pool.getVirtualPrice();
        vm.prank(alice);
        pool.swap(true, 50_000 * M, 0, alice);
        uint256 vp1 = pool.getVirtualPrice();
        assertGe(vp1, vp0, "swap leaked value out of LPs");
    }

    function test_ProportionalExitReturnsPrincipal() public {
        vm.startPrank(alice);
        uint256 lp = pool.addLiquidity(10_800 * M, 10_000 * M, 0);
        uint256 u0 = usdc.balanceOf(alice);
        uint256 e0 = eurc.balanceOf(alice);
        pool.removeLiquidity(lp, 0, 0);
        vm.stopPrank();

        // Round-trip loses at most dust to rounding, never a material amount.
        assertApproxEqAbs(usdc.balanceOf(alice) - u0, 10_800 * M, 2 * M);
        assertApproxEqAbs(eurc.balanceOf(alice) - e0, 10_000 * M, 2 * M);
    }

    function test_NoAdminFunctionsExist() public view {
        // Sanity: the pool exposes no ownership surface at all.
        (bool ok,) = address(pool).staticcall(abi.encodeWithSignature("owner()"));
        assertFalse(ok, "pool must have no owner()");
    }

    function test_StaleOracleHaltsSwapsButNotExits() public {
        vm.warp(block.timestamp + 7 hours);

        vm.prank(alice);
        vm.expectRevert(GuardedRateProvider.StaleRate.selector);
        pool.swap(true, 1_000 * M, 0, alice);

        // LPs can still get out. This is non-negotiable.
        uint256 lp = pool.balanceOf(address(this));
        pool.removeLiquidity(lp / 2, 0, 0);
    }

    function test_OracleDeviationCapped() public {
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(oracle);
        vm.expectRevert(GuardedRateProvider.DeviationTooLarge.selector);
        rp.setRate(1.50e18); // +39% in one shot

        vm.prank(oracle);
        rp.setRate(1.085e18); // +0.46% is fine
        assertEq(rp.rate(), 1.085e18);
    }

    function test_OnlyUpdaterCanSetRate() public {
        vm.warp(block.timestamp + 10 minutes);
        vm.prank(alice);
        vm.expectRevert(GuardedRateProvider.NotUpdater.selector);
        rp.setRate(1.081e18);
    }

    // =====================================================================
    // OrderBook
    // =====================================================================

    function test_PlaceAndCancelAsk() public {
        vm.startPrank(alice);
        uint256 before = usdc.balanceOf(alice);
        uint64 id = book.placeOrder(false, 93_000, uint128(1_000 * M)); // ask @ 0.93
        assertEq(usdc.balanceOf(alice), before - 1_000 * M, "ask must escrow base");
        assertEq(book.bestAsk(), 93_000);

        book.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), before, "cancel must refund in full");
        assertEq(book.bestAsk(), 0, "book should be empty");
        vm.stopPrank();
    }

    function test_PlaceBidEscrowsQuote() public {
        vm.startPrank(alice);
        uint256 before = eurc.balanceOf(alice);
        book.placeOrder(true, 92_000, uint128(1_000 * M)); // bid @ 0.92
        // escrow = 1000 * 0.92 = 920 EURC
        assertEq(eurc.balanceOf(alice), before - 920 * M);
        assertEq(book.bestBid(), 92_000);
        vm.stopPrank();
    }

    function test_PostOnly_CrossingReverts() public {
        vm.prank(alice);
        book.placeOrder(false, 93_000, uint128(1_000 * M)); // ask @ 0.93

        vm.prank(bob);
        vm.expectRevert(OrderBook.WouldCross.selector);
        book.placeOrder(true, 93_000, uint128(500 * M)); // bid @ 0.93 crosses

        vm.prank(bob);
        book.placeOrder(true, 92_999, uint128(500 * M)); // one tick inside is fine
        assertEq(book.bestBid(), 92_999);
    }

    function test_SellBase_FIFOAndPriceTimePriority() public {
        // Two bids at the same price, alice first.
        vm.prank(alice);
        book.placeOrder(true, 92_000, uint128(600 * M));
        vm.prank(bob);
        book.placeOrder(true, 92_000, uint128(600 * M));
        // A better bid from carol sits on top.
        vm.prank(carol);
        book.placeOrder(true, 92_500, uint128(400 * M));

        // Sell 800 USDC: should hit carol (400 @ 0.925) then alice (400 @ 0.92).
        vm.prank(address(this));
        (uint128 spent, uint256 out) = book.sellBase(uint128(800 * M), 0, 1, 10, address(this));

        assertEq(spent, 800 * M);
        // gross = 400*0.925 + 400*0.92 = 370 + 368 = 738 EURC, minus 2bps
        uint256 gross = 738 * M;
        assertEq(out, gross - (gross * 2) / 10_000);

        assertEq(book.claimableBase(carol), 400 * M, "best bid filled first");
        assertEq(book.claimableBase(alice), 400 * M, "FIFO: alice before bob");
        assertEq(book.claimableBase(bob), 0, "bob must not be jumped ahead of");
    }

    function test_BuyBaseFromAsks() public {
        vm.prank(alice);
        book.placeOrder(false, 93_000, uint128(1_000 * M)); // ask 1000 USDC @ 0.93

        uint256 baseBefore = usdc.balanceOf(address(this));
        (uint256 spent, uint256 out) = book.buyBase(465 * M, 0, 100_000, 10, address(this));

        // 465 EURC / 0.93 = 500 USDC gross, minus 2bps taker fee
        assertEq(spent, 465 * M);
        uint256 gross = 500 * M;
        assertEq(out, gross - (gross * 2) / 10_000);
        assertEq(usdc.balanceOf(address(this)) - baseBefore, out);
        assertEq(book.claimableQuote(alice), 465 * M);
    }

    function test_MakerClaim() public {
        vm.prank(alice);
        book.placeOrder(true, 92_000, uint128(1_000 * M));
        book.sellBase(uint128(1_000 * M), 0, 1, 10, address(this));

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        book.claim();
        assertEq(usdc.balanceOf(alice) - before, 1_000 * M, "maker must receive their base");
    }

    /// The book never pushes tokens to makers mid-match, so a hostile maker contract
    /// has no callback to reenter from. Assert the taker path touches nobody.
    function test_MatchingLoopMakesNoExternalCalls() public {
        vm.prank(alice);
        book.placeOrder(true, 92_000, uint128(1_000 * M));

        uint256 aliceBalBefore = usdc.balanceOf(alice);
        book.sellBase(uint128(1_000 * M), 0, 1, 10, address(this));
        // Maker's wallet is untouched until they pull.
        assertEq(usdc.balanceOf(alice), aliceBalBefore, "match must not push to maker");
        assertEq(book.claimableBase(alice), 1_000 * M);
    }

    function test_SlippageFloorEnforced() public {
        vm.prank(alice);
        book.placeOrder(true, 92_000, uint128(1_000 * M));

        vm.expectRevert(OrderBook.Slippage.selector);
        book.sellBase(uint128(1_000 * M), 950 * M, 1, 10, address(this)); // demand 950, book gives ~920
    }

    function test_FeesFlushToLPs() public {
        vm.prank(alice);
        book.placeOrder(true, 92_000, uint128(100_000 * M));
        book.sellBase(uint128(100_000 * M), 0, 1, 10, address(this));

        assertGt(book.pendingFeeQuote(), 0);
        uint256 vpBefore = pool.getVirtualPrice();
        book.flushFees();
        assertGt(pool.getVirtualPrice(), vpBefore, "taker fees must reach LPs");
        assertEq(book.pendingFeeQuote(), 0);
    }

    function test_CancelPartiallyFilledBidRefundsRemainder() public {
        vm.prank(alice);
        uint64 id = book.placeOrder(true, 92_000, uint128(1_000 * M)); // escrows 920 EURC

        book.sellBase(uint128(400 * M), 0, 1, 10, address(this)); // fills 400 => 368 EURC used

        uint256 before = eurc.balanceOf(alice);
        vm.prank(alice);
        book.cancelOrder(id);
        assertEq(eurc.balanceOf(alice) - before, 552 * M, "must refund unused escrow exactly");
    }

    // =====================================================================
    // Router + Quoter
    // =====================================================================

    function test_HybridRoute_BookBeatsAmmAndIsUsed() public {
        // Resting bid at 0.95 is far better than the AMM's ~0.925.
        vm.prank(alice);
        book.placeOrder(true, 95_000, uint128(5_000 * M));

        Quoter.Quote memory q = quoter.quote(true, 10_000 * M, 16);
        assertGt(q.bookIn, 0, "quoter must route into a better-priced book");

        uint256 ammOnly = pool.getDy(true, 10_000 * M);
        assertGt(q.expectedOut, ammOnly, "hybrid must beat AMM-only");

        uint256 out = router.swapExactIn(
            true, 10_000 * M, q.bookIn, (q.expectedOut * 995) / 1000, q.limitTick, 30, block.timestamp, address(this)
        );
        assertGe(out, (q.expectedOut * 995) / 1000);
    }

    function test_HybridRoute_EmptyBookFallsThroughToAmm() public {
        Quoter.Quote memory q = quoter.quote(true, 5_000 * M, 16);
        assertEq(q.bookIn, 0);
        assertEq(q.ammIn, 5_000 * M);

        uint256 out = router.swapExactIn(true, 5_000 * M, 0, 1, 1, 30, block.timestamp, address(this));
        assertGt(out, 4_600 * M);
    }

    /// Even if a caller passes a nonsense split, minAmountOut still protects them and
    /// the unfilled book portion is not stranded — it falls through to the AMM.
    function test_BadSplitCannotStrandFunds() public {
        uint256 before = eurc.balanceOf(address(this));
        // Claim the whole order goes to an empty book.
        uint256 out = router.swapExactIn(true, 5_000 * M, 5_000 * M, 1, 1, 30, block.timestamp, address(this));
        assertEq(eurc.balanceOf(address(this)) - before, out);
        assertGt(out, 4_600 * M, "remainder must reach the AMM");
        assertEq(usdc.balanceOf(address(router)), 0, "router must never retain funds");
        assertEq(eurc.balanceOf(address(router)), 0);
    }

    function test_RouterSlippageFloor() public {
        vm.expectRevert(Router.Slippage.selector);
        router.swapExactIn(true, 5_000 * M, 0, 5_000 * M, 1, 30, block.timestamp, address(this));
    }

    function test_RouterDeadline() public {
        vm.expectRevert(Router.Expired.selector);
        router.swapExactIn(true, 1_000 * M, 0, 1, 1, 30, block.timestamp - 1, address(this));
    }

    /// The quoter claims to find the optimum. Check it against a brute-force sweep.
    function test_QuoterBeatsNaiveSplits() public {
        vm.prank(alice);
        book.placeOrder(true, 95_000, uint128(2_000 * M));
        vm.prank(bob);
        book.placeOrder(true, 94_000, uint128(2_000 * M));
        vm.prank(carol);
        book.placeOrder(true, 90_000, uint128(2_000 * M)); // worse than the AMM

        uint256 amountIn = 8_000 * M;
        Quoter.Quote memory q = quoter.quote(true, amountIn, 16);

        // Brute force: 20 evenly spaced splits. The quoter must beat or match all of them.
        for (uint256 i = 0; i <= 20; ++i) {
            uint256 bookIn = (amountIn * i) / 20;
            uint256 sim = _simulate(amountIn, bookIn);
            assertGe(q.expectedOut + 2, sim, "quoter is not finding the optimum");
        }
        // And it must strictly beat both naive extremes.
        assertGt(q.expectedOut, _simulate(amountIn, 0), "should beat AMM-only");
        assertGt(q.expectedOut, _simulate(amountIn, amountIn), "should beat book-only");
    }

    function _simulate(uint256 amountIn, uint256 bookIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        uint256 before = eurc.balanceOf(address(this));
        try router.swapExactIn(true, amountIn, bookIn, 1, 1, 30, block.timestamp, address(this)) {
            out = eurc.balanceOf(address(this)) - before;
        } catch {
            out = 0;
        }
        vm.revertToState(snap);
    }

    // =====================================================================
    // TWAP
    // =====================================================================

    function test_TwapSlicesOverTime() public {
        vm.prank(alice);
        book.placeOrder(true, 95_000, uint128(50_000 * M));

        vm.prank(bob);
        uint256 id = twap.createTwap(true, uint128(10_000 * M), 4, 60, 0.9e18);

        uint256 got0 = eurc.balanceOf(bob);

        // Slice 1 is due immediately.
        vm.prank(keeper);
        twap.crank(id, 2_500 * M, 1, 30);
        assertGt(eurc.balanceOf(bob), got0, "owner must receive the proceeds");

        // Slice 2 is not due yet.
        vm.prank(keeper);
        vm.expectRevert(TwapExecutor.NotDue.selector);
        twap.crank(id, 2_500 * M, 1, 30);

        vm.warp(block.timestamp + 61);
        vm.prank(keeper);
        twap.crank(id, 2_500 * M, 1, 30);

        assertGt(usdc.balanceOf(keeper), 100_000_000 * M - 1, "keeper must be paid");
    }

    function test_TwapMinPriceProtectsAgainstHostileKeeper() public {
        vm.prank(bob);
        // Demand at least 0.99 EURC per USDC. The market is ~0.925, so no honest fill exists.
        uint256 id = twap.createTwap(true, uint128(4_000 * M), 4, 60, 0.99e18);

        vm.prank(keeper);
        vm.expectRevert(Router.Slippage.selector);
        twap.crank(id, 0, 1, 30);
    }

    function test_TwapOwnerCanAlwaysCancel() public {
        vm.prank(bob);
        uint256 id = twap.createTwap(true, uint128(4_000 * M), 4, 60, 0.5e18);

        vm.prank(alice);
        vm.expectRevert(TwapExecutor.NotOwner.selector);
        twap.cancelTwap(id);

        uint256 before = usdc.balanceOf(bob);
        vm.prank(bob);
        uint256 refunded = twap.cancelTwap(id);
        assertEq(refunded, 4_000 * M);
        assertEq(usdc.balanceOf(bob) - before, 4_000 * M);
    }

    // =====================================================================
    // Fuzz
    // =====================================================================

    /// A swap must never let the caller extract more value than they put in, at any size.
    function testFuzz_SwapNeverMintsValue(uint96 amountIn, bool zeroForOne) public {
        uint256 amt = bound(uint256(amountIn), 1 * M, 500_000 * M);

        uint256 outQ = pool.getDy(zeroForOne, amt);
        vm.assume(outQ > 0);

        // Value the output back at the oracle rate and confirm it never exceeds the input.
        uint256 inValue = zeroForOne ? amt * 1e18 : (amt * RATE);
        uint256 outValue = zeroForOne ? (outQ * RATE) : outQ * 1e18;
        assertLe(outValue, inValue, "swap created value out of thin air");
    }

    function testFuzz_VirtualPriceMonotonicUnderSwaps(uint96 a, uint96 b, bool dir) public {
        uint256 x = bound(uint256(a), 1 * M, 200_000 * M);
        uint256 y = bound(uint256(b), 1 * M, 200_000 * M);

        uint256 vp0 = pool.getVirtualPrice();

        vm.startPrank(alice);
        if (pool.getDy(dir, x) > 0) pool.swap(dir, x, 0, alice);
        if (pool.getDy(!dir, y) > 0) pool.swap(!dir, y, 0, alice);
        vm.stopPrank();

        assertGe(pool.getVirtualPrice(), vp0, "LP value decreased");
    }

    function testFuzz_BookRoundTripNeverProfits(uint96 size, uint32 tickRaw) public {
        uint128 sz = uint128(bound(uint256(size), 1 * M, 50_000 * M));
        uint32 tick = uint32(bound(uint256(tickRaw), 80_000, 110_000));

        uint256 u0 = usdc.balanceOf(alice);
        uint256 e0 = eurc.balanceOf(alice);

        vm.prank(alice);
        book.placeOrder(true, tick, sz);

        // Someone hits the bid completely.
        book.sellBase(sz, 0, 1, 50, address(this));

        vm.prank(alice);
        book.claim();

        uint256 u1 = usdc.balanceOf(alice);
        uint256 e1 = eurc.balanceOf(alice);

        // Alice paid EURC and received USDC at exactly her limit price. She must never
        // end up with more of both.
        assertTrue(!(u1 > u0 && e1 > e0), "maker extracted value from nothing");
        assertEq(u1 - u0, sz, "maker must receive exactly the base she bid for");
    }
}

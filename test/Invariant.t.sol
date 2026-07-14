// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {StableSwap} from "../src/StableSwap.sol";
import {OrderBook} from "../src/OrderBook.sol";
import {Router} from "../src/Router.sol";
import {GuardedRateProvider} from "../src/RateProvider.sol";

/// @notice Drives random-but-valid sequences of actions at the protocol.
contract Handler is Test {
    MockERC20 public usdc;
    MockERC20 public eurc;
    StableSwap public pool;
    OrderBook public book;
    Router public router;

    address[] public actors;
    uint64[] public orderIds;

    uint256 constant M = 1e6;

    constructor(MockERC20 u, MockERC20 e, StableSwap p, OrderBook b, Router r) {
        usdc = u;
        eurc = e;
        pool = p;
        book = b;
        router = r;

        for (uint256 i = 0; i < 5; ++i) {
            address a = address(uint160(0x1000 + i));
            actors.push(a);
            usdc.mint(a, 10_000_000 * M);
            eurc.mint(a, 10_000_000 * M);
            vm.startPrank(a);
            usdc.approve(address(book), type(uint256).max);
            eurc.approve(address(book), type(uint256).max);
            usdc.approve(address(router), type(uint256).max);
            eurc.approve(address(router), type(uint256).max);
            vm.stopPrank();
        }
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function orderIdsLength() external view returns (uint256) {
        return orderIds.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function placeBid(uint256 actorSeed, uint32 tick, uint128 size) external {
        address a = _actor(actorSeed);
        tick = uint32(bound(uint256(tick), 50_000, 105_000));
        size = uint128(bound(uint256(size), 1 * M, 100_000 * M));

        uint32 ba = book.bestAsk();
        if (ba != 0 && tick >= ba) return; // post-only; skip rather than revert

        vm.prank(a);
        try book.placeOrder(true, tick, size) returns (uint64 id) {
            orderIds.push(id);
        } catch {}
    }

    function placeAsk(uint256 actorSeed, uint32 tick, uint128 size) external {
        address a = _actor(actorSeed);
        tick = uint32(bound(uint256(tick), 105_001, 160_000));
        size = uint128(bound(uint256(size), 1 * M, 100_000 * M));

        uint32 bb = book.bestBid();
        if (bb != 0 && tick <= bb) return;

        vm.prank(a);
        try book.placeOrder(false, tick, size) returns (uint64 id) {
            orderIds.push(id);
        } catch {}
    }

    function cancel(uint256 actorSeed, uint256 idxSeed) external {
        if (orderIds.length == 0) return;
        uint64 id = orderIds[idxSeed % orderIds.length];
        address a = _actor(actorSeed);
        vm.prank(a);
        try book.cancelOrder(id) {} catch {}
    }

    function sellBase(uint256 actorSeed, uint128 amount) external {
        address a = _actor(actorSeed);
        amount = uint128(bound(uint256(amount), 1 * M, 200_000 * M));
        vm.prank(a);
        try book.sellBase(amount, 0, 1, 30, a) {} catch {}
    }

    function buyBase(uint256 actorSeed, uint128 amount) external {
        address a = _actor(actorSeed);
        uint256 amt = bound(uint256(amount), 1 * M, 200_000 * M);
        vm.prank(a);
        try book.buyBase(amt, 0, 0, 30, a) {} catch {}
    }

    function routeSwap(uint256 actorSeed, uint128 amount, bool dir, uint128 bookPart) external {
        address a = _actor(actorSeed);
        uint256 amt = bound(uint256(amount), 1 * M, 100_000 * M);
        uint256 bp = bound(uint256(bookPart), 0, amt);
        vm.prank(a);
        try router.swapExactIn(dir, amt, bp, 0, dir ? 1 : 0, 30, block.timestamp, a) {} catch {}
    }

    function claim(uint256 actorSeed) external {
        address a = _actor(actorSeed);
        vm.prank(a);
        try book.claim() {} catch {}
    }

    function flush() external {
        try book.flushFees() {} catch {}
    }
}

contract ArcBookInvariants is Test {
    MockERC20 usdc;
    MockERC20 eurc;
    GuardedRateProvider rp;
    StableSwap pool;
    OrderBook book;
    Router router;
    Handler handler;

    uint256 constant M = 1e6;
    uint256 lastVirtualPrice;

    function setUp() public {
        usdc = new MockERC20("USD Coin", "USDC", 6);
        eurc = new MockERC20("Euro Coin", "EURC", 6);
        rp = new GuardedRateProvider(address(this), 1.08e18);

        pool = new StableSwap(address(usdc), address(eurc), address(rp), 6, 6, 20_000, 4, "ArcBook LP", "ABLP");
        book = new OrderBook(address(pool), 2);
        router = new Router(address(pool), address(book));

        usdc.mint(address(this), 10_000_000 * M);
        eurc.mint(address(this), 10_000_000 * M);
        usdc.approve(address(pool), type(uint256).max);
        eurc.approve(address(pool), type(uint256).max);
        pool.addLiquidity(1_080_000 * M, 1_000_000 * M, 0);

        lastVirtualPrice = pool.getVirtualPrice();

        handler = new Handler(usdc, eurc, pool, book, router);
        targetContract(address(handler));
    }

    /// THE critical property. The book must always hold enough tokens to honour every
    /// obligation it has recorded: maker claims, resting escrow, and unflushed fees.
    /// If this can ever be broken, someone's funds are gone.
    function invariant_BookIsSolvent() public view {
        uint256 owedBase = book.pendingFeeBase();
        uint256 owedQuote = book.pendingFeeQuote();

        uint256 n = handler.actorsLength();
        for (uint256 i = 0; i < n; ++i) {
            address a = handler.actors(i);
            owedBase += book.claimableBase(a);
            owedQuote += book.claimableQuote(a);
        }

        uint256 m = handler.orderIdsLength();
        for (uint256 i = 0; i < m; ++i) {
            uint64 id = handler.orderIds(i);
            (, , bool isBid, bool active, uint128 amount, uint128 filled, uint128 quoteEscrow, ,) = book.orders(id);
            if (!active) continue;
            if (isBid) {
                owedQuote += quoteEscrow;
            } else {
                owedBase += (amount - filled);
            }
        }

        assertGe(usdc.balanceOf(address(book)), owedBase, "ORDERBOOK INSOLVENT IN BASE");
        assertGe(eurc.balanceOf(address(book)), owedQuote, "ORDERBOOK INSOLVENT IN QUOTE");
    }

    /// LP share value must never decrease. Fees and donations may raise it; nothing may
    /// lower it. A single violation means a swap or a deposit is leaking LP funds.
    function invariant_PoolVirtualPriceNeverDecreases() public {
        uint256 vp = pool.getVirtualPrice();
        assertGe(vp, lastVirtualPrice, "LP VALUE LEAKED");
        lastVirtualPrice = vp;
    }

    /// The router is a pass-through. It must never be holding user funds at rest.
    function invariant_RouterHoldsNothing() public view {
        assertEq(usdc.balanceOf(address(router)), 0);
        assertEq(eurc.balanceOf(address(router)), 0);
    }

    /// The book's own accounting must agree with itself: the best bid can never sit at
    /// or above the best ask, or the book is crossed and post-only has failed.
    function invariant_BookNeverCrossed() public view {
        uint32 bb = book.bestBid();
        uint32 ba = book.bestAsk();
        if (bb != 0 && ba != 0) {
            assertLt(bb, ba, "BOOK IS CROSSED");
        }
    }
}

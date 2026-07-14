// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {StableSwap} from "./StableSwap.sol";
import {OrderBook} from "./OrderBook.sol";

/// @title Router
/// @notice Single entry point for takers. Sweeps the order book first, then routes the
///         remainder to the StableSwap pool, and enforces one slippage bound over the
///         combined result.
///
/// @dev The split is supplied by the caller (see Quoter.sol, which computes the optimum
///      as a free view call). This is deliberate and it is safe:
///        - A bad split cannot steal anything. It can only give the taker a worse price,
///          and `minAmountOut` puts a hard floor under that.
///        - The book leg is self-correcting: if it fills less than requested — because
///          it ran out of depth, or hit the maxOrders gas bound, or lost a race — the
///          unspent remainder falls through to the AMM instead of being stranded.
///      NO ADMIN. Holds no funds between transactions. Nothing to rescue, nothing to rug.
contract Router is ReentrancyGuard {
    using SafeERC20 for IERC20;

    StableSwap public immutable pool;
    OrderBook public immutable book;
    IERC20 public immutable base; // coin0
    IERC20 public immutable quote; // coin1

    error Expired();
    error Slippage();
    error ZeroAmount();
    error BadParams();

    event Routed(
        address indexed taker,
        bool zeroForOne,
        uint256 amountIn,
        uint256 bookIn,
        uint256 bookOut,
        uint256 ammIn,
        uint256 ammOut
    );

    modifier ensure(uint256 deadline) {
        if (block.timestamp > deadline) revert Expired();
        _;
    }

    constructor(address pool_, address book_) {
        if (pool_ == address(0) || book_ == address(0)) revert BadParams();
        pool = StableSwap(pool_);
        book = OrderBook(book_);
        base = IERC20(address(StableSwap(pool_).coin0()));
        quote = IERC20(address(StableSwap(pool_).coin1()));
        if (address(book.pool()) != pool_) revert BadParams();
    }

    /// @param zeroForOne True = sell BASE for QUOTE. False = sell QUOTE for BASE.
    /// @param amountIn Total input.
    /// @param bookAmountIn How much of `amountIn` to attempt against the order book.
    /// @param minAmountOut Floor on the COMBINED output. The only protection that matters.
    /// @param limitTick Worst acceptable book price (min tick when selling base, max when buying).
    /// @param maxOrders Gas bound on resting orders consumed.
    function swapExactIn(
        bool zeroForOne,
        uint256 amountIn,
        uint256 bookAmountIn,
        uint256 minAmountOut,
        uint32 limitTick,
        uint16 maxOrders,
        uint256 deadline,
        address to
    ) public nonReentrant ensure(deadline) returns (uint256 amountOut) {
        if (amountIn == 0) revert ZeroAmount();
        if (bookAmountIn > amountIn) revert BadParams();
        if (to == address(0)) revert BadParams();
        // The book denominates base size in uint128; refuse rather than silently truncate.
        if (zeroForOne && bookAmountIn > type(uint128).max) revert BadParams();

        IERC20 tokenIn = zeroForOne ? base : quote;
        tokenIn.safeTransferFrom(msg.sender, address(this), amountIn);

        uint256 bookSpent;
        uint256 bookOut;

        if (bookAmountIn > 0 && maxOrders > 0) {
            tokenIn.forceApprove(address(book), bookAmountIn);

            if (zeroForOne) {
                try book.sellBase(uint128(bookAmountIn), 0, limitTick, maxOrders, to) returns (
                    uint128 spent, uint256 out
                ) {
                    bookSpent = spent;
                    bookOut = out;
                } catch {
                    // Book had no crossable depth. Everything falls through to the AMM.
                }
            } else {
                try book.buyBase(bookAmountIn, 0, limitTick, maxOrders, to) returns (uint256 spent, uint256 out) {
                    bookSpent = spent;
                    bookOut = out;
                } catch {}
            }

            // Never leave a dangling allowance.
            tokenIn.forceApprove(address(book), 0);
        }

        uint256 ammIn = amountIn - bookSpent;
        uint256 ammOut;

        if (ammIn > 0) {
            tokenIn.forceApprove(address(pool), ammIn);
            ammOut = pool.swap(zeroForOne, ammIn, 0, to);
            tokenIn.forceApprove(address(pool), 0);
        }

        amountOut = bookOut + ammOut;
        if (amountOut < minAmountOut) revert Slippage();

        emit Routed(msg.sender, zeroForOne, amountIn, bookSpent, bookOut, ammIn, ammOut);
    }

    /// @notice One-signature swap: EIP-2612 permit + route, no separate approve tx.
    /// @dev The permit is wrapped in try/catch so a griefer front-running the permit
    ///      (a known EIP-2612 nuisance) cannot brick the swap — if the allowance is
    ///      already in place the swap simply proceeds.
    function swapExactInWithPermit(
        bool zeroForOne,
        uint256 amountIn,
        uint256 bookAmountIn,
        uint256 minAmountOut,
        uint32 limitTick,
        uint16 maxOrders,
        uint256 deadline,
        address to,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256) {
        IERC20 tokenIn = zeroForOne ? base : quote;

        // Low-level call, deliberately, and the result is deliberately ignored.
        //
        // Permit front-running is a known EIP-2612 grief: anyone watching the mempool can
        // replay your signature ahead of you, burning the nonce, so that your own permit
        // reverts and takes the swap down with it. Firing the permit and ignoring whether
        // it landed means the swap proceeds either way — the allowance is in place
        // regardless of who submitted it. If it genuinely failed, the transferFrom below
        // reverts on its own.
        (bool ok,) = address(tokenIn).call(
            abi.encodeWithSelector(IERC20Permit.permit.selector, msg.sender, address(this), amountIn, deadline, v, r, s)
        );
        ok; // deliberately unchecked

        return swapExactIn(zeroForOne, amountIn, bookAmountIn, minAmountOut, limitTick, maxOrders, deadline, to);
    }
}

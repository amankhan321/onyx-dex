// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {StableMath} from "./libraries/StableMath.sol";
import {IRateProvider} from "./RateProvider.sol";

/// @title StableSwap
/// @notice Rate-adjusted 2-coin StableSwap pool. Backstop liquidity for the ArcBook CLOB.
///
/// @dev Design commitments, deliberately load-bearing:
///      - NO ADMIN. No owner, no pauser, no upgrade path, no fee switch, no rescue
///        function. Once deployed, nobody — including the deployer — can move LP funds.
///      - Every parameter (amp, fee, tokens, rate provider) is immutable.
///      - Balances are tracked internally, never read from balanceOf(). Direct token
///        transfers into this contract are ignored, not stolen and not credited.
///      - Coin1 is rate-adjusted into coin0 terms before touching the invariant, so the
///        curve's 1:1 peg assumption is actually true. This is what makes the pool safe
///        for a non-par FX pair like USDC/EURC.
///      - Proportional withdrawal only. There is no removeLiquidityOneCoin; imbalanced
///        exit is the classic place StableSwap forks get drained, and we don't need it.
contract StableSwap is ERC20, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant FEE_DENOM = 10_000;
    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable coin0;
    IERC20 public immutable coin1;
    IRateProvider public immutable rateProvider;

    /// @dev Multipliers that scale raw token units up to 1e18.
    uint256 public immutable mul0;
    uint256 public immutable mul1;

    /// @dev Amplification, pre-multiplied by StableMath.A_PRECISION (100).
    uint256 public immutable amp;
    /// @dev Swap fee in basis points. Accrues entirely to LPs.
    uint256 public immutable feeBps;

    uint256 public balance0;
    uint256 public balance1;

    error ZeroAmount();
    error Slippage();
    error InvalidToken();
    error TooManyDecimals();
    error BadParams();
    error InsufficientLiquidity();

    event AddLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpMinted);
    event RemoveLiquidity(address indexed provider, uint256 amount0, uint256 amount1, uint256 lpBurned);
    event Swap(address indexed caller, bool zeroForOne, uint256 amountIn, uint256 amountOut);
    event Donate(address indexed from, uint256 amount0, uint256 amount1);

    constructor(
        address coin0_,
        address coin1_,
        address rateProvider_,
        uint8 decimals0_,
        uint8 decimals1_,
        uint256 amp_,
        uint256 feeBps_,
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) {
        if (coin0_ == address(0) || coin1_ == address(0) || rateProvider_ == address(0)) revert BadParams();
        if (coin0_ == coin1_) revert BadParams();
        // amp is A * 100. Sane band: A in [1, 5000].
        if (amp_ < 100 || amp_ > 500_000) revert BadParams();
        // Hard-capped at 1% so a fat-fingered deploy can't create a fee trap.
        if (feeBps_ > 100) revert BadParams();
        if (decimals0_ > 18 || decimals1_ > 18) revert TooManyDecimals();

        coin0 = IERC20(coin0_);
        coin1 = IERC20(coin1_);
        rateProvider = IRateProvider(rateProvider_);
        amp = amp_;
        feeBps = feeBps_;

        // Decimals are passed in, NOT read from the token.
        //
        // On Arc, USDC is a system precompile at 0x3600...0000 with no EVM bytecode.
        // Solidity emits an extcodesize check before every typed external call and
        // reverts when the target has no code, so `IERC20Metadata(usdc).decimals()`
        // reverts with "call to non-contract address" — on-chain and in simulation.
        // OZ's SafeERC20 sidesteps this (it uses raw assembly `call` with no codesize
        // precheck), which is why transfers still work. Reading metadata does not.
        mul0 = 10 ** (18 - decimals0_);
        mul1 = 10 ** (18 - decimals1_);
    }

    // ---------------------------------------------------------------------
    // Normalisation
    // ---------------------------------------------------------------------

    /// @dev Rate-adjusted, 1e18-normalised balances. This is the only representation
    ///      the invariant is ever allowed to see.
    function _xp(uint256 b0, uint256 b1, uint256 rate) internal view returns (uint256 xp0, uint256 xp1) {
        xp0 = b0 * mul0;
        xp1 = (b1 * mul1 * rate) / PRECISION;
    }

    function getVirtualPrice() external view returns (uint256) {
        uint256 supply = totalSupply();
        if (supply == 0) return PRECISION;
        uint256 rate = rateProvider.getRate();
        (uint256 xp0, uint256 xp1) = _xp(balance0, balance1, rate);
        return (StableMath.getD(xp0, xp1, amp) * PRECISION) / supply;
    }

    // ---------------------------------------------------------------------
    // Quoting
    // ---------------------------------------------------------------------

    /// @notice Output of swapping `amountIn` with the pool's current state.
    /// @param zeroForOne True to pay coin0 and receive coin1.
    function getDy(bool zeroForOne, uint256 amountIn) public view returns (uint256) {
        if (amountIn == 0) return 0;
        uint256 supply = totalSupply();
        if (supply == 0) return 0;

        uint256 rate = rateProvider.getRate();
        (uint256 xp0, uint256 xp1) = _xp(balance0, balance1, rate);
        if (xp0 == 0 || xp1 == 0) return 0;

        uint256 d = StableMath.getD(xp0, xp1, amp);

        uint256 xIn;
        uint256 xpOutOld;
        if (zeroForOne) {
            xIn = xp0 + amountIn * mul0;
            xpOutOld = xp1;
        } else {
            xIn = xp1 + (amountIn * mul1 * rate) / PRECISION;
            xpOutOld = xp0;
        }

        uint256 y = StableMath.getY(xIn, d, amp);
        if (y >= xpOutOld) return 0;

        // -1 protects the invariant against rounding in the pool's favour.
        uint256 dyNorm = xpOutOld - y - 1;
        dyNorm -= (dyNorm * feeBps) / FEE_DENOM;

        if (zeroForOne) {
            // dyNorm is in coin0 terms; convert back through the rate into coin1 units.
            return (dyNorm * PRECISION) / (rate * mul1);
        } else {
            return dyNorm / mul0;
        }
    }

    // ---------------------------------------------------------------------
    // Swap
    // ---------------------------------------------------------------------

    function swap(bool zeroForOne, uint256 amountIn, uint256 minAmountOut, address to)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        if (to == address(0)) revert BadParams();

        amountOut = getDy(zeroForOne, amountIn);
        if (amountOut == 0) revert InsufficientLiquidity();
        if (amountOut < minAmountOut) revert Slippage();

        // Effects before interactions.
        if (zeroForOne) {
            balance0 += amountIn;
            balance1 -= amountOut;
        } else {
            balance1 += amountIn;
            balance0 -= amountOut;
        }

        (IERC20 tIn, IERC20 tOut) = zeroForOne ? (coin0, coin1) : (coin1, coin0);
        tIn.safeTransferFrom(msg.sender, address(this), amountIn);
        tOut.safeTransfer(to, amountOut);

        emit Swap(msg.sender, zeroForOne, amountIn, amountOut);
    }

    // ---------------------------------------------------------------------
    // Liquidity
    // ---------------------------------------------------------------------

    function addLiquidity(uint256 amount0, uint256 amount1, uint256 minLp)
        external
        nonReentrant
        returns (uint256 lpMinted)
    {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();

        uint256 rate = rateProvider.getRate();
        uint256 supply = totalSupply();

        uint256 b0 = balance0;
        uint256 b1 = balance1;

        (uint256 oldXp0, uint256 oldXp1) = _xp(b0, b1, rate);
        uint256 d0 = supply == 0 ? 0 : StableMath.getD(oldXp0, oldXp1, amp);

        uint256 new0 = b0 + amount0;
        uint256 new1 = b1 + amount1;
        if (new0 == 0 || new1 == 0) revert ZeroAmount();

        (uint256 newXp0, uint256 newXp1) = _xp(new0, new1, rate);
        uint256 d1 = StableMath.getD(newXp0, newXp1, amp);

        if (supply == 0) {
            lpMinted = d1;
        } else {
            // Curve's imbalance fee. Charged on the deviation from a proportional
            // deposit, and retained by the pool (there is no admin cut), so an
            // imbalanced depositor cannot round-trip value out of existing LPs.
            // _fee = feeBps * N / (4 * (N-1)) => for N = 2 this is feeBps / 2.
            uint256 imbFee = feeBps / 2;

            uint256 ideal0 = (d1 * oldXp0) / d0;
            uint256 ideal1 = (d1 * oldXp1) / d0;

            uint256 diff0 = newXp0 > ideal0 ? newXp0 - ideal0 : ideal0 - newXp0;
            uint256 diff1 = newXp1 > ideal1 ? newXp1 - ideal1 : ideal1 - newXp1;

            uint256 afterFee0 = newXp0 - (diff0 * imbFee) / FEE_DENOM;
            uint256 afterFee1 = newXp1 - (diff1 * imbFee) / FEE_DENOM;

            uint256 d2 = StableMath.getD(afterFee0, afterFee1, amp);
            lpMinted = (supply * (d2 - d0)) / d0;
        }

        if (lpMinted == 0) revert ZeroAmount();
        if (lpMinted < minLp) revert Slippage();

        balance0 = new0;
        balance1 = new1;

        if (amount0 > 0) coin0.safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) coin1.safeTransferFrom(msg.sender, address(this), amount1);

        _mint(msg.sender, lpMinted);
        emit AddLiquidity(msg.sender, amount0, amount1, lpMinted);
    }

    /// @notice Proportional exit. Always available, never blocked, no oracle dependency.
    /// @dev Deliberately does not call the rate provider: LPs must be able to leave even
    ///      if the oracle is stale and every other function is halted.
    function removeLiquidity(uint256 lpAmount, uint256 min0, uint256 min1)
        external
        nonReentrant
        returns (uint256 amount0, uint256 amount1)
    {
        if (lpAmount == 0) revert ZeroAmount();
        uint256 supply = totalSupply();

        amount0 = (balance0 * lpAmount) / supply;
        amount1 = (balance1 * lpAmount) / supply;
        if (amount0 < min0 || amount1 < min1) revert Slippage();

        balance0 -= amount0;
        balance1 -= amount1;

        _burn(msg.sender, lpAmount);

        if (amount0 > 0) coin0.safeTransfer(msg.sender, amount0);
        if (amount1 > 0) coin1.safeTransfer(msg.sender, amount1);

        emit RemoveLiquidity(msg.sender, amount0, amount1, lpAmount);
    }

    /// @notice Add tokens to the reserves without minting LP. Raises the virtual price.
    /// @dev This is how OrderBook taker fees reach LPs. Permissionless by design —
    ///      the only thing a caller can do here is give the pool money.
    function donate(uint256 amount0, uint256 amount1) external nonReentrant {
        if (amount0 == 0 && amount1 == 0) revert ZeroAmount();
        if (totalSupply() == 0) revert InsufficientLiquidity();

        balance0 += amount0;
        balance1 += amount1;

        if (amount0 > 0) coin0.safeTransferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) coin1.safeTransferFrom(msg.sender, address(this), amount1);

        emit Donate(msg.sender, amount0, amount1);
    }
}

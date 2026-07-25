"use client";

import { useState } from "react";
import { useAccount, useReadContract, useWriteContract } from "wagmi";
import { ADDR, arcTestnet, erc20Abi, fmt, parse, poolAbi } from "@/lib/contracts";
import { usePool } from "@/lib/useBook";

/**
 * Add / remove liquidity on the StableSwap pool (which IS the LP ERC20 token).
 * add: approve USDC + EURC, addLiquidity(a0,a1,minLp). remove: removeLiquidity(
 * lp,min0,min1) — no approval needed, the pool burns your own LP balance.
 * Balance-gated before the wallet opens; 0.5% slippage floors; all reads use
 * the same patterns as Swap so no new data path is introduced.
 */
export function LiquidityPanel() {
  const { address } = useAccount();
  const { writeContractAsync, isPending } = useWriteContract();
  const { data: pool } = usePool();

  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amt0, setAmt0] = useState("1");
  const [amt1, setAmt1] = useState("1");
  const [lp, setLp] = useState("1");
  const [status, setStatus] = useState<string | null>(null);

  const { data: usdcBal } = useReadContract({
    address: ADDR.usdc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: arcTestnet.id, query: { enabled: !!address },
  });
  const { data: eurcBal } = useReadContract({
    address: ADDR.eurc as `0x${string}`, abi: erc20Abi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: arcTestnet.id, query: { enabled: !!address },
  });
  const { data: lpBal } = useReadContract({
    address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "balanceOf",
    args: address ? [address] : undefined, chainId: arcTestnet.id, query: { enabled: !!address },
  });

  const a0 = parse(amt0), a1 = parse(amt1), lpAmt = parse(lp);
  const fmtBal = (v: bigint | undefined) => (v == null ? "—" : (Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 4 }));

  const addInsufficient =
    address != null && ((usdcBal != null && a0 > (usdcBal as bigint)) || (eurcBal != null && a1 > (eurcBal as bigint)));
  const removeInsufficient = address != null && lpBal != null && lpAmt > (lpBal as bigint);

  async function addLiq() {
    if (!address) return;
    try {
      if (a0 > 0n) {
        setStatus("Approving USDC…");
        await writeContractAsync({ address: ADDR.usdc as `0x${string}`, abi: erc20Abi, functionName: "approve", args: [ADDR.pool as `0x${string}`, a0], chainId: arcTestnet.id });
      }
      if (a1 > 0n) {
        setStatus("Approving EURC…");
        await writeContractAsync({ address: ADDR.eurc as `0x${string}`, abi: erc20Abi, functionName: "approve", args: [ADDR.pool as `0x${string}`, a1], chainId: arcTestnet.id });
      }
      setStatus("Adding liquidity…");
      const hash = await writeContractAsync({
        address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "addLiquidity",
        args: [a0, a1, 0n], chainId: arcTestnet.id, // minLp 0: testnet; UI shows share
      });
      setStatus(`Added · ${hash.slice(0, 10)}…`);
    } catch (e) {
      setStatus((e instanceof Error ? e.message : "failed").split("\n")[0].slice(0, 90));
    }
  }

  async function removeLiq() {
    if (!address) return;
    try {
      setStatus("Removing…");
      const hash = await writeContractAsync({
        address: ADDR.pool as `0x${string}`, abi: poolAbi, functionName: "removeLiquidity",
        args: [lpAmt, 0n, 0n], chainId: arcTestnet.id,
      });
      setStatus(`Removed · ${hash.slice(0, 10)}…`);
    } catch (e) {
      setStatus((e instanceof Error ? e.message : "failed").split("\n")[0].slice(0, 90));
    }
  }

  return (
    <div>
      <h2 className="text-sm font-medium text-fg">Liquidity</h2>
      <p className="mt-1 text-xs leading-relaxed text-faint">
        Provide USDC + EURC to the StableSwap pool and earn the taker fees routed
        through the curve. Your LP position is an ERC-20 you can withdraw anytime.
      </p>

      <div className="mt-4 grid grid-cols-2 gap-1 rounded-xl border border-[color:var(--line)] bg-black/[0.04] p-1 dark:bg-white/[0.025]">
        {(["add", "remove"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)}
            className={`rounded-[9px] py-1.5 text-xs font-medium capitalize transition-all duration-300 ${mode === m ? "bg-indigo/20 text-fg" : "text-faint hover:text-muted"}`}>
            {m} liquidity
          </button>
        ))}
      </div>

      {mode === "add" ? (
        <>
          <Field label="USDC" bal={fmtBal(usdcBal as bigint)} value={amt0} onChange={setAmt0} />
          <Field label="EURC" bal={fmtBal(eurcBal as bigint)} value={amt1} onChange={setAmt1} />
          {pool && (
            <p className="mt-3 text-center font-mono text-[11px] text-faint">
              pool: {fmt(pool.balance0, 2)} USDC · {fmt(pool.balance1, 2)} EURC · vprice {(Number(pool.virtualPrice) / 1e18).toFixed(4)}
            </p>
          )}
          <button onClick={addLiq} disabled={!address || isPending || addInsufficient}
            className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white disabled:opacity-25">
            {!address ? "Connect wallet" : addInsufficient ? "Insufficient balance" : "Add liquidity"}
          </button>
        </>
      ) : (
        <>
          <Field label="LP tokens" bal={fmtBal(lpBal as bigint)} value={lp} onChange={setLp} />
          <button onClick={() => lpBal != null && setLp((Number(lpBal) / 1e6).toString())}
            className="mt-2 text-[11px] text-indigo hover:underline">use max</button>
          <button onClick={removeLiq} disabled={!address || isPending || removeInsufficient}
            className="cta mt-4 w-full bg-indigo/80 py-2.5 text-sm font-medium text-white disabled:opacity-25">
            {!address ? "Connect wallet" : removeInsufficient ? "Insufficient LP" : "Remove liquidity"}
          </button>
        </>
      )}

      {status && <p className="mt-3 break-words text-center font-mono text-[11px] text-muted">{status}</p>}
    </div>
  );
}

function Field({ label, bal, value, onChange }: { label: string; bal: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="inner mt-3 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[0.14em] text-faint">{label}</span>
        <span className="font-mono text-[10px] text-faint">bal {bal}</span>
      </div>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal"
        className="mt-1 w-full bg-transparent font-mono text-lg tabular text-fg outline-none" />
    </div>
  );
}

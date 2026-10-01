"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, apiPost, type Funds, type Order, type OrderType, type Prefs, type Product, type Side } from "@/lib/api";
import { useBrokerStatus } from "@/lib/broker-status";
import { formatPrice } from "@/lib/format";
import { useTick } from "@/lib/market-socket";
import { useApi } from "@/lib/use-api";
import { ConfirmDialog } from "./confirm-dialog";

const ORDER_TYPES: { id: OrderType; label: string }[] = [
  { id: "MARKET", label: "Market" },
  { id: "LIMIT", label: "Limit" },
  { id: "SL", label: "SL" },
  { id: "SL-M", label: "SL-M" },
];

type IpCheck = { public_ip: string | null; allowed: string[]; match: boolean | null; error: string | null };

const roundTick = (p: number) => Math.round(p * 20) / 20; // NSE tick size ₹0.05

export function OrderTicket({ symbol, isIndex }: { symbol: string; isIndex: boolean }) {
  const tick = useTick(symbol);
  const { status: broker } = useBrokerStatus();
  const live = broker?.trading_mode === "live";
  const { data: prefs } = useApi<Prefs>("/api/settings");
  const { data: funds } = useApi<{ funds: Funds }>("/api/portfolio/funds", { refreshOnOrders: true });
  const { data: ip } = useApi<IpCheck>(live ? "/api/broker/ip-check" : null);

  const [side, setSide] = useState<Side>("BUY");
  const [orderType, setOrderType] = useState<OrderType>("MARKET");
  const [product, setProduct] = useState<Product>("DELIVERY");
  const [validity, setValidity] = useState<"DAY" | "IOC">("DAY");
  const [amo, setAmo] = useState(false);
  const [qty, setQty] = useState("1");
  const [price, setPrice] = useState("");
  const [trigger, setTrigger] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const needsPrice = orderType === "LIMIT" || orderType === "SL";
  const needsTrigger = orderType === "SL" || orderType === "SL-M";
  const quantity = Number(qty);
  const priceNum = Number(price);
  const triggerNum = Number(trigger);
  const refPrice = needsPrice ? priceNum : needsTrigger ? triggerNum : (tick?.ltp ?? 0);
  const value = quantity > 0 && refPrice > 0 ? quantity * refPrice : null;
  const maxValue = prefs?.risk.max_order_value;

  const problems: string[] = [];
  if (isIndex) problems.push("Indices can't be traded directly.");
  if (!Number.isInteger(quantity) || quantity < 1) problems.push("Quantity must be a whole number ≥ 1.");
  if (needsPrice && !(priceNum > 0)) problems.push("Enter a limit price.");
  if (needsTrigger && !(triggerNum > 0)) problems.push("Enter a trigger price.");
  if (value && maxValue && value > maxValue) problems.push(`Value exceeds your ₹${formatPrice(maxValue)} order limit.`);

  const changeType = (t: OrderType) => {
    setOrderType(t);
    // Pre-fill prices from the market so the user only nudges them.
    if (tick && (t === "LIMIT" || t === "SL") && !price) setPrice(String(roundTick(tick.ltp)));
    if (tick && (t === "SL" || t === "SL-M") && !trigger) setTrigger(String(roundTick(tick.ltp)));
  };

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const { order } = await apiPost<{ order: Order }>("/api/orders", {
        symbol,
        side,
        quantity,
        order_type: orderType,
        product,
        validity,
        amo,
        price: needsPrice ? priceNum : null,
        trigger_price: needsTrigger ? triggerNum : null,
      });
      const fill = order.status === "complete" ? ` @ ₹${formatPrice(order.average_price)}` : "";
      setResult({ ok: order.status !== "rejected", text: `Order ${order.order_id}: ${order.status}${fill}${order.message ? ` (${order.message})` : ""}` });
    } catch (e) {
      setResult({ ok: false, text: e instanceof ApiError ? e.message : "Order failed" });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const onPlace = () => (prefs?.features.confirm_orders === false ? void submit() : setConfirming(true));

  const seg = (on: boolean) => `flex-1 rounded-md px-2 py-1.5 text-xs ${on ? "bg-surface font-semibold text-fg shadow-sm" : "text-muted hover:text-fg"}`;
  const input = "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 font-mono text-sm tabular-nums outline-none focus:border-accent";
  const buy = side === "BUY";

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1">
        <button onClick={() => setSide("BUY")} className={`rounded-md py-2 text-sm font-semibold ${buy ? "bg-up text-white" : "text-muted hover:text-fg"}`}>
          Buy
        </button>
        <button onClick={() => setSide("SELL")} className={`rounded-md py-2 text-sm font-semibold ${!buy ? "bg-down text-white" : "text-muted hover:text-fg"}`}>
          Sell
        </button>
      </div>

      <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
        {ORDER_TYPES.map((t) => (
          <button key={t.id} onClick={() => changeType(t.id)} className={seg(orderType === t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          Quantity
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/[^\d]/g, ""))} className={`${input} mt-1`} />
        </label>
        <label className="text-xs text-muted">
          {needsPrice ? "Limit price" : "Price"}
          <input
            inputMode="decimal"
            value={needsPrice ? price : ""}
            placeholder={needsPrice ? "" : "Market"}
            disabled={!needsPrice}
            onChange={(e) => setPrice(e.target.value.replace(/[^\d.]/g, ""))}
            className={`${input} mt-1 disabled:opacity-50`}
          />
        </label>
        {needsTrigger && (
          <label className="col-span-2 text-xs text-muted">
            Trigger price
            <input inputMode="decimal" value={trigger} onChange={(e) => setTrigger(e.target.value.replace(/[^\d.]/g, ""))} className={`${input} mt-1`} />
          </label>
        )}
      </div>

      <div className="flex gap-2">
        <div className="flex flex-1 gap-1 rounded-lg bg-surface-2 p-0.5">
          <button onClick={() => setProduct("DELIVERY")} className={seg(product === "DELIVERY")} title="Delivery (CNC): hold beyond today">
            Delivery
          </button>
          <button onClick={() => setProduct("INTRADAY")} className={seg(product === "INTRADAY")} title="Intraday (MIS): margin, squared off today">
            Intraday
          </button>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
          <button onClick={() => setValidity("DAY")} className={seg(validity === "DAY")}>
            Day
          </button>
          <button onClick={() => setValidity("IOC")} className={seg(validity === "IOC")}>
            IOC
          </button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-muted">
        <input type="checkbox" checked={amo} onChange={(e) => setAmo(e.target.checked)} className="accent-[var(--accent)]" />
        After-market order (AMO)
      </label>

      <dl className="grid grid-cols-2 gap-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs">
        <dt className="text-muted">LTP</dt>
        <dd className="text-right font-mono tabular-nums">{formatPrice(tick?.ltp)}</dd>
        <dt className="text-muted">Est. value</dt>
        <dd className="text-right font-mono tabular-nums">{value ? `₹${formatPrice(value)}` : "—"}</dd>
        <dt className="text-muted">Available {live ? "cash" : "paper cash"}</dt>
        <dd className="text-right font-mono tabular-nums">{funds ? `₹${formatPrice(funds.funds.available_cash)}` : "—"}</dd>
      </dl>

      {live && ip?.match === false && (
        <p className="rounded-lg border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">
          Your public IP {ip.public_ip} isn&apos;t one of the static IPs registered with Angel One ({ip.allowed.join(", ")}). Orders will likely be rejected.{" "}
          <Link href="/setup/#broker" className="underline">
            Fix in settings
          </Link>
        </p>
      )}
      {live && ip?.match === null && !ip.error && (
        <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted">
          No static IP saved. Angel One only accepts orders from the IP registered for your API app.{" "}
          <Link href="/setup/#broker" className="underline">
            Add it
          </Link>
        </p>
      )}

      <button
        onClick={onPlace}
        disabled={problems.length > 0 || busy}
        title={problems.join(" ")}
        className={`rounded-lg py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50 ${buy ? "bg-up" : "bg-down"}`}
      >
        {buy ? "Buy" : "Sell"} {symbol} {live ? "· LIVE" : "· Paper"}
      </button>
      {problems.length > 0 && quantity > 0 && <p className="text-xs text-muted">{problems[0]}</p>}
      {result && <p className={`text-xs ${result.ok ? "text-up" : "text-down"}`}>{result.text}</p>}

      <ConfirmDialog
        open={confirming}
        title={`${side} ${quantity} × ${symbol}`}
        confirmLabel={`Confirm ${side.toLowerCase()}`}
        tone={buy ? "up" : "down"}
        busy={busy}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      >
        <dl className="grid grid-cols-2 gap-y-1.5">
          <dt className="text-muted">Order</dt>
          <dd>
            {orderType} · {product} · {validity}
            {amo ? " · AMO" : ""}
          </dd>
          {needsPrice && (
            <>
              <dt className="text-muted">Limit price</dt>
              <dd className="font-mono">₹{formatPrice(priceNum)}</dd>
            </>
          )}
          {needsTrigger && (
            <>
              <dt className="text-muted">Trigger</dt>
              <dd className="font-mono">₹{formatPrice(triggerNum)}</dd>
            </>
          )}
          <dt className="text-muted">Est. value</dt>
          <dd className="font-mono">{value ? `₹${formatPrice(value)}` : "—"}</dd>
        </dl>
        <p className={`mt-4 rounded-lg px-3 py-2 text-xs ${live ? "bg-down/10 text-down" : "bg-accent/10 text-accent"}`}>
          {live ? "LIVE: this sends a real order to Angel One using your money." : "Paper trade: simulated against live prices. No real money moves."}
        </p>
      </ConfirmDialog>
    </div>
  );
}

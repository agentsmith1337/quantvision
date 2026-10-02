"use client";

import Editor, { loader, type Monaco } from "@monaco-editor/react";
import type { Position, editor as MonacoEditor } from "monaco-editor";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { chartPalette } from "@/lib/chart-theme";
import { useScripts } from "@/lib/scripts-store";

// Monaco's files are copied into /public/monaco at build time (scripts/copy-monaco.mjs).
loader.config({ paths: { vs: "/monaco/vs" } });

type Completion = { label: string; insert: string; detail: string; doc: string };

const SDK: Record<string, Completion[]> = {
  api: [
    { label: "buy", insert: "buy(quantity=${1:1})", detail: "buy(quantity, symbol=None, order_type='MARKET', price=None, trigger_price=None, product='DELIVERY') -> Order", doc: "Buy; symbol defaults to the candle's stock." },
    { label: "sell", insert: "sell(quantity=${1:1})", detail: "sell(quantity, symbol=None, order_type='MARKET', price=None, trigger_price=None, product='DELIVERY') -> Order", doc: "Sell; symbol defaults to the candle's stock." },
    { label: "position", insert: "position()", detail: "position(symbol=None) -> int", doc: "Net quantity held (negative when short)." },
    { label: "orders", insert: "orders()", detail: "orders() -> list[Order]", doc: "Today's orders placed by this run." },
    { label: "cancel", insert: "cancel(${1:order_id})", detail: "cancel(order_id)", doc: "Cancel one of this run's open orders." },
    { label: "cancel_all", insert: "cancel_all()", detail: "cancel_all() -> int", doc: "Cancel this run's open orders." },
    { label: "funds", insert: "funds()", detail: "funds() -> Funds", doc: ".available_cash, .used_margin, .net" },
    { label: "ltp", insert: "ltp()", detail: "ltp(symbol=None) -> float | None", doc: "Last traded price." },
    { label: "history", insert: "history(n=${1:100})", detail: "history(symbol=None, n=100) -> DataFrame", doc: "Last n closed candles." },
    { label: "log", insert: "log(${1})", detail: "log(*values)", doc: "Write to the run's log." },
    { label: "mode", insert: "mode", detail: "mode: 'paper' | 'live'", doc: "Follows the app's Paper/Live switch." },
  ],
  indicators: [
    { label: "sma", insert: "sma(period=${1:20})", detail: "sma(period=20, symbol=None) -> float | None", doc: "Simple moving average." },
    { label: "ema", insert: "ema(period=${1:20})", detail: "ema(period=20, symbol=None) -> float | None", doc: "Exponential moving average." },
    { label: "wma", insert: "wma(period=${1:20})", detail: "wma(period=20, symbol=None) -> float | None", doc: "Weighted moving average." },
    { label: "rsi", insert: "rsi(period=${1:14})", detail: "rsi(period=14, symbol=None) -> float | None", doc: "Relative strength index (0-100)." },
    { label: "atr", insert: "atr(period=${1:14})", detail: "atr(period=14, symbol=None) -> float | None", doc: "Average true range, in rupees." },
    { label: "vwap", insert: "vwap()", detail: "vwap(symbol=None) -> float | None", doc: "Volume-weighted average price, reset daily." },
    { label: "macd", insert: "macd()", detail: "macd(fast=12, slow=26, signal=9, symbol=None)", doc: ".macd, .signal, .histogram" },
    { label: "bbands", insert: "bbands(period=${1:20})", detail: "bbands(period=20, std=2.0, symbol=None)", doc: ".upper, .middle, .lower" },
    { label: "stoch", insert: "stoch()", detail: "stoch(k=14, d=3, smooth_k=3, symbol=None)", doc: ".k, .d" },
    { label: "supertrend", insert: "supertrend()", detail: "supertrend(period=7, multiplier=3.0, symbol=None)", doc: ".value, .direction (1 up, -1 down)" },
    { label: "adx", insert: "adx(period=${1:14})", detail: "adx(period=14, symbol=None)", doc: ".adx, .plus_di, .minus_di" },
    { label: "df", insert: "df()", detail: "df(symbol=None) -> DataFrame", doc: "OHLCV history, with pandas-ta-classic's .ta accessor." },
  ],
  candle: ["symbol", "time", "open", "high", "low", "close", "volume"].map((f) => ({ label: f, insert: f, detail: `candle.${f}`, doc: "" })),
};

let completionsRegistered = false;

function setup(monaco: Monaco) {
  const bg = (theme: string) => chartPalette(theme);
  for (const [name, base] of [["day", "vs"], ["evening", "vs-dark"], ["dark", "vs-dark"]] as const) {
    const p = bg(name);
    monaco.editor.defineTheme(`qv-${name}`, {
      base,
      inherit: true,
      rules: [],
      colors: { "editor.background": p.bg, "editorGutter.background": p.bg, "editorLineNumber.foreground": p.muted },
    });
  }
  if (completionsRegistered) return;
  completionsRegistered = true;
  monaco.languages.registerCompletionItemProvider("python", {
    triggerCharacters: ["."],
    provideCompletionItems(model: MonacoEditor.ITextModel, position: Position) {
      const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const match = before.match(/\b(api|indicators|candle)\.(\w*)$/);
      if (!match) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return {
        suggestions: SDK[match[1]].map((c) => ({
          label: c.label,
          kind: c.insert.includes("(") ? monaco.languages.CompletionItemKind.Method : monaco.languages.CompletionItemKind.Field,
          insertText: c.insert,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: c.detail,
          documentation: c.doc,
          range,
        })),
      };
    },
  });
}

/** The shared script editor (content lives in the Zustand store). */
export function ScriptEditor({ compact = false }: { compact?: boolean }) {
  const { resolvedTheme } = useTheme();
  const content = useScripts((s) => s.content);
  const current = useScripts((s) => s.current);
  const setContent = useScripts((s) => s.setContent);
  const save = useScripts((s) => s.save);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  if (!current) {
    return <div className="grid h-full place-items-center text-sm text-muted">No script open.</div>;
  }

  return (
    <Editor
      height="100%"
      language="python"
      path={current}
      value={content}
      theme={`qv-${resolvedTheme ?? "dark"}`}
      beforeMount={setup}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void saveRef.current());
      }}
      onChange={(v) => setContent(v ?? "")}
      loading={<div className="grid h-full place-items-center text-sm text-muted">Loading editor…</div>}
      options={{
        fontFamily: "var(--font-jetbrains-mono), monospace",
        fontSize: compact ? 12 : 13,
        minimap: { enabled: !compact },
        lineNumbersMinChars: compact ? 3 : 4,
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        wordWrap: compact ? "on" : "off",
        automaticLayout: true,
        padding: { top: 8 },
        renderLineHighlight: "line",
      }}
    />
  );
}

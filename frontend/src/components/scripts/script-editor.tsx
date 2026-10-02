"use client";

import Editor, { loader, type Monaco } from "@monaco-editor/react";
import type { Position, editor as MonacoEditor } from "monaco-editor";
import { useTheme } from "next-themes";
import { useEffect, useRef } from "react";
import { apiGet } from "@/lib/api";
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
  // Helpers; the indicator shortcuts themselves come from /api/scripts/indicators.
  indicators: [
    { label: "series", insert: 'series("${1:ema}", period=${2:20})', detail: "series(name, **params, symbol=None) -> Series | DataFrame", doc: "The indicator's full history." },
    { label: "crossed_above", insert: "crossed_above(${1:a}, ${2:b})", detail: "crossed_above(a, b) -> bool", doc: "a crossed above b on the latest candle (Series or number)." },
    { label: "crossed_below", insert: "crossed_below(${1:a}, ${2:b})", detail: "crossed_below(a, b) -> bool", doc: "a crossed below b on the latest candle (Series or number)." },
    { label: "available", insert: "available()", detail: "available() -> dict[str, str]", doc: "Every indicator shortcut and its description." },
    { label: "df", insert: "df()", detail: "df(symbol=None) -> DataFrame", doc: "OHLCV history, with pandas-ta-classic's .ta accessor." },
  ],
  candle: ["symbol", "time", "open", "high", "low", "close", "volume"].map((f) => ({ label: f, insert: f, detail: `candle.${f}`, doc: "" })),
};

type CatalogParam = { name: string; default: unknown; same_as?: string };
type CatalogEntry = {
  name: string;
  category: string;
  title: string;
  params: CatalogParam[];
  returns: { kind: "value" | "fields" | "pattern" | "table"; fields?: string[] };
  pair?: boolean;
  notes?: string;
};

const pyValue = (v: unknown) => (v === null || v === undefined ? "None" : v === true ? "True" : v === false ? "False" : typeof v === "string" ? `'${v}'` : String(v));

function indicatorCompletion(e: CatalogEntry): Completion {
  const args = e.params.map((p) => `${p.name}=${pyValue(p.default)}`);
  const returns =
    e.returns.kind === "fields" ? `(${e.returns.fields?.map((f) => "." + f).join(", ")})` : e.returns.kind === "pattern" ? "int" : e.returns.kind === "table" ? "DataFrame" : "float | None";
  // Snippet: the main parameter (period) or the pair's `other`, pre-filled with its default.
  const first = e.params.find((p) => p.name === "other") ?? e.params.find((p) => p.name === "period");
  const insert = first ? `${e.name}(${first.name}=\${1:${first.name === "other" ? '"NIFTY"' : pyValue(first.default)}})` : `${e.name}()`;
  const notes = [e.notes, ...e.params.filter((p) => p.same_as).map((p) => `${p.name} defaults to ${p.same_as}.`)].filter(Boolean).join(" ");
  return { label: e.name, insert, detail: `${e.name}(${[...args, "symbol=None"].join(", ")}) -> ${returns}`, doc: `${e.title} (${e.category}).${notes ? " " + notes : ""}` };
}

let catalog: Promise<CatalogEntry[]> | null = null;
const loadCatalog = () =>
  (catalog ??= apiGet<CatalogEntry[]>("/api/scripts/indicators").catch(() => {
    catalog = null; // retry on the next completion request
    return [];
  }));

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
    async provideCompletionItems(model: MonacoEditor.ITextModel, position: Position) {
      const before = model.getValueInRange({ startLineNumber: position.lineNumber, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      // Fields of a multi-value indicator: indicators.macd(...).histogram
      const fieldMatch = before.match(/\bindicators\.(\w+)\([^()]*\)\.(\w*)$/);
      if (fieldMatch) {
        const entry = (await loadCatalog()).find((e) => e.name === fieldMatch[1]);
        return {
          suggestions: (entry?.returns.fields ?? []).map((f) => ({
            label: f,
            kind: monaco.languages.CompletionItemKind.Field,
            insertText: f,
            detail: `${entry?.name}().${f}`,
            range,
          })),
        };
      }
      const match = before.match(/\b(api|indicators|candle)\.(\w*)$/);
      if (!match) return { suggestions: [] };
      const items = match[1] === "indicators" ? [...SDK.indicators, ...(await loadCatalog()).map(indicatorCompletion)] : SDK[match[1]];
      return {
        suggestions: items.map((c) => ({
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

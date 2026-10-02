"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Avatar } from "@/components/app-shell";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ApiError, apiDelete, apiGet, apiPost, apiPut, type Prefs, type RuntimeStatus } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useBrokerStatus } from "@/lib/broker-status";
import { useApi } from "@/lib/use-api";

const input = "mt-1 w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent";
const label = "block text-sm";
const hint = "mt-1 text-xs text-muted";
const primaryBtn = "rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg disabled:opacity-60";
const secondaryBtn = "rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-2 disabled:opacity-60";

type AngelForm = { api_key: string; client_code: string; pin: string; totp_secret: string };
const EMPTY_ANGEL: AngelForm = { api_key: "", client_code: "", pin: "", totp_secret: "" };

function Section({ id, title, description, children }: { id?: string; title: string; description?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-4 rounded-xl border border-border bg-surface p-6">
      <h2 className="font-display text-lg font-semibold">{title}</h2>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      <div className="mt-5 space-y-4">{children}</div>
    </section>
  );
}

function Message({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <p className={`text-sm ${msg.ok ? "text-up" : "text-down"}`}>{msg.text}</p>;
}

function errText(e: unknown, fallback: string) {
  return e instanceof ApiError ? e.message : fallback;
}

function AngelFields({ value, onChange }: { value: AngelForm; onChange: (v: AngelForm) => void }) {
  const set = (k: keyof AngelForm) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={label}>
        API key
        <input value={value.api_key} onChange={set("api_key")} autoComplete="off" className={input} />
      </label>
      <label className={label}>
        Client code
        <input value={value.client_code} onChange={set("client_code")} autoComplete="off" className={input} placeholder="e.g. A1234567" />
      </label>
      <label className={label}>
        MPIN
        <input type="password" inputMode="numeric" value={value.pin} onChange={set("pin")} autoComplete="off" className={input} />
      </label>
      <label className={label}>
        TOTP secret
        <input type="password" value={value.totp_secret} onChange={set("totp_secret")} autoComplete="off" className={input} />
        <span className={hint}>The base32 text key shown with the QR code, not the 6-digit code.</span>
      </label>
    </div>
  );
}

function StaticIpFields({ value, onChange, detect }: { value: Prefs["static_ips"]; onChange: (v: Prefs["static_ips"]) => void; detect?: () => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className={label}>
        Primary static IP
        <input value={value.primary} onChange={(e) => onChange({ ...value, primary: e.target.value })} className={input} placeholder="e.g. 203.0.113.7" />
      </label>
      <label className={label}>
        Secondary static IP (optional)
        <input value={value.secondary} onChange={(e) => onChange({ ...value, secondary: e.target.value })} className={input} />
      </label>
      <p className={`${hint} sm:col-span-2`}>
        The IPs you whitelisted on your Angel One API app. Angel One rejects orders from any other IP; QuantVision warns you before that happens.
        {detect && (
          <>
            {" "}
            <button type="button" onClick={detect} className="text-accent underline">
              Detect this machine&apos;s IP
            </button>
          </>
        )}
      </p>
    </div>
  );
}

// --- First run ------------------------------------------------------------------

function FirstRunSetup({ envAvailable }: { envAvailable: boolean }) {
  const router = useRouter();
  const { refresh, bumpAvatar } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [avatar, setAvatar] = useState<File | null>(null);
  const [source, setSource] = useState<"manual" | "env" | "skip">(envAvailable ? "env" : "manual");
  const [angel, setAngel] = useState<AngelForm>(EMPTY_ANGEL);
  const [ips, setIps] = useState<Prefs["static_ips"]>({ primary: "", secondary: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problems: string[] = [];
  if (username.length < 3) problems.push("User ID needs at least 3 characters.");
  if (password.length < 8) problems.push("Password needs at least 8 characters.");
  if (password !== confirm) problems.push("Passwords don't match.");
  if (source === "manual" && Object.values(angel).some((v) => !v.trim())) problems.push("Fill in all four Angel One fields, or choose another option.");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await apiPost("/api/auth/setup", {
        username,
        password,
        angel: source === "manual" ? angel : null,
        import_env: source === "env",
        static_ips: ips,
        trading_mode: "paper",
      });
      if (avatar) {
        const form = new FormData();
        form.append("file", avatar);
        await apiPost("/api/auth/avatar", form).catch(() => {});
        bumpAvatar();
      }
      await refresh();
      router.replace("/");
    } catch (err) {
      setError(errText(err, "Setup failed"));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <div className="flex items-center gap-3">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.svg" alt="" className="size-12 rounded-xl" />
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Set up QuantVision</h1>
          <p className="text-sm text-muted">Everything stays on this computer. Your password encrypts your broker credentials.</p>
        </div>
      </div>

      <Section title="Your account" description="Used to sign in to QuantVision on this machine.">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={label}>
            User ID
            <input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} className={input} />
          </label>
          <label className={label}>
            Profile picture (optional)
            <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => setAvatar(e.target.files?.[0] ?? null)} className={`${input} file:mr-3 file:rounded file:border-0 file:bg-surface file:px-2 file:py-1 file:text-xs`} />
          </label>
          <label className={label}>
            Password
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={input} />
          </label>
          <label className={label}>
            Confirm password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={input} />
          </label>
        </div>
        <p className={hint}>There is no password recovery: forgetting it means re-entering your Angel One credentials.</p>
      </Section>

      <Section title="Angel One API" description="Needed for live market data and live trading. Without it you get simulated prices and paper trading.">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["manual", "Enter credentials"],
              ...(envAvailable ? [["env", "Import from backend/.env"]] : []),
              ["skip", "Skip for now"],
            ] as [typeof source, string][]
          ).map(([id, text]) => (
            <button
              type="button"
              key={id}
              onClick={() => setSource(id)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${source === id ? "border-accent bg-accent/15 text-accent" : "border-border text-muted hover:text-fg"}`}
            >
              {text}
            </button>
          ))}
        </div>
        {source === "manual" && <AngelFields value={angel} onChange={setAngel} />}
        {source === "env" && (
          <p className="text-sm text-muted">
            The four ANGEL_* values in backend/.env will be encrypted into your vault. Afterwards, delete them from backend/.env so they no longer sit in plain text.
          </p>
        )}
        <StaticIpFields value={ips} onChange={setIps} />
      </Section>

      <Section title="Trading mode" description="You start in paper trading: orders are simulated against live prices with ₹10,00,000 of virtual cash. Switch to live trading in Settings when you're ready.">
        <p className="text-sm">
          <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">PAPER TRADING</span>
        </p>
      </Section>

      {error && <p className="text-sm text-down">{error}</p>}
      <div className="flex items-center justify-end gap-3">
        {problems.length > 0 && <span className="text-xs text-muted">{problems[0]}</span>}
        <button type="submit" disabled={busy || problems.length > 0} className={primaryBtn}>
          {busy ? "Setting up…" : "Finish setup"}
        </button>
      </div>
    </form>
  );
}

// --- Settings (signed in) -------------------------------------------------------

function ProfileSettings() {
  const { status, bumpAvatar } = useAuth();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [busy, setBusy] = useState(false);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    try {
      await apiPost("/api/auth/avatar", form);
      bumpAvatar();
      setMsg({ ok: true, text: "Profile picture updated." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Upload failed") });
    }
  };

  const changePassword = async () => {
    setBusy(true);
    try {
      await apiPut("/api/auth/password", { current_password: pw.current, new_password: pw.next });
      setPw({ current: "", next: "", confirm: "" });
      setMsg({ ok: true, text: "Password changed. Your credential vault was re-encrypted." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't change password") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section id="profile" title="Profile">
      <div className="flex items-center gap-4">
        <Avatar size="size-16" />
        <div>
          <div className="font-medium">{status?.user?.username}</div>
          <label className="mt-1 inline-block cursor-pointer text-sm text-accent hover:underline">
            Change picture
            <input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => void upload(e.target.files?.[0])} />
          </label>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <label className={label}>
          Current password
          <input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} className={input} />
        </label>
        <label className={label}>
          New password
          <input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} className={input} />
        </label>
        <label className={label}>
          Confirm new password
          <input type="password" autoComplete="new-password" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} className={input} />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => void changePassword()}
          disabled={busy || !pw.current || pw.next.length < 8 || pw.next !== pw.confirm}
          className={secondaryBtn}
        >
          Change password
        </button>
        <Message msg={msg} />
      </div>
    </Section>
  );
}

function BrokerSettings() {
  const { status, reload } = useBrokerStatus();
  const prefs = useApi<Prefs>("/api/settings");
  const [angel, setAngel] = useState<AngelForm>(EMPTY_ANGEL);
  const [editing, setEditing] = useState(false);
  const [ips, setIps] = useState<Prefs["static_ips"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const ipValue = ips ?? prefs.data?.static_ips ?? { primary: "", secondary: "" };

  const saveCreds = async (body: object) => {
    setBusy(true);
    setMsg(null);
    try {
      await apiPut("/api/broker/credentials", body);
      setAngel(EMPTY_ANGEL);
      setEditing(false);
      setMsg({ ok: true, text: "Logged in to Angel One and saved. The engine reconnected with the new credentials." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't save credentials") });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await apiDelete("/api/broker/credentials");
      setMsg({ ok: true, text: "Credentials removed. Running on simulated prices with paper trading." });
      reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't remove credentials") });
    } finally {
      setBusy(false);
      setConfirmRemove(false);
    }
  };

  const detect = async () => {
    try {
      const r = await apiGet<{ public_ip: string | null; error: string | null }>("/api/broker/ip-check?refresh=true");
      if (r.public_ip) setIps({ ...ipValue, primary: ipValue.primary || r.public_ip });
      setMsg(r.public_ip ? { ok: true, text: `This machine's public IP is ${r.public_ip}.` } : { ok: false, text: r.error ?? "Couldn't detect the public IP" });
    } catch {
      setMsg({ ok: false, text: "Couldn't detect the public IP" });
    }
  };

  const saveIps = async () => {
    try {
      await apiPut("/api/settings/static_ips", ipValue);
      prefs.reload();
      setIps(null);
      setMsg({ ok: true, text: "Static IPs saved." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't save static IPs") });
    }
  };

  const creds = status?.credentials;
  return (
    <Section id="broker" title="Angel One API" description="Credentials are encrypted with your password and only decrypted in memory while you're signed in.">
      {status?.simulated_only && <p className="text-sm text-muted">QV_MARKET_DATA=simulated is set, so the engine won&apos;t connect to Angel One.</p>}
      {creds && !editing ? (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-surface-2 px-4 py-3 text-sm">
          <div>
            <div className="text-xs text-muted">API key</div>
            <div className="font-mono">{creds.api_key}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Client code</div>
            <div className="font-mono">{creds.client_code}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button onClick={() => setEditing(true)} className={secondaryBtn}>
              Replace
            </button>
            <button onClick={() => setConfirmRemove(true)} className={`${secondaryBtn} text-down`}>
              Remove
            </button>
          </div>
        </div>
      ) : (
        <>
          <AngelFields value={angel} onChange={setAngel} />
          <div className="flex flex-wrap gap-2">
            <button onClick={() => void saveCreds({ angel })} disabled={busy || Object.values(angel).some((v) => !v.trim())} className={primaryBtn}>
              {busy ? "Logging in…" : "Verify & save"}
            </button>
            {status?.env_credentials_available && (
              <button onClick={() => void saveCreds({ import_env: true })} disabled={busy} className={secondaryBtn}>
                Import from backend/.env
              </button>
            )}
            {creds && (
              <button onClick={() => setEditing(false)} className={secondaryBtn}>
                Cancel
              </button>
            )}
          </div>
          <p className={hint}>QuantVision logs in to Angel One once to check the credentials before saving them.</p>
        </>
      )}
      {creds && status?.env_credentials_available && (
        <p className="rounded-lg bg-down/10 px-3 py-2 text-xs text-down">backend/.env still holds your Angel One credentials in plain text. Delete those four lines now that they&apos;re in the vault.</p>
      )}
      <StaticIpFields value={ipValue} onChange={setIps} detect={() => void detect()} />
      <div className="flex items-center gap-3">
        <button onClick={() => void saveIps()} disabled={!ips} className={secondaryBtn}>
          Save static IPs
        </button>
        <Message msg={msg} />
      </div>
      <ConfirmDialog
        open={confirmRemove}
        title="Remove Angel One credentials?"
        confirmLabel="Remove"
        tone="down"
        busy={busy}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmRemove(false)}
      >
        The engine switches to simulated prices and paper trading. Open live orders at Angel One are not cancelled.
      </ConfirmDialog>
    </Section>
  );
}

function PreferenceSettings() {
  const { status, reload: reloadBroker } = useBrokerStatus();
  const prefs = useApi<Prefs>("/api/settings");
  const [risk, setRisk] = useState<{ max_order_value: string; max_orders_per_minute: string } | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const riskValue = risk ?? (prefs.data ? { max_order_value: String(prefs.data.risk.max_order_value), max_orders_per_minute: String(prefs.data.risk.max_orders_per_minute) } : null);

  const setMode = async (mode: "paper" | "live") => {
    try {
      await apiPut("/api/broker/mode", { mode });
      reloadBroker();
      setMsg({ ok: true, text: mode === "live" ? "Live trading is ON. Orders now go to Angel One." : "Back to paper trading." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't switch mode") });
    } finally {
      setConfirmLive(false);
    }
  };

  const saveFeature = async (key: keyof Prefs["features"], value: boolean) => {
    if (!prefs.data) return;
    try {
      await apiPut("/api/settings/features", { ...prefs.data.features, [key]: value });
      prefs.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't save") });
    }
  };

  const saveRisk = async () => {
    if (!riskValue) return;
    try {
      await apiPut("/api/settings/risk", { max_order_value: Number(riskValue.max_order_value), max_orders_per_minute: Number(riskValue.max_orders_per_minute) });
      prefs.reload();
      setRisk(null);
      setMsg({ ok: true, text: "Risk limits saved." });
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't save risk limits") });
    }
  };

  const live = status?.trading_mode === "live";
  return (
    <Section id="preferences" title="Preferences">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-surface-2 px-4 py-3">
        <div>
          <div className="text-sm font-medium">Trading mode</div>
          <div className="text-xs text-muted">{live ? "Orders are sent to Angel One with real money." : "Orders are simulated against live prices."}</div>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface p-1">
          <button onClick={() => live && void setMode("paper")} className={`rounded-md px-3 py-1.5 text-sm ${!live ? "bg-accent font-semibold text-accent-fg" : "text-muted hover:text-fg"}`}>
            Paper
          </button>
          <button
            onClick={() => !live && setConfirmLive(true)}
            disabled={!status?.live_available}
            title={status?.live_available ? "" : "Add Angel One credentials first"}
            className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-50 ${live ? "bg-down font-semibold text-white" : "text-muted hover:text-fg"}`}
          >
            Live
          </button>
        </div>
      </div>

      {prefs.data && (
        <div className="space-y-2">
          {(
            [
              ["confirm_orders", "Confirm every order before sending"],
              ["execution_popups", "Show a popup when an order fills or is rejected"],
            ] as [keyof Prefs["features"], string][]
          ).map(([key, text]) => (
            <label key={key} className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={prefs.data!.features[key]} onChange={(e) => void saveFeature(key, e.target.checked)} />
              {text}
            </label>
          ))}
          <label className="flex items-center gap-3 text-sm text-muted">
            <input type="checkbox" disabled />
            AI copilot &amp; news analyst (Phase 6)
          </label>
        </div>
      )}

      {riskValue && (
        <div className="grid gap-4 sm:grid-cols-3">
          <label className={label}>
            Max value per order (₹)
            <input inputMode="numeric" value={riskValue.max_order_value} onChange={(e) => setRisk({ ...riskValue, max_order_value: e.target.value.replace(/[^\d.]/g, "") })} className={input} />
          </label>
          <label className={label}>
            Max orders per minute
            <input inputMode="numeric" value={riskValue.max_orders_per_minute} onChange={(e) => setRisk({ ...riskValue, max_orders_per_minute: e.target.value.replace(/[^\d]/g, "") })} className={input} />
          </label>
          <div className="flex items-end">
            <button onClick={() => void saveRisk()} disabled={!risk} className={secondaryBtn}>
              Save limits
            </button>
          </div>
        </div>
      )}
      <Message msg={msg} />

      <ConfirmDialog
        open={confirmLive}
        title="Switch to live trading?"
        confirmLabel="Enable live trading"
        tone="down"
        onConfirm={() => void setMode("live")}
        onCancel={() => setConfirmLive(false)}
      >
        Orders you place will be sent to Angel One and executed with real money. Your risk limits still apply. You can switch back to paper at any time.
      </ConfirmDialog>
    </Section>
  );
}

type NewsConfig = { configured: boolean; api_key: string | null; usage: { today: number; limit: number } };

function NewsSettings() {
  const config = useApi<NewsConfig>("/api/news/config");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const saveKey = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await apiPut("/api/news/key", { api_key: key });
      setKey("");
      setMsg({ ok: true, text: "GNews key verified and saved." });
      config.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't save the key") });
    } finally {
      setBusy(false);
    }
  };

  const removeKey = async () => {
    try {
      await apiDelete("/api/news/key");
      setMsg({ ok: true, text: "GNews key removed." });
      config.reload();
    } catch (e) {
      setMsg({ ok: false, text: errText(e, "Couldn't remove the key") });
    }
  };

  const c = config.data;
  return (
    <Section id="news" title="News" description="Live news for each stock comes from GNews (gnews.io). The key is encrypted with your password, like your broker credentials.">
      {c?.configured && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-surface-2 px-4 py-3 text-sm">
          <div>
            <div className="text-xs text-muted">API key</div>
            <div className="font-mono">{c.api_key}</div>
          </div>
          <div>
            <div className="text-xs text-muted">Requests today</div>
            <div className="font-mono">
              {c.usage.today} / {c.usage.limit}
            </div>
          </div>
          <button onClick={() => void removeKey()} className={`${secondaryBtn} ml-auto text-down`}>
            Remove
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <label className={`${label} min-w-64 flex-1`}>
          {c?.configured ? "Replace API key" : "GNews API key"}
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" className={input} />
        </label>
        <button onClick={() => void saveKey()} disabled={busy || key.trim().length < 8} className={primaryBtn}>
          {busy ? "Verifying…" : "Verify & save"}
        </button>
      </div>
      <p className={hint}>
        Each stock&apos;s news is cached for 30 minutes to stay within the free plan&apos;s 100 requests a day. Verifying the key uses one request.
      </p>
      <Message msg={msg} />
    </Section>
  );
}

function ScriptRuntimeSettings() {
  const runtime = useApi<RuntimeStatus>("/api/scripts/runtime", { intervalMs: 5000 });
  const r = runtime.data;
  const text = !r
    ? "Checking…"
    : r.state === "ready"
      ? "Ready"
      : r.state === "installing"
        ? r.message || "Installing…"
        : r.state === "error"
          ? r.message
          : "Not installed yet";
  return (
    <Section id="scripts" title="Script environment" description="Strategy scripts run in their own Python environment with pandas, pandas-ta-classic and TA-Lib, separate from QuantVision itself.">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className={`rounded-full px-3 py-1 text-xs font-semibold ${r?.state === "ready" ? "bg-up/15 text-up" : r?.state === "error" ? "bg-down/15 text-down" : "bg-surface-2 text-muted"}`}>
          {r?.state ?? "…"}
        </span>
        <span className="text-muted">{text}</span>
        {(r?.state === "error" || r?.state === "missing") && (
          <button
            onClick={() => void apiPost("/api/scripts/runtime/install").then(() => runtime.reload())}
            className={`${secondaryBtn} ml-auto`}
          >
            {r.state === "error" ? "Retry setup" : "Set up now"}
          </button>
        )}
      </div>
      {r?.path && <p className={hint}>Location: {r.path}. Scripts are saved as .py files in Documents/QuantVision/scripts.</p>}
    </Section>
  );
}

export default function SetupPage() {
  const { status } = useAuth();

  // Jump to #broker / #preferences once the sections have rendered.
  useEffect(() => {
    if (!status?.signed_in || !window.location.hash) return;
    const id = setTimeout(() => document.querySelector(window.location.hash)?.scrollIntoView({ behavior: "smooth" }), 150);
    return () => clearTimeout(id);
  }, [status?.signed_in]);

  if (!status) return null;
  if (!status.setup_complete) return <FirstRunSetup envAvailable={status.env_credentials_available} />;
  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>
      <ProfileSettings />
      <BrokerSettings />
      <PreferenceSettings />
      <NewsSettings />
      <ScriptRuntimeSettings />
    </div>
  );
}

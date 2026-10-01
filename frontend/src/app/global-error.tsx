"use client";

// Last-resort fallback when the root layout itself fails. Kept dependency-free.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: "100vh", display: "grid", placeItems: "center", background: "#0b0d10", color: "#e6e8eb", fontFamily: "system-ui, sans-serif" }}>
        <div style={{ maxWidth: 420, padding: 24, textAlign: "center" }}>
          <h1 style={{ fontSize: 18, margin: 0 }}>QuantVision hit a problem</h1>
          {error.message && <p style={{ fontSize: 12, opacity: 0.7, wordBreak: "break-word" }}>{error.message}</p>}
          <button onClick={retry} style={{ marginTop: 16, padding: "8px 16px", borderRadius: 8, border: 0, background: "#4c8dff", color: "#0b0d10", fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}

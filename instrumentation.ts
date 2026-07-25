// Boot hook — runs once when the server process starts (Next 14
// `experimental.instrumentationHook`).
//
// Why this exists: the scan loop, the listing-notice watchers and the watchdog
// used to be armed lazily by the first `/api/scan` request. After an unattended
// restart with no browser open, the listing watcher — the whole point of the
// tool — was silently off, and so was the watchdog that would have said so.

export async function register(): Promise<void> {
  // Edge/browser bundles also evaluate this file; only the Node server should arm.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { getScan } = await import("./lib/scanCache");
    // getScan() arms the refresh loop + listing watch + watchdog and performs the
    // cold-boot sweep. Fire-and-forget: a slow first sweep must not delay boot.
    void getScan();
    console.log("[boot] scan loop + listing watch + watchdog armed");
  } catch (e) {
    console.error("[boot] arm failed", e);
  }
}

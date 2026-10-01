import { Suspense } from "react";
import { TradeDashboard } from "./trade-dashboard";

export default function TradePage() {
  // The symbol comes from ?symbol=, which is only known in the browser for a static export.
  return (
    <Suspense>
      <TradeDashboard />
    </Suspense>
  );
}

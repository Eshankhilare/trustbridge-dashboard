import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { redirect } from "next/navigation";

import { isDemoModeEnabled } from "@/lib/demo-mode";
import { RegisterClient } from "./RegisterClient";

export default function RegisterPage() {
  if (isDemoModeEnabled()) {
    redirect("/demo");
  }

  return (
    <Suspense
      fallback={
        <div className="flex min-h-[50vh] items-center justify-center text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading registration...
        </div>
      }
    >
      <RegisterClient />
    </Suspense>
  );
}

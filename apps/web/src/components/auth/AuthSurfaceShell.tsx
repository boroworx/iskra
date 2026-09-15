import type { ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";

/**
 * Full-screen centered card for standalone auth pages: the spark app icon over
 * a grouped surface. Used by the pairing, CLI-connect authorize and callback surfaces.
 */
export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-foreground sm:px-6">
      <section className="flex w-full max-w-md flex-col items-center gap-6">
        <img
          src="/apple-touch-icon.png"
          alt={APP_DISPLAY_NAME}
          width={64}
          height={64}
          className="size-16 rounded-[14px] shadow-[0_1px_2px_rgb(0_0_0/32%)]"
        />
        <div className="w-full rounded-[14px] bg-card p-6 text-card-foreground shadow-[0_0_0_0.5px_rgb(255_255_255/7%),0_8px_24px_rgb(0_0_0/24%)] sm:p-7">
          {children}
        </div>
      </section>
    </div>
  );
}

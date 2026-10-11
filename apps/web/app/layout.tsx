import type { Metadata, Viewport } from "next";
import { ClerkProvider, Show, SignInButton, UserButton } from "@clerk/nextjs";
import { getIdentityMode } from "@/lib/identity-mode";
import "./globals.css";

export const metadata: Metadata = {
  title: "RoomRelay — room preview",
  description: "Preview secondhand furniture in a measured room.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const identityMode = getIdentityMode();
  return (
    <html lang="en">
      <body>
        {identityMode === "unavailable" ? (
          <header>
            <p>Sign-in unavailable (identity not configured)</p>
          </header>
        ) : (
          <ClerkProvider>
            <>
              <header>
                {identityMode === "keyless-dev" && <small>Clerk dev instance (unclaimed)</small>}
                <Show when="signed-out">
                  <SignInButton mode="modal">
                    <button type="button">Sign in</button>
                  </SignInButton>
                </Show>
                <Show when="signed-in">
                  <UserButton />
                </Show>
              </header>
              {children}
            </>
          </ClerkProvider>
        )}
        {identityMode === "unavailable" && children}
      </body>
    </html>
  );
}

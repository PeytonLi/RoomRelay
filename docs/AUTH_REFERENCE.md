# Authentication reference

Status: **docs-first; integration unimplemented and untested**. Checked October 10, 2026. No Clerk application, credentials, accounts or external configuration were created.

## Bounded default

Use **one Clerk application** for the Next.js web client, native Kotlin Android client and RoomRelay API identity. Select email verification-code login and Google social login. Use Clerk's prebuilt web authentication and, for the prototype, the Android SDK's **hosted Account Portal authentication**. This avoids custom password forms, credential storage and a homemade session service. The Android SDK activates its session after the hosted flow completes. [Android quickstart](https://clerk.com/docs/android/getting-started/quickstart), [authentication reference](https://clerk.com/docs/android/reference/native-mobile/auth).

Clerk has an official Kotlin SDK: `com.clerk:clerk-android-api`; a separate `com.clerk:clerk-android-ui` provides prebuilt Compose components. The documented minimums are Android API 24 and Java 17. Android supports email/password, email codes and OAuth; the chosen default uses email codes and Google, rather than implementing every supported factor. SDK versions must be pinned and verified when implementation starts. [Quickstart](https://clerk.com/docs/android/getting-started/quickstart), [official SDK](https://github.com/clerk/clerk-android).

**No web-to-Android pairing fallback is required as the default:** native SDK support is verified. Signing into the same account on web and Android should map resources to the same verified Clerk user ID; automatic sharing of an existing browser session with the app is not assumed.

## Requests and authorization

Initialize the Android SDK with `Clerk.initialize()` and the publishable key. Obtain the current session token through `Clerk.auth.getToken()` and send it to RoomRelay HTTPS endpoints as `Authorization: Bearer <session-token>`. Handle signed-out/expired-session state through the SDK; do not create or distribute a separate permanent API token. [Android authentication](https://clerk.com/docs/android/reference/native-mobile/auth), [token verification](https://clerk.com/docs/guides/sessions/manual-jwt-verification).

Use `@clerk/nextjs`, `ClerkProvider` and `clerkMiddleware()` for the web integration. Use `proxy.ts` with Next.js 16+, or `middleware.ts` with Next.js 15 and below. Authentication setup alone does not protect resources: every protected API/data operation must authenticate and enforce room/project ownership using the verified user ID. Current Clerk documentation recommends these checks close to the resource and deprecates `createRouteMatcher()` for protection. [Next.js setup](https://clerk.com/docs/nextjs/getting-started/quickstart), [middleware reference](https://clerk.com/docs/reference/nextjs/clerk-middleware).

For mixed web/native API requests, use Clerk's `authenticateRequest()` or the properly configured Next.js server helpers; verify session tokens with the SDK rather than decoding JWTs and trusting their contents. Reject missing/invalid tokens. Configure `authorizedParties` for permitted web origins; do not invent a browser origin for native tokens. Clerk documents checking `azp` when present. Explicitly test actual Android tokens against the configured verifier. Accept user session tokens for these endpoints, not machine/API-key authentication by default. [Backend verification](https://clerk.com/docs/reference/backend/authenticate-request), [JWT claims](https://clerk.com/docs/guides/sessions/manual-jwt-verification).

## Configuration inventory: names only

| Name/configuration | Requirement |
|---|---|
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Web publishable key for the shared Clerk application. |
| `CLERK_SECRET_KEY` | Server-only Clerk credential; never Android, browser bundles or public repository. |
| `CLERK_JWT_KEY` | Optional server verification public key for networkless verification; not required for the baseline. |
| `CLERK_PUBLISHABLE_KEY` | Proposed RoomRelay Android build property, passed to SDK `publishableKey`; this project property name is not mandated by Clerk. |
| `ROOMRELAY_API_BASE_URL` | Proposed Android build configuration for the HTTPS backend; a RoomRelay setting, not a Clerk variable. |

The first three names follow Clerk's documented configuration. [Next.js environment setup](https://clerk.com/docs/nextjs/getting-started/quickstart), [verification options](https://clerk.com/docs/reference/backend/authenticate-request).

Enable **Native API**, register the Android namespace/package, initialize the SDK in the application lifecycle, and enable internet permission. Register/allowlist the callback used by the selected SDK flow; do not guess a callback scheme from unrelated examples. Enable email codes and Google in Clerk. Production Google authentication requires provider OAuth credentials; development can use Clerk's shared credentials. [Android setup](https://clerk.com/docs/android/getting-started/quickstart), [social configuration](https://clerk.com/docs/android/guides/configure/auth-strategies/social-connections/overview).

Implementation acceptance: web and Android sign in to the same test user; Android Bearer requests work; invalid tokens and access to another user's room fail; cancellation/sign-out behave correctly. Clerk identity never substitutes for PayPal buyer payment approval.

Not checked: live Clerk configuration, callback execution, production provider credentials or end-to-end tokens. No draft documents existed in the target docs directory when inspected, so no cross-document contradiction was reviewed.

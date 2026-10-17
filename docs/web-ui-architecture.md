# Pi Web UI Architecture

Pi Web UI is a browser presentation for the existing Session and service protocol. The browser host is an independently replaceable profile: it owns HTTP, browser authentication, static assets, browser transports, and UI plugin loading, while Pi core owns Sessions, service routing, and durable state.

The Web profile reuses MIT-licensed DeepSeek Harness presentation source. The initial official source selection is pinned at `1517a4dbca0a2789ff1d41ba439600f8547d23fa` in `vendor/deepseek-web/manifest.json`, with its original license and file hashes. The AtomGit snapshot at `da00f7f5358f2949383b35c14f548bc20187d80c` remains a read-only reference. Pi-specific adapters live outside the imported source and connect the presentation to Pi services.

## Problem

The current `packages/server` and `packages/client` packages already provide transport-neutral framed RPC, Session attachment routing, service calls, subscriptions, cancellation, and reconnect state. They do not provide a browser HTTP host, an SPA asset loader, browser authentication, or a UI extension registry. Adding those concerns to the low-level protocol would make every future client inherit browser policy and frontend release constraints.

The concrete failure mode is a browser request that needs both an initial Session projection and ordered live updates. The HTTP host must authenticate and serve the page, the client must establish one protocol generation, and the Session service must return a baseline before updates are delivered. None of those responsibilities belongs in CBOR framing or the generic Session router.

## Composition

```text
browser UI
  -> Web profile client
     -> browser transport and RPC client
        -> HTTP host / WebSocket or SSE carrier
           -> @earendil-works/pi-server
              -> application-owned Session and service hosts
                 -> Pi agent, durable Session, provider extensions
```

The first browser profile is a sidecar composition. It may share a process with a Pi launcher later, but it keeps the HTTP host and UI bundle outside `packages/server` and `packages/client`.

The HTTP host has five responsibilities:

- bind to loopback by default and report the selected URL;
- serve the UI shell and versioned plugin assets with SPA fallback;
- authenticate API, upgrade, and event-stream requests using a process-local token;
- adapt one browser connection to the existing Pi byte protocol;
- expose an extension registry for route, index-injection, client-module, and UI-slot contributions.

The host does not inspect provider credentials, account-pool records, quota vendor formats, or Session business payloads. Those are application services or sidecars reached through typed service contracts.

## Service surfaces

The browser profile uses generic service routing for transport and a small set of application-owned services for product behavior:

| Service | Read model | Mutations |
|---|---|---|
| `session.directory` | Session metadata and workspace projection | create, rename, archive, attach, detach |
| `session.conversation` | baseline plus ordered conversation events | prompt, cancel, follow, page |
| `session.tools` | tool-call and tool-result details | approval response |
| `provider.catalog` | provider and model availability | select model |
| `provider.usage` | local usage, subscription quota, and account status as separate records | refresh request |
| `settings` | redacted settings projection | update non-secret settings |
| `web.plugins` | loaded browser extensions and capabilities | enable or disable a profile extension |

Each stateful service subscription begins with a complete snapshot and then emits ordered updates. The client replaces its local projection on a new connection generation; ordinary notifications are not replayed as a substitute for a baseline.

`provider.usage` consumes the pure records exported by `@earendil-works/pi-plugin-sdk/usage`. It does not read environment variables, persist credentials, rotate accounts, or implement vendor-specific quota queries. A provider or sidecar may publish those records through an adapter.

## Client layers

The browser client follows this dependency direction:

```text
transport -> service client -> projection model -> UI adapter -> slot/plugin renderer
```

The transport layer owns connection generations, request correlation, cancellation, and reconnect. The service client owns wire parsing and subscription lifecycle. Projection models own baseline replacement, ordered update application, and stable object identity. UI adapters convert projections into framework-agnostic slot inputs. UI plugins render components and issue commands through injected service faces; they do not receive the transport or server context.

The first UI profile should expose these extension points:

- root layout and navigation entries;
- Session header actions and conversation views;
- tool-call detail renderers;
- provider/model status panels;
- usage, quota, and account-status panels;
- settings sections;
- index and client-module injections for independently served bundles.

The slot registry is additive by default. A plugin may replace a named single slot only when the profile explicitly declares that replacement. Plugin disposal removes its routes, modules, subscriptions, and UI entries together.

## Security defaults

The host binds to `127.0.0.1` unless an explicit deployment profile supplies a different policy. Non-loopback binding is not enabled by a UI flag alone. A profile that exposes the host remotely must supply authentication, Origin policy, and TLS or a trusted reverse proxy before it can be considered usable.

The browser receives a redacted settings and provider view. API keys and other credentials remain in environment variables, an application credential store, or a sidecar owned by the provider integration. They never enter UI plugin props, Session projections, usage records, or repository configuration.

The HTTP route registry uses exact and prefix routes with one owner per route. The SPA fallback is a separate single owner. WebSocket or SSE upgrade routes are explicit and authenticated before the connection is handed to the protocol adapter.

## Initial implementation order

1. Add a browser-compatible byte transport to `packages/client` without changing service semantics.
2. Add an HTTP host package that serves a static profile, authenticates requests, and bridges one browser transport to `packages/server`.
3. Define application-owned Session directory, conversation, and provider usage services on top of the existing opaque routing API.
4. Add baseline-plus-update projection models and focused tests for reconnect, stale attachment rejection, and ordered updates.
5. Add the first UI profile with Session/workspace navigation, live conversation, tool details, provider/model status, and separated usage panels.
6. Add a plugin manifest and versioned bundle loader after the core profile can operate without optional UI plugins.

The first slice should stop after the browser can connect, list Sessions, attach to one Session, receive a baseline, and submit a prompt through an authenticated local host. Provider account pools, OAuth, proxy pools, billing, and vendor quota adapters remain sidecar concerns.

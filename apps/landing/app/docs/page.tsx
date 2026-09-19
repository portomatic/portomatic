import type { Metadata } from "next";
import { SiteHeader } from "../site-header";
import { SocialLinks } from "../social-links";

const container = "mx-auto w-[min(100%-2rem,64rem)]";

const title = "Docs — Portomatic";
const description =
  "Add a native, hot-reloading SwiftUI preview of AI-generated Swift to your iOS app with one Swift package.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: "/docs" },
  openGraph: {
    title,
    description,
    url: "https://portomatic.com/docs",
    siteName: "Portomatic",
    type: "article",
  },
};

const HOST = "https://api.portomatic.com";
const REPO = "https://github.com/portomatic/portomatic-ios.git";

function Pre({ children }: { children: string }) {
  return (
    <pre className="overflow-x-auto border border-line bg-[#0f1a25] p-4 font-mono text-[0.82rem] leading-[1.6] text-[#e7edf3]">
      <code>{children}</code>
    </pre>
  );
}

function C({ children }: { children: React.ReactNode }) {
  return (
    <code className="font-mono text-[0.88em] bg-foreground/5 px-[0.35em] py-[0.12em]">
      {children}
    </code>
  );
}

function Section({
  id,
  eyebrow,
  title,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex scroll-mt-24 flex-col gap-4">
      {eyebrow ? (
        <span className="text-[0.74rem] tracking-[0.14em] text-muted uppercase">
          {eyebrow}
        </span>
      ) : null}
      <h2 className="text-[1.55rem] leading-[1.1] font-normal tracking-[-0.03em]">
        {title}
      </h2>
      {children}
    </section>
  );
}

export default function Docs() {
  return (
    <>
      <SiteHeader current="docs" />

      <main
        className={`${container} flex flex-col gap-14 py-14 max-[34rem]:py-10`}
      >
        {/* Intro */}
        <div className="flex flex-col gap-5 border-b border-line pb-12">
          <span className="text-[0.74rem] tracking-[0.14em] text-muted uppercase">
            iOS SDK
          </span>
          <h1 className="max-w-[18ch] text-[clamp(2.4rem,5vw,3.6rem)] leading-[0.98] font-normal tracking-[-0.05em]">
            A live iPhone preview in one package.
          </h1>
          <p className="max-w-[46rem] text-[clamp(1.02rem,2vw,1.2rem)] leading-[1.5] text-muted">
            Portomatic renders your AI-generated Swift as a native,
            hot-reloading SwiftUI preview — no simulator, no backend of your
            own, no API key. Add one Swift package, point it at the server, and
            drop <C>PortomaticPreview()</C> into your view. Every build you
            submit hot-reloads on device in seconds.
          </p>
        </div>

        <Section id="requirements" eyebrow="Before you start" title="Requirements">
          <ul className="flex max-w-[46rem] list-disc flex-col gap-2 pl-5 text-[1rem] leading-[1.5] text-muted">
            <li>Xcode 26 or later, targeting iOS 26+.</li>
            <li>
              A Portomatic host URL. The public server is{" "}
              <C>{HOST}</C> — that is all a client needs; there is no auth in
              the MVP.
            </li>
            <li>
              Swift Package Manager. The SDK pulls in its own dependencies (the
              native renderer and the wasm engine) automatically.
            </li>
          </ul>
        </Section>

        <Section id="install" eyebrow="Step 1" title="Add the package">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            In Xcode: <strong className="font-normal text-foreground">File ▸ Add
            Package Dependencies…</strong>, paste the URL below, and choose{" "}
            <em className="not-italic text-foreground">Up to Next Major
            Version</em> from <C>0.1.0</C>.
          </p>
          <Pre>{REPO}</Pre>
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            Or in a <C>Package.swift</C> manifest:
          </p>
          <Pre>{`dependencies: [
  .package(url: "${REPO}", from: "0.1.0"),
],
targets: [
  .target(name: "App", dependencies: [
    .product(name: "Portomatic", package: "portomatic-ios"),
  ]),
],`}</Pre>
        </Section>

        <Section id="preview" eyebrow="Step 2" title="Point at the server, show the preview">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            Configure the shared client once at launch, then use{" "}
            <C>PortomaticPreview</C> anywhere. It watches the current build for
            your session and renders it with real SwiftUI, hot-reloading as new
            builds land.
          </p>
          <Pre>{`import SwiftUI
import Portomatic

@main
struct MyApp: App {
    init() {
        Portomatic.shared.setup(host: "${HOST}")
    }

    var body: some Scene {
        WindowGroup { PreviewScreen() }
    }
}

struct PreviewScreen: View {
    var body: some View {
        PortomaticPreview()   // native, hot-reloading
    }
}`}</Pre>
        </Section>

        <Section id="submit" eyebrow="Step 3" title="Submit source from your agent">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            Send a revision of a codebase to the server. On success that build
            becomes the session&apos;s <C>current</C>, so the matching{" "}
            <C>PortomaticPreview</C> swaps to it automatically.
          </p>
          <Pre>{`let result = try await Portomatic.shared.submit(
    files: ["ContentView.swift": generatedSwiftSource],
    root: "ContentView"
)

if result.ok {
    // The preview watching this session hot-reloads to result.id.
} else {
    // A build failure is a normal result, not a thrown error:
    // feed the diagnostics back to your agent to self-heal.
    let errors = result.diagnostics?.errors ?? 0
    print("build failed: \\(errors) error(s)")
    print(result.log_tail ?? "")
}`}</Pre>
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            <C>submit</C> only <em className="not-italic text-foreground">throws</em>{" "}
            for transport or HTTP problems (<C>PortomaticError</C>:{" "}
            <C>.notConfigured</C>, <C>.rateLimited</C>, <C>.badRequest</C>,{" "}
            <C>.server</C>, <C>.transport</C>). A source that fails to compile
            comes back as <C>ok: false</C> with compiler diagnostics.
          </p>
        </Section>

        <Section id="sessions" eyebrow="Concurrency" title="Sessions">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            One server backs many independent previews. Key each by a session
            id — a project, a task, a user. The side that submits and the
            preview that watches simply share the id.
          </p>
          <Pre>{`// Set a default session for the whole client…
Portomatic.shared.setup(host: "${HOST}", session: "proj-42")

// …or override per call and per view:
try await Portomatic.shared.submit(
    files: files, root: "ContentView", session: "proj-42")

PortomaticPreview(session: "proj-42")`}</Pre>
        </Section>

        <Section id="api" eyebrow="Reference" title="API">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            <C>import Portomatic</C> exposes exactly three public symbols.
          </p>
          <dl className="flex flex-col divide-y divide-line border-y border-line">
            {[
              {
                sig: "Portomatic.shared.setup(host: String, session: String = \"default\")",
                desc: "Configure the shared client. Also setup(_ config: PortomaticConfig). Read config / isConfigured to inspect it.",
              },
              {
                sig: "PortomaticConfig(host: String, session: String = \"default\")",
                desc: "An explicit configuration for advanced or multi-host use. PortomaticConfig.fromEnvironment() reads MILQ_LIVE_URL / MILQ_LIVE_SESSION.",
              },
              {
                sig: "submit(files:root:app:checkOnly:noRewrite:canImport:session:) async throws -> BuildResult",
                desc: "Compile one revision. files maps relative paths to Swift source; root is the root type name; app: true when root conforms to App; checkOnly: true type-checks without producing a module.",
              },
              {
                sig: "BuildResult",
                desc: "ok, id, seconds, cached, diagnostics(errors, warnings), wasm_url, manifest_url, log_tail.",
              },
              {
                sig: "PortomaticPreview(session: String? = nil)",
                desc: "The SwiftUI view that renders the current build and hot-reloads. Also PortomaticPreview(config:session:).",
              },
            ].map((row) => (
              <div key={row.sig} className="flex flex-col gap-1.5 py-4">
                <dt className="font-mono text-[0.82rem] leading-[1.5] text-foreground">
                  {row.sig}
                </dt>
                <dd className="max-w-[46rem] text-[0.95rem] leading-[1.5] text-muted">
                  {row.desc}
                </dd>
              </div>
            ))}
          </dl>
        </Section>

        <Section id="http" eyebrow="Without the SDK" title="HTTP API">
          <p className="max-w-[46rem] text-[1rem] leading-[1.5] text-muted">
            The SDK is a thin wrapper over a small HTTP surface on <C>{HOST}</C>.
            You can drive it directly from any language.
          </p>
          <Pre>{`POST /build
  { "session": "proj-42", "root": "ContentView",
    "app": false, "check_only": false, "files": { "ContentView.swift": "…" } }
  -> 200 { "ok": true, "id": "wasm-…", "seconds": 1.2, "cached": false,
           "diagnostics": {…}, "wasm_url": "…", "manifest_url": "…" }
  A build failure is also 200 (with diagnostics); 400 means a malformed request.

GET /current?session=proj-42
  -> { "id": "wasm-…", "wasm_url": "…", "manifest_url": "…" }   // or { "id": null }

GET /artifact/<id>/app.wasm        // the compiled module
GET /artifact/<id>/manifest.json   // its manifest
GET /healthz                       // -> ok`}</Pre>
        </Section>
      </main>

      <footer
        className={`${container} flex min-h-17 items-center justify-between gap-4 border-t border-line max-[22rem]:min-h-0 max-[22rem]:flex-col max-[22rem]:items-start max-[22rem]:py-4`}
      >
        <a
          href="/"
          className="text-[0.74rem] text-muted hover:text-foreground motion-safe:transition-colors motion-safe:duration-[140ms]"
        >
          ← portomatic.com
        </a>
        <SocialLinks />
      </footer>
    </>
  );
}

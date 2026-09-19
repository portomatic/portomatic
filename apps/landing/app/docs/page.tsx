import type { Metadata } from "next";
import { SiteHeader } from "../site-header";
import { SocialLinks } from "../social-links";
import { CopySetup } from "./copy-setup";

const container = "mx-auto w-[min(100%-2rem,64rem)]";

const title = "Docs — Portomatic";
const description =
  "Add a native, hot-reloading SwiftUI preview of AI-generated Swift with one Swift package.";

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

function H({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[1.5rem] leading-[1.1] font-normal tracking-[-0.03em]">
      {children}
    </h2>
  );
}

export default function Docs() {
  return (
    <>
      <SiteHeader current="docs" />

      <main
        className={`${container} flex max-w-[46rem] flex-col gap-12 py-14 max-[34rem]:py-10`}
      >
        <div className="flex flex-col gap-4">
          <h1 className="text-[clamp(2.2rem,5vw,3rem)] leading-[1] font-normal tracking-[-0.05em]">
            iOS SDK
          </h1>
          <p className="text-[1.05rem] leading-[1.5] text-muted">
            A native, hot-reloading SwiftUI preview of your AI-generated Swift.
            No simulator, no backend, no API key.
          </p>
          <CopySetup />
        </div>

        <section className="flex flex-col gap-4">
          <H>Installation</H>
          <p className="text-[1rem] leading-[1.5] text-muted">
            Add the package in <C>Package.swift</C>:
          </p>
          <Pre>{`dependencies: [
  .package(url: "${REPO}", from: "0.1.0"),
],
targets: [
  .target(name: "App", dependencies: [
    .product(name: "Portomatic", package: "portomatic-ios"),
  ]),
],`}</Pre>
        </section>

        <section className="flex flex-col gap-4">
          <H>Configure</H>
          <p className="text-[1rem] leading-[1.5] text-muted">
            Point the client at the server, then drop <C>PortomaticPreview</C>{" "}
            into any view. It renders the current build and hot-reloads.
          </p>
          <Pre>{`import SwiftUI
import Portomatic

@main
struct MyApp: App {
    init() {
        Portomatic.shared.setup(host: "${HOST}")
    }

    var body: some Scene {
        WindowGroup { PortomaticPreview() }
    }
}`}</Pre>
        </section>

        <section className="flex flex-col gap-4">
          <H>Submit source</H>
          <p className="text-[1rem] leading-[1.5] text-muted">
            Send source from your agent; the matching preview swaps to it.
          </p>
          <Pre>{`let result = try await Portomatic.shared.submit(
    files: ["ContentView.swift": generatedSource],
    root: "ContentView"
)

// A compile failure comes back as result.ok == false
// with result.diagnostics — feed it back to the agent.`}</Pre>
        </section>
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

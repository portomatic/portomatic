"use client";

import { useState } from "react";

const INSTRUCTIONS = `Portomatic — iOS live preview setup (for an AI coding agent)

Portomatic renders AI-generated Swift as a native, hot-reloading SwiftUI
preview. No simulator, no backend, no API key. Server: https://api.portomatic.com

1. Add the Swift package.
   Package.swift:
     .package(url: "https://github.com/portomatic/portomatic-ios.git", from: "0.1.0")
   Target dependency:
     .product(name: "Portomatic", package: "portomatic-ios")

2. Configure the client once and show the preview.
     import SwiftUI
     import Portomatic

     @main
     struct MyApp: App {
         init() { Portomatic.shared.setup(host: "https://api.portomatic.com") }
         var body: some Scene { WindowGroup { PortomaticPreview() } }
     }

3. Submit source from the agent; the preview hot-reloads to it.
     let result = try await Portomatic.shared.submit(
         files: ["ContentView.swift": generatedSource],
         root: "ContentView"
     )
     // A compile failure comes back as result.ok == false with
     // result.diagnostics (errors/warnings) and result.log_tail — feed
     // that back into the next revision to self-heal, then submit again.
`;

export function CopySetup() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(INSTRUCTIONS);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable (e.g. insecure context) — no-op.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-live="polite"
      className="inline-flex min-h-[3.15rem] w-fit items-center justify-center gap-2 bg-accent px-[1.2rem] py-[0.85rem] text-base leading-none font-normal text-white hover:bg-accent-hover motion-safe:transition-colors motion-safe:duration-[140ms] max-[34rem]:w-full"
    >
      {copied ? "Copied ✓" : "Copy setup instructions for LLM"}
    </button>
  );
}

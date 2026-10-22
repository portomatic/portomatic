"use client";

import { useState } from "react";

const setupInstructions = `Set up Portomatic for this repository.

1. Confirm Node.js 24 or newer is installed.
2. Start a local Slack workspace:
   npx portomatic slack start
   Open the printed "Open Slack" link to use it in the real Slack client.
3. To run the bot against it, wrap its command: npx portomatic slack run -- <command>

Do not hardcode Slack tokens. Portomatic sets them for the command.
Docs: npx portomatic slack docs testing (also: seed, templates, bolt-js, slack-sdk, troubleshooting)`;

export function CopySetup() {
  const [label, setLabel] = useState("Give this to your coding agent");

  return (
    <button
      id="copy-setup"
      type="button"
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(setupInstructions);
          setLabel("✓ Copied");
        } catch {
          setLabel("Copy failed");
        }
      }}
    >
      {label}
    </button>
  );
}

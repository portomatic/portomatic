import { CopySetup } from "./copy-setup";

export default function Home() {
  return (
    <>
      <header>
        <h1>Portomatic: Environments for coding agents</h1>
        <p>We create environments that run locally to test your agents.</p>
      </header>

      <main>
        <div id="actions">
          <CopySetup />
        </div>

        <h2>How it works</h2>
        <pre>
          <code>npx portomatic slack start</code>
        </pre>

        <p>
          Portomatic starts an isolated Slack workspace on your machine and
          gives you a link to use it in the real Slack client.
        </p>
      </main>

      <footer>
        <span id="yc-sticker">
          <span id="yc-mark">Y</span> Backed by YC
        </span>
        <a id="contact" href="mailto:founders@portomatic.com">
          founders@portomatic.com
        </a>
      </footer>
    </>
  );
}

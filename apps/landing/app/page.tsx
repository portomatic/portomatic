export default function Home() {
  return (
    <>
      <header>
        <a id="brand" href="/" aria-label="Portomatic home">
          <img src="/assets/portomatic-mark.svg" alt="" />
          Portomatic
        </a>
        <h1>Local environments for your agents</h1>
        <p>We build environments that run locally for your agents.</p>
      </header>

      <main>
        <div id="actions">
          <a
            id="early-access"
            href="mailto:founders@portomatic.com?subject=Portomatic%20early%20access"
          >
            Get early access
          </a>
        </div>
      </main>

      <footer>
        <p id="backed-by">
          Backed by
          <a href="https://www.ycombinator.com/" aria-label="Y Combinator">
            <img src="/assets/ycombinator.svg" alt="" />
            Combinator
          </a>
        </p>
        <nav id="social-links" aria-label="Portomatic social accounts">
          <a
            href="https://www.linkedin.com/company/portomatichq/"
            aria-label="Portomatic on LinkedIn"
            title="Portomatic on LinkedIn"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="/assets/linkedin.svg" alt="" />
          </a>
          <a
            href="https://x.com/portomatichq"
            aria-label="Portomatic on X"
            title="Portomatic on X"
            target="_blank"
            rel="noopener noreferrer"
          >
            <img src="/assets/x.svg" alt="" />
          </a>
        </nav>
      </footer>
    </>
  );
}

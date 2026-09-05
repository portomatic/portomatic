import { SocialLinks } from "./social-links";

const container = "mx-auto w-[min(100%-2rem,64rem)]";

export default function Home() {
  return (
    <>
      <header className={`${container} flex min-h-17 items-center border-b border-line`}>
        <a
          className="inline-flex items-center gap-2 text-foreground"
          href="/"
          aria-label="Portomatic home"
        >
          <img
            src="/assets/portomatic-mark.svg"
            alt=""
            className="h-[1.35rem] w-[1.35rem]"
          />
          <span className="text-[1.05rem] font-normal tracking-[-0.06em]">
            Portomatic
          </span>
        </a>
      </header>

      <main
        className={`${container} flex min-h-[calc(100svh-8.5rem)] flex-col items-start justify-center py-12 text-left max-[34rem]:pt-16 max-[34rem]:pb-24`}
        aria-labelledby="hero-title"
      >
        <h1
          id="hero-title"
          className="max-w-[13ch] text-[clamp(3.5rem,8vw,7rem)] leading-[0.9] font-normal tracking-[-0.055em] max-[34rem]:text-[clamp(3.2rem,18vw,4.8rem)]"
        >
          The <span className="tracking-normal">iPhone</span> that runs on
          Linux.
        </h1>
        <p className="mt-[1.4rem] max-w-[34rem] text-[clamp(1.05rem,2vw,1.35rem)] leading-[1.45] text-muted">
          One for every engineer, agent, and task. Built for hyperscale. Use it
          through the API, CLI, or iframe.
        </p>
        <a
          className="mt-8 inline-flex min-h-[3.15rem] items-center justify-center bg-accent px-[1.2rem] py-[0.85rem] text-base leading-none font-normal text-white hover:bg-accent-hover motion-safe:transition-colors motion-safe:duration-[140ms] max-[34rem]:w-full"
          href="mailto:founders@portomatic.com?subject=Portomatic%20early%20access"
        >
          Get early access
        </a>
      </main>

      <footer
        className={`${container} flex min-h-17 items-center justify-between gap-4 border-t border-line max-[22rem]:min-h-0 max-[22rem]:flex-col max-[22rem]:items-start max-[22rem]:py-4`}
      >
        <div className="flex items-center gap-4">
          <p className="text-[0.74rem] text-muted">Backed by</p>
          <div className="flex items-center gap-4">
            <a
              href="https://www.ycombinator.com/"
              aria-label="Y Combinator"
              className="inline-flex items-center gap-[0.4rem] text-[0.74rem] text-foreground"
            >
              <img
                src="/assets/ycombinator.svg"
                alt=""
                className="h-[1.3rem] w-[1.3rem]"
              />
              <span>Combinator</span>
            </a>
          </div>
        </div>
        <SocialLinks />
      </footer>
    </>
  );
}

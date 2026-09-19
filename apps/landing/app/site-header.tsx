const container = "mx-auto w-[min(100%-2rem,64rem)]";

export function SiteHeader({ current }: { current?: "docs" }) {
  return (
    <header
      className={`${container} flex min-h-17 items-center justify-between gap-4 border-b border-line`}
    >
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
      <nav
        className="flex items-center gap-6 text-[0.95rem]"
        aria-label="Primary"
      >
        <a
          href="/docs"
          aria-current={current === "docs" ? "page" : undefined}
          className={
            current === "docs"
              ? "text-foreground"
              : "text-muted hover:text-foreground motion-safe:transition-colors motion-safe:duration-[140ms]"
          }
        >
          Docs
        </a>
      </nav>
    </header>
  );
}

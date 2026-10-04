const container = "mx-auto w-[min(100%-2rem,64rem)]";

export function SiteHeader() {
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
    </header>
  );
}

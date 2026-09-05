"use client";

import { Tooltip } from "@base-ui/react/tooltip";

const links = [
  {
    label: "Portomatic on LinkedIn",
    href: "https://www.linkedin.com/company/portomatichq/",
    icon: "/assets/linkedin.svg",
  },
  {
    label: "Portomatic on X",
    href: "https://x.com/portomatichq",
    icon: "/assets/x.svg",
  },
];

export function SocialLinks() {
  return (
    <nav
      className="flex items-center gap-[0.85rem]"
      aria-label="Portomatic social accounts"
    >
      <Tooltip.Provider>
        {links.map((link) => (
          <Tooltip.Root key={link.href}>
            <Tooltip.Trigger
              render={
                <a
                  href={link.href}
                  aria-label={link.label}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex opacity-72 hover:opacity-100 motion-safe:transition-opacity motion-safe:duration-[140ms]"
                >
                  <img
                    src={link.icon}
                    alt=""
                    className="h-[0.95rem] w-[0.95rem]"
                  />
                </a>
              }
            />
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={8}>
                <Tooltip.Popup className="bg-foreground px-2 py-1 text-[0.74rem] text-background">
                  {link.label}
                </Tooltip.Popup>
              </Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        ))}
      </Tooltip.Provider>
    </nav>
  );
}

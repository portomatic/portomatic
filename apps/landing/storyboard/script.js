const controls = [...document.querySelectorAll("[data-viewport]")];
const previews = [...document.querySelectorAll("[data-preview]")];

let viewportWidth = 1440;
let viewportHeight = 900;

function sizePreviews() {
  for (const preview of previews) {
    const iframe = preview.querySelector("iframe");
    const scale = preview.clientWidth / viewportWidth;
    preview.style.aspectRatio = `${viewportWidth} / ${viewportHeight}`;
    iframe.style.width = `${viewportWidth}px`;
    iframe.style.height = `${viewportHeight}px`;
    iframe.style.transform = `scale(${scale})`;
  }
}

for (const control of controls) {
  control.addEventListener("click", () => {
    viewportWidth = Number(control.dataset.viewport);
    viewportHeight = Number(control.dataset.height);
    for (const candidate of controls) {
      candidate.setAttribute("aria-pressed", String(candidate === control));
    }
    sizePreviews();
  });
}

const observer = new ResizeObserver(sizePreviews);
for (const preview of previews) observer.observe(preview);
sizePreviews();

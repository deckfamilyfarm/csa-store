import { useLayoutEffect, useRef } from "react";

// Keep controls above the rows visible; recalculate when filters or navigation resize.
export function useViewportRows(bottomSpace = 16, enabled = true) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;
    const resize = () => {
      const top = element.getBoundingClientRect().top + window.scrollY;
      element.style.setProperty("--rows-height", `${Math.max(180, window.innerHeight - top - bottomSpace)}px`);
    };
    const observer = new ResizeObserver(resize);
    [element.parentElement, element.closest(".admin-layout"), document.querySelector(".admin-header")]
      .filter(Boolean).forEach(node => observer.observe(node));
    window.addEventListener("resize", resize);
    resize();
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, [bottomSpace, enabled]);
  return ref;
}

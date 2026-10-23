import { useLayoutEffect, useState } from 'react';

/*
 * Füllhöhe: eine Liste/Fläche nimmt den Rest des Fensters ein und scrollt in sich, die Seite bleibt stehen.
 * Wie Hostwerks useFillHeight (gemessen statt geschätzt), läuft aber auch mit älteren Hostwerk-Versionen ohne diesen
 * Baustein – und zieht zusätzlich ab, was Hostwerk unter die Seite setzt (z. B. Herkunftszeile unter Reitern anderer
 * Bereiche), damit wirklich nichts mehr scrollt. Liefert eine Ref-Funktion: <div ref={fill}>.
 */
export function useFill({ gap = 16, min = 320 } = {}) {
  const [el, setEl] = useState(null);
  useLayoutEffect(() => {
    if (!el) return undefined;
    const scroller = el.closest('.main');
    let raf = 0;
    let raf2 = 0;
    const fit = () => {
      cancelAnimationFrame(raf); cancelAnimationFrame(raf2);
      raf = requestAnimationFrame(() => {
        const top = el.getBoundingClientRect().top + (scroller ? scroller.scrollTop - scroller.getBoundingClientRect().top : 0);
        const avail = (scroller ? scroller.clientHeight : window.innerHeight) - top;
        const page = el.closest('.page');
        const bottom = page ? parseFloat(getComputedStyle(page).paddingBottom) || gap : gap;
        const h = Math.max(min, Math.floor(avail - bottom));
        el.style.height = `${h}px`;
        // Steht danach noch etwas unter der Fläche (Zeilen von Hostwerk, eigene Fußzeilen), um genau so viel kürzer
        raf2 = requestAnimationFrame(() => {
          if (!scroller) return;
          const over = scroller.scrollHeight - scroller.clientHeight;
          if (over > 0) el.style.height = `${Math.max(min, h - over)}px`;
        });
      });
    };
    fit();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    if (ro) { ro.observe(document.documentElement); if (scroller) ro.observe(scroller); }
    window.addEventListener('resize', fit);
    return () => { cancelAnimationFrame(raf); cancelAnimationFrame(raf2); if (ro) ro.disconnect(); window.removeEventListener('resize', fit); el.style.height = ''; };
  }, [el, gap, min]);
  return setEl;
}

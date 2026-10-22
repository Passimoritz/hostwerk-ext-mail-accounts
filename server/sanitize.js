'use strict';
/*
 * HTML einer Mail sicher machen – zusätzlich zur Abschottung in der Oberfläche (iframe ohne Skripte, eigene CSP).
 *   - nur harmlose Elemente und Attribute (keine Skripte, Formulare, Rahmen, Objekte, <base>, <meta>, Ereignis-Attribute)
 *   - Links: nur http(s), mailto, tel; Ziel steht in data-hw-href, öffnen entscheidet die Oberfläche
 *   - Bilder von außen erst auf Wunsch (remote: false → src entfernt, data-hw-src behält die Adresse)
 *   - Zählpixel (1×1, unsichtbar, typische Pfade) immer raus – auch wenn Bilder von außen erlaubt sind
 *   - eingebettete Bilder (cid:) werden durch data:-Adressen aus den Anhängen ersetzt
 *   - CSS: keine url(…) nach außen, kein @import, keine Ausdrücke, kein position: fixed
 * Ergebnis: { html, remoteImages, trackers, links: [{ href, text }] }
 */
const { sanitizeHtml } = require('./libs');

const TRACK_PATH = /(\/(open|o|track|tracking|pixel|beacon|wf\/open|e\/o|mo|imp|trk)(\.(gif|png)|\/|\?|$))|([?&](utm_[a-z]+|mc_eid|_hsenc)=)/i;
const tiny = (v) => { const n = parseFloat(String(v || '')); return Number.isFinite(n) && n <= 3; };

/** CSS entschärfen: url() nur für data:, sonst raus; @import/expression/behavior/-moz-binding/fixed raus. */
function cleanCss(css, allowRemote) {
  return String(css || '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/expression\s*\(|behavio(u)?r\s*:|-moz-binding\s*:|javascript:/gi, 'x-blocked(')
    .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (m, q, u) => (/^data:image\//i.test(u) || (allowRemote && /^https?:\/\//i.test(u)) ? m : 'none'))
    .replace(/position\s*:\s*(fixed|sticky)/gi, 'position: static');
}

/**
 * html: Rohes HTML · opts: { remote: false, cid: { '<cid>': 'data:…' } }
 */
function sanitize(html, opts = {}) {
  const remote = !!opts.remote;
  const cid = opts.cid || {};
  let remoteImages = 0;
  let trackers = 0;
  const links = [];
  const out = sanitizeHtml(String(html || ''), {
    allowedTags: ['html', 'head', 'body', 'style', 'div', 'span', 'p', 'br', 'hr', 'a', 'img', 'b', 'i', 'u', 's', 'em', 'strong', 'small', 'big', 'sub', 'sup',
      'font', 'center', 'blockquote', 'q', 'cite', 'pre', 'code', 'tt', 'kbd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
      'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col', 'abbr', 'address', 'del', 'ins', 'mark', 'figure', 'figcaption',
      'section', 'article', 'header', 'footer', 'main', 'nav', 'aside', 'picture', 'wbr'],
    allowedAttributes: {
      '*': ['style', 'class', 'id', 'align', 'valign', 'width', 'height', 'bgcolor', 'color', 'border', 'dir', 'lang', 'title', 'role', 'aria-label', 'aria-hidden'],
      a: ['href', 'name', 'data-hw-href'],
      img: ['src', 'alt', 'width', 'height', 'data-hw-src', 'data-hw-blocked'],
      font: ['face', 'size', 'color'],
      table: ['cellpadding', 'cellspacing', 'summary', 'background'],
      td: ['colspan', 'rowspan', 'nowrap', 'background'],
      th: ['colspan', 'rowspan', 'nowrap', 'scope'],
      col: ['span'], colgroup: ['span'], ol: ['start', 'type', 'reversed'], li: ['value'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data', 'cid'],
    allowedSchemesByTag: { a: ['http', 'https', 'mailto', 'tel'], img: ['http', 'https', 'data', 'cid'] },
    allowedSchemesAppliedToAttributes: ['href', 'src', 'background'],
    allowProtocolRelative: false,
    allowVulnerableTags: true, // <style> – wird unten entschärft, die CSP der Oberfläche lässt ohnehin nichts nachladen
    disallowedTagsMode: 'discard',
    nonTextTags: ['script', 'textarea', 'option', 'noscript', 'title', 'iframe', 'object', 'embed', 'applet', 'frameset', 'frame', 'svg', 'math', 'template'],
    transformTags: {
      a: (tag, attribs) => {
        const href = String(attribs.href || '').trim();
        const a = { ...attribs };
        delete a.target;
        if (/^(https?:|mailto:|tel:)/i.test(href)) a['data-hw-href'] = href; else delete a.href;
        return { tagName: 'a', attribs: a };
      },
      img: (tag, attribs) => {
        const a = { ...attribs };
        const src = String(a.src || '').trim();
        const style = String(a.style || '');
        const hidden = /display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(\.0+)?\s*(;|$)/i.test(style);
        const small = (tiny(a.width) && tiny(a.height)) || (/width\s*:\s*[0-3]px/i.test(style) && /height\s*:\s*[0-3]px/i.test(style));
        if (/^cid:/i.test(src)) {
          const key = src.slice(4).replace(/^<|>$/g, '').toLowerCase();
          if (cid[key]) a.src = cid[key]; else delete a.src;
          return { tagName: 'img', attribs: a };
        }
        if (/^https?:\/\//i.test(src)) {
          if (hidden || small || (TRACK_PATH.test(src) && !a.alt && (!a.width || tiny(a.width)))) { trackers++; return { tagName: 'hw-tracker', attribs: {} }; }
          remoteImages++;
          if (!remote) { delete a.src; a['data-hw-src'] = src; a['data-hw-blocked'] = '1'; }
          return { tagName: 'img', attribs: a };
        }
        if (/^data:image\/(png|gif|jpe?g|webp|bmp);/i.test(src)) return { tagName: 'img', attribs: a };
        delete a.src;
        return { tagName: 'img', attribs: a };
      },
    },
  });
  // CSS in style-Attributen und <style> entschärfen; background-Attribut nur data:/erlaubt
  let html2 = out
    .replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, css) => `<style${a}>${cleanCss(css, remote)}</style>`)
    .replace(/\sstyle="([^"]*)"/gi, (m, css) => ` style="${cleanCss(css.replace(/&quot;/g, '"'), remote).replace(/"/g, '&quot;')}"`)
    .replace(/\sbackground="([^"]*)"/gi, (m, u) => (/^data:image\//i.test(u) || (remote && /^https?:\/\//i.test(u)) ? m : ''));
  for (const m of html2.matchAll(/<a\b[^>]*data-hw-href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    links.push({ href: m[1].replace(/&amp;/g, '&'), text: m[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim().slice(0, 300) });
  }
  if (links.length > 500) links.length = 500;
  html2 = html2.trim();
  return { html: html2, remoteImages, trackers, links };
}

/** Klartext → einfaches, sicheres HTML (Links anklickbar, Zitate eingerückt). */
function textToHtml(text) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let depth = 0;
  for (const raw of lines) {
    const m = /^((?:>\s?)*)(.*)$/.exec(raw);
    const d = (m[1].match(/>/g) || []).length;
    while (depth < d) { out.push('<blockquote>'); depth++; }
    while (depth > d) { out.push('</blockquote>'); depth--; }
    out.push(`${esc(m[2]).replace(/\b(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]])/g, (u) => `<a href="${u}" data-hw-href="${u}">${u}</a>`)}<br>`);
  }
  while (depth-- > 0) out.push('</blockquote>');
  return `<div class="hw-plain">${out.join('\n')}</div>`;
}

/** HTML → Klartext (für Vorschau, Suche, Zitat in Klartext-Antworten). */
function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

module.exports = { sanitize, cleanCss, textToHtml, htmlToText };

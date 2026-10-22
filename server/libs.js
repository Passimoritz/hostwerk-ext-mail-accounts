'use strict';
// Gebündelte Bibliotheken (imapflow, nodemailer, mailparser, sanitize-html) – erst beim ersten Gebrauch laden.
let libs = null;
const load = () => libs || (libs = require('./vendor/mail-libs.js'));
module.exports = {
  get ImapFlow() { return load().ImapFlow; },
  get nodemailer() { return load().nodemailer; },
  get MailComposer() { return load().MailComposer; },
  get simpleParser() { return load().simpleParser; },
  sanitizeHtml: (...a) => load().sanitizeHtml(...a),
};

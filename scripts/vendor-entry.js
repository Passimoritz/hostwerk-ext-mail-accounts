'use strict';
// Einstieg für das gebündelte Bibliotheks-Paket (scripts/vendor.js → server/vendor/mail-libs.js).
// Nur was der Server-Teil wirklich braucht – alles andere fällt beim Bündeln heraus.
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { simpleParser } = require('mailparser');
const sanitizeHtml = require('sanitize-html');

module.exports = { ImapFlow, nodemailer, MailComposer, simpleParser, sanitizeHtml };

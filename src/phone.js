// phone.js — the lead's phone as E.164, and phone masking for anything that
// reaches a log or an events row. `leadPhoneE164` is a copy of the rule in
// the platform's whatsapp/src/rules.js so both services read a `telefono`
// the same way.

/**
 * A `leads.telefono` value as E.164, or null when it cannot be one number:
 * an international number as typed, a Spanish mobile/landline without its
 * prefix, or one spelled with 0034 / 034.
 */
export const leadPhoneE164 = (raw) => {
  const digits = String(raw ?? '').replace(/^whatsapp:/i, '').replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{7,14}$/.test(digits)) return digits;
  if (/^[6789]\d{8}$/.test(digits)) return `+34${digits}`;
  const spelled = /^0{1,2}34([6789]\d{8})$/.exec(digits);
  return spelled ? `+34${spelled[1]}` : null;
};

/** Phone numbers out of a provider's error text before it reaches a log or an event. */
export const maskPhones = (s) => String(s).replace(/\+?\d[\d\s-]{6,}\d/g, '+…');

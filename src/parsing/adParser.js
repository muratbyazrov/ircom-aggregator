export function looksLikeAd(text, adKeywords) {
  if (!text) return false;
  const normalized = String(text).toLowerCase();

  if (adKeywords.some((kw) => normalized.includes(kw))) {
    return true;
  }

  const hasPhone = /(?:\+?\d[\d\s\-()]{8,}\d)/.test(normalized);
  const hasPrice = /(?:\d[\d\s]{2,}\s?(?:₽|\$|€|сом|тенге|руб|kzt|kgs|usd))/i.test(normalized);
  const hasSellingVerb = /(продам|продаю|куплю|сдам|ищу|вакансия|работа|услуги|аренда)/i.test(normalized);

  return hasSellingVerb && (hasPhone || hasPrice);
}

export function extractStructuredData(text) {
  const cleanText = String(text || '').trim();
  const lines = cleanText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const isMetaLine = (line) => /^(#?\s*(актуально|срочно|up|ап|подниму|вверх)(?:\s|$|[!?.])|[#@!?.\s]+)$/i.test(line);
  const titleLine = lines.find((line) => !isMetaLine(line)) || lines[0] || '';
  const title = titleLine.slice(0, 140);
  const description = lines
    .filter((line, idx) => !(idx === lines.indexOf(titleLine)))
    .join('\n')
    .slice(0, 4000);
  const price = extractPrice(cleanText);
  const contacts = extractContacts(cleanText);

  return {
    title: title || null,
    description: description || cleanText || null,
    priceValue: price.value,
    priceCurrency: price.currency,
    contactPhone: contacts.contactPhone,
    contactUsername: contacts.contactUsername,
  };
}

function extractPrice(text) {
  if (!text) return { value: null, currency: null };
  const normalized = String(text).replace(/\u00a0/g, ' ');

  const preferredMatch = normalized.match(
    /цена\s*[:\-]?\s*(?:(\$|€|₽)\s*)?(\d{1,3}(?:[ \t.,]\d{3})+|\d{2,9})(?:\s*(т|тыс|k|к|₽|\$|€|руб(?:\.|лей)?|сом|тенге|kzt|kgs|usd))?/i
  );
  const fallbackMatch = normalized.match(
    /(?:(\$|€|₽)\s*)?(\d{1,3}(?:[ \t.,]\d{3})+|\d{2,9})(?:\s*(т|тыс|k|к|₽|\$|€|руб(?:\.|лей)?|сом|тенге|kzt|kgs|usd))?/i
  );
  const match = preferredMatch || fallbackMatch;
  if (!match) return { value: null, currency: null };

  const rawValue = String(match[2]).replace(/[^\d]/g, '');
  if (!rawValue) return { value: null, currency: null };
  let value = Number(rawValue);
  if (!Number.isFinite(value)) return { value: null, currency: null };

  const rawCurrency = String(match[1] || match[3] || '').toLowerCase();
  if (/(^|\s)(т|тыс|k|к)(\s|$)/i.test(rawCurrency)) {
    value *= 1000;
  }

  let currency = null;
  if (rawCurrency.includes('$') || rawCurrency.includes('usd')) currency = 'USD';
  else if (rawCurrency.includes('€')) currency = 'EUR';
  else if (
    rawCurrency.includes('₽') ||
    rawCurrency.includes('руб') ||
    rawCurrency.includes('т') ||
    rawCurrency.includes('тыс') ||
    rawCurrency.includes('k') ||
    rawCurrency.includes('к')
  ) {
    currency = 'RUB';
  } else if (rawCurrency.includes('сом') || rawCurrency.includes('kgs')) currency = 'KGS';
  else if (rawCurrency.includes('тенге') || rawCurrency.includes('kzt')) currency = 'KZT';

  return { value, currency };
}

function extractContacts(text) {
  const normalized = String(text || '');
  const phoneMatches = normalized.match(/(?:\+?\d[\d\s\-()]{8,}\d)/g) || [];
  const phones = phoneMatches
    .map((phone) => phone.replace(/[^\d+]/g, ''))
    .filter((phone) => phone.length >= 10);
  const uniquePhones = [...new Set(phones)];

  const tgMatches = normalized.match(/(?:^|\s)@([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g) || [];
  const usernames = tgMatches
    .map((entry) => entry.trim().replace(/^@/, ''))
    .filter(Boolean);
  const uniqueUsernames = [...new Set(usernames)];

  return {
    contactPhone: uniquePhones.length > 0 ? uniquePhones.join(',') : null,
    contactUsername: uniqueUsernames.length > 0 ? uniqueUsernames.join(',') : null,
  };
}


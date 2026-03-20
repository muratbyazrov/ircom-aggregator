import test from 'node:test';
import assert from 'node:assert/strict';

import { extractStructuredData } from '../src/parsing/adParser.js';

function extractPriceValue(text) {
  return extractStructuredData(text).priceValue;
}

test('keeps grouped full prices without multiplying by 1000 again', () => {
  assert.equal(extractPriceValue('Цена 900.000\nТел 89298080404'), 900000);
  assert.equal(extractPriceValue('80.000 торг у капота'), 80000);
  assert.equal(extractPriceValue('Цена 330.000 торг'), 330000);
});

test('does not multiply full amounts with thousand suffix again', () => {
  assert.equal(extractPriceValue('Цена вместе 12000т'), 12000);
  assert.equal(extractPriceValue('Цена 380000т'), 380000);
  assert.equal(extractPriceValue('900000 тысяч'), 900000);
});

test('parses single-group thousand shorthand as millions', () => {
  assert.equal(extractPriceValue('Цена 1,400т'), 1400000);
  assert.equal(extractPriceValue('срочно 1.200т'), 1200000);
  assert.equal(extractPriceValue('цена 1.400 т'), 1400000);
});

test('parses local million shorthand with lemon emoji', () => {
  assert.equal(extractPriceValue('Цена 1850 🍋'), 1850000);
  assert.equal(extractPriceValue('1.3🍋'), 1300000);
  assert.equal(extractPriceValue('Цена 1🍋.200'), 1200000);
  assert.equal(extractPriceValue('Цена: 1 🍋350'), 1350000);
  assert.equal(extractPriceValue('ЦЕНА 1🍋850 ТЫС.РУБ.'), 1850000);
});

test('parses split million fractions', () => {
  assert.equal(extractPriceValue('Цена: 1, 75 мл. р.'), 1750000);
  assert.equal(extractPriceValue('Цена 1,8 м р.'), 1800000);
  assert.equal(extractPriceValue('Продается срочно за 1.2 м.'), 1200000);
});

test('prefers the main price over accessory surcharges', () => {
  const text = `#АКТУАЛЬНО
🍏iPhone 14 Pro 256gb🍏
Комплект: коробка, шнур(ориг шнур +500₽)

Цена: 45000`;
  assert.equal(extractPriceValue(text), 45000);
});

test('does not treat mileage as the listing price when a lemon price is present', () => {
  const text = `Lexus ES-350
2016 г
107 т м
1.3🍋`;
  assert.equal(extractPriceValue(text), 1300000);
});

test('does not prefer grouped mileage over the actual grouped price', () => {
  const text = 'Продаю mercedes 2003 год 1.8 237.000 км пробег машина находится в южной Осетии цена машины 230.000 машина не растаможена';
  assert.equal(extractPriceValue(text), 230000);
});

test('parses bare two-digit prices as thousands only near price keywords', () => {
  assert.equal(
    extractPriceValue('Продаю срочно айфон 16 АКБ 91 не скрывался цена 48 торг край 44'),
    48000
  );
  assert.equal(
    extractPriceValue('Продаю срочно айфон 16 АКБ 91 не скрывался цена 48 торг край 46'),
    48000
  );
});

test('extracts telegram username when it is written next to telegram marker', () => {
  const parsed = extractStructuredData('Писать telegram max_tskh\nТел 89298080404');

  assert.equal(parsed.contactPhone, '+79298080404');
  assert.equal(parsed.contactUsername, 'max_tskh');
  assert.match(parsed.contactText || '', /tg:@max_tskh/);
});

test('captures telegram alias and whatsapp slang in contact text', () => {
  const parsed = extractStructuredData('MAX Telegram\nвац 89891234567');

  assert.equal(parsed.contactPhone, '+79891234567');
  assert.equal(parsed.contactUsername, null);
  assert.match(parsed.contactText || '', /tg-alias:MAX/);
  assert.match(parsed.contactText || '', /wa:\+79891234567/);
});

test('marks telegram and whatsapp phone when markers are written near one number', () => {
  const parsed = extractStructuredData('89288562120 телеграмм ватсап');

  assert.equal(parsed.contactPhone, '+79288562120');
  assert.match(parsed.contactText || '', /tg-phone:\+79288562120/);
  assert.match(parsed.contactText || '', /wa:\+79288562120/);
});

test('does not treat bare phone near telegram marker as telegram alias', () => {
  const parsed = extractStructuredData('📲 +79890364645 Telegram');

  assert.equal(parsed.contactUsername, null);
  assert.doesNotMatch(parsed.contactText || '', /tg-alias:/);
  assert.match(parsed.contactText || '', /tg-phone:\+79890364645/);
});

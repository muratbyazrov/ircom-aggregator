import test from 'node:test';
import assert from 'node:assert/strict';

import {
  looksLikeTaxiOffer,
  extractTaxiStructuredData,
  extractTaxiPrice,
  isTaxiOfferExpired,
  resolveTaxiDepartureAt,
  TAXI_DIRECTION,
  TAXI_ROUTE_DIRECTION,
} from '../src/parsing/taxiParser.js';

const TAXI_MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

function assertLocalDepartureParts(departureAt, { year, month, day, hours, minutes }) {
  assert.equal(typeof departureAt, 'string');
  const date = new Date(new Date(departureAt).getTime() + TAXI_MOSCOW_OFFSET_MS);
  assert.equal(Number.isNaN(date.getTime()), false);
  assert.equal(date.getUTCFullYear(), year);
  assert.equal(date.getUTCMonth() + 1, month);
  assert.equal(date.getUTCDate(), day);
  assert.equal(date.getUTCHours(), hours);
  assert.equal(date.getUTCMinutes(), minutes);
}

test('extracts a simple intercity taxi offer', () => {
  const text = `Цхинвал - Владикавказ
сегодня 15:30
2 места
1000 руб
+79991234567`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(looksLikeTaxiOffer(text), true);
  assert.equal(parsed.direction, TAXI_DIRECTION.INTERCITY);
  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
  assert.equal(parsed.routeDirection, TAXI_ROUTE_DIRECTION.OUTBOUND);
  assert.equal(parsed.departureText, 'сегодня 15:30');
  assert.equal(parsed.seatsFree, 2);
  assert.equal(parsed.priceValue, 1000);
  assert.match(parsed.contactPhone, /\+79991234567/);
});

test('marks cargo offers with cargo direction', () => {
  const text = `Груз Цхинвал - Владикавказ
доставка посылок
2000 руб
+79990001122`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(looksLikeTaxiOffer(text), true);
  assert.equal(parsed.direction, TAXI_DIRECTION.CARGO);
  assert.equal(parsed.priceValue, 2000);
});

test('marks city taxi offers without route as city direction', () => {
  const text = `Такси по городу Цхинвал
быстро и аккуратно
500 руб
+79990001122`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(looksLikeTaxiOffer(text), true);
  assert.equal(parsed.direction, TAXI_DIRECTION.CITY);
  assert.equal(parsed.fromPlace, null);
  assert.equal(parsed.toPlace, null);
});

test('extracts route from emoji arrows and does not mark regular rides with parcels as cargo', () => {
  const text = `Водитель 🚗
19 марта
Выезд в 13:00
Цхинвал🛫Владикавказ🛬
3 места
Заберу посылки
Проезд 800 рублей
+79298102005`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
  assert.equal(parsed.direction, TAXI_DIRECTION.INTERCITY);
});

test('extracts route from separate source and destination lines', () => {
  const text = `Еду завтра
С ЦХИНВАЛА
Во ВЛАДИКАВКАЗ
Есть 3 места
Проезд 800 рублей
89298108676`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.direction, TAXI_DIRECTION.INTERCITY);
});

test('infers route from a single destination line when only one known city is present', () => {
  const text = `ВОДИТЕЛЬ
ЕДУ СЕГОДНЯ
В 15.00
ВО ВЛАДИКАВКАЗ
ПОСАДКА У ДОМА
ПРОЕЗД 800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
  assert.equal(parsed.displayName, 'Цхинвал - Владикавказ');
});

test('infers reverse route from a single destination line to tskhinval', () => {
  const text = `ВОДИТЕЛЬ
ЕДУ СЕГОДНЯ
В 17.00
В ЦХИНВАЛ
ВЫСАДКА У ДОМА
ПРОЕЗД 800 Р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Владикавказ');
  assert.equal(parsed.toPlace, 'Цхинвал');
  assert.equal(parsed.routeText, 'Владикавказ - Цхинвал');
  assert.equal(parsed.routeDirection, TAXI_ROUTE_DIRECTION.INBOUND);
  assert.equal(parsed.displayName, 'Владикавказ - Цхинвал');
});

test('infers route from a decorated destination-only line', () => {
  const text = `ВОДИТЕЛЬ
🏙. ВО ВЛАДИКАВКАЗ
⏱. ВЫЕЗД В 7.00 УТРА
ПРОЕЗД 800 Р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
});

test('infers route from a narrative line with destination and trailing time text', () => {
  const text = `завтра еду во владикавказ 7-8 часов
есть 3 места
Проезд 800р
машина хонда`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
});

test('keeps cargo direction for pure package delivery offers', () => {
  const text = `Только доставка посылок
Пункт выдачи заказов
300 руб
+79965777495`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.direction, TAXI_DIRECTION.CARGO);
});

test('extracts route from known cities without separators', () => {
  const text = `Водитель
Toyota минивэн
Цхинвал Владикавказ
Есть 5 мест
Проезд 800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
  assert.equal(parsed.direction, TAXI_DIRECTION.INTERCITY);
  assert.equal(parsed.vehicle, 'Toyota минивэн');
});

test('canonicalizes lowercase known locations in route text', () => {
  const text = `Завтра 20 марта
Цхинвал-владикавказ
4 мест по 800`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Цхинвал');
  assert.equal(parsed.toPlace, 'Владикавказ');
  assert.equal(parsed.routeText, 'Цхинвал - Владикавказ');
});

test('extracts vehicle from explicit car label', () => {
  const text = `Машина: Лада Гранта
Еду сегодня во Владикавказ
Есть 3 места
800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'Лада Гранта');
});

test('does not treat avto in avtovokzal as vehicle label', () => {
  const text = `Водитель
Toyota минивэн
ВЫСАДКА Автовокзал
Проезд 800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'Toyota минивэн');
});

test('does not treat avtovokzal line as vehicle when no car is specified', () => {
  const text = `ВЫСАДКА АВТОВОКЗАЛ
Проезд 800р
+79991234567`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, null);
});

test('trims seat and price tail from vehicle line', () => {
  const text = `Через 30 минут еду
ИЗ ЦХИНВАЛА
ВО ВЛАДИКАВКАЗ
Лада гранта, 1 место, 800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'Лада гранта');
});

test('trims whatsapp and telegram markers from vehicle line', () => {
  const text = `Завтра 20 числа еду во Владикавказ
Выезд 15:30--16:00
Машина МИНИВЕН. Вотсап, Телеграм,Макс +79388842704`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'МИНИВЕН');
});

test('strips driver filler before vehicle brand', () => {
  const text = `Я Водитель LADA VESTA
Из Цхинвала во Владикавказ
Есть 4 места - 800 р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'LADA VESTA');
});

test('strips driver filler before vehicle brand in emoji-decorated line', () => {
  const text = `😎Я Водитель 👉 🚘LADA VESTA
Из Цхинвала
Во Владикавказ`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'LADA VESTA');
});

test('extracts alphard from expressive vehicle line', () => {
  const text = `Не машина а ракета альфард на ракетном топливе
Цхинвал-владикавказ
4 мест по 800`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'альфард');
});

test('extracts alphard from expressive vehicle line with emoji noise', () => {
  const text = `Не машина 🚘 а ракета🚀🚀🚀 альфард на🚀🚀 ракетном топливе
Цхинвал-владикавказ
4 мест по 800`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, 'альфард');
});

test('does not extract generic full car sentence as vehicle', () => {
  const text = 'ЕДУ ИЗ ВЛАДИКАВКАЗА ЦХИНВАЛ ПОД ЗАКАЗ ВЫЕЗД ЛЮБОЕ ВРЕМЯ И ДЕНЬ ПОЛНАЯ МАШИНА 3500 РУБ';

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.vehicle, null);
});

test('extracts canonical route from inflected city names', () => {
  const text = `Выезжаю с Владикавказа в Цхинвал
Есть 3 места
800р`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.fromPlace, 'Владикавказ');
  assert.equal(parsed.toPlace, 'Цхинвал');
  assert.equal(parsed.routeText, 'Владикавказ - Цхинвал');
  assert.equal(parsed.direction, TAXI_DIRECTION.INTERCITY);
});

test('keeps cargo direction for pure package delivery even with driver and departure text', () => {
  const text = `Водитель: Альберт
Время выезда 16:00
ТОЛЬКО доставка посылок
300 р. Пункт выдачи заказов
WB OZON
+79965777495`;

  const parsed = extractTaxiStructuredData(text);

  assert.equal(parsed.direction, TAXI_DIRECTION.CARGO);
});

test('resolves relative departure with time to backend-friendly iso string', () => {
  const departureAt = resolveTaxiDepartureAt(
    `20 марта завтра
Выезд в 7:00`,
    '2026-03-19T15:38:46.000Z'
  );

  assert.equal(typeof departureAt, 'string');
  assert.match(departureAt, /^2026-03-20T/);
});

test('resolves explicit local date without year using reference year', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Завтра 20.03
Время выезда 11:00`,
    '2026-03-19T15:38:46.000Z'
  );

  assert.equal(typeof departureAt, 'string');
  assert.match(departureAt, /^2026-03-20T/);
});

test('resolves explicit local date without year when telegram message date is unix seconds', () => {
  const departureAt = resolveTaxiDepartureAt(
    `20 марта
Выезд в 10:00`,
    1773954068
  );

  assert.equal(typeof departureAt, 'string');
  assert.match(departureAt, /^2026-03-20T/);
});

test('resolves today with dot time format', () => {
  const departureAt = resolveTaxiDepartureAt(
    `сегодня еду во владикавказ
13.00 часов
есть 3 места`,
    '2026-03-19T09:15:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 19, hours: 13, minutes: 0 });
});

test('resolves weekday with explicit time range using post date as reference', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Еду завтра 14..03.26г.
(Суббота) с 07:00-07:30.
Из Цхинвала
Во Владикавказ`,
    '2026-03-13T20:00:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 14, hours: 7, minutes: 0 });
});

test('resolves day-of-month and hour range from text', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Утром 15 числа еду во Владикавказ
Еду часов в 8-9`,
    '2026-03-14T18:00:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 15, hours: 8, minutes: 0 });
});

test('resolves hour-only departure text like from 12 hours', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Еду из Цхинвала Владикавказ
Выезд с 12 часов или по набору`,
    '2026-03-19T08:00:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 19, hours: 12, minutes: 0 });
});

test('resolves relative offset phrases like within an hour', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Добрый день. Еду в Цхинвал, в течение часа. Есть 4 места`,
    '2026-03-19T10:15:00.000Z'
  );

  assert.equal(typeof departureAt, 'string');
  assert.match(departureAt, /^2026-03-19T11:15:00/);
});

test('resolves relative offset phrases like in 30 minutes', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Через 30 минут еду
Из Цхинвала
Во Владикавказ`,
    '2026-03-19T10:15:00.000Z'
  );

  assert.equal(typeof departureAt, 'string');
  assert.match(departureAt, /^2026-03-19T10:45:00/);
});

test('resolves today by Moscow calendar day when telegram timestamp is near UTC midnight', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Сегодня в 07:00 еду во Владикавказ`,
    '2026-03-19T21:30:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 20, hours: 7, minutes: 0 });
});

test('resolves tomorrow by Moscow calendar day when telegram timestamp is near UTC midnight', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Завтра в 07:00 еду во Владикавказ`,
    '2026-03-19T21:30:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 21, hours: 7, minutes: 0 });
});

test('resolves bare time against Moscow calendar day from telegram timestamp', () => {
  const departureAt = resolveTaxiDepartureAt(
    `Выезд 01:15, Цхинвал - Владикавказ`,
    '2026-03-19T21:30:00.000Z'
  );

  assertLocalDepartureParts(departureAt, { year: 2026, month: 3, day: 20, hours: 1, minutes: 15 });
});

test('extracts richer departure text when today and time are present', () => {
  const parsed = extractTaxiStructuredData(`сегодня еду во владикавказ
13.00 часов
есть 3 места`);

  assert.match(parsed.departureText || '', /сегодня/i);
  assert.match(parsed.departureText || '', /13\.00|13:00/i);
});

test('extracts departure text for hour ranges and hour-only phrasing', () => {
  const rangeParsed = extractTaxiStructuredData(`Утром еду во Владикавказ
Еду часов в 8-9
800р`);
  const hourOnlyParsed = extractTaxiStructuredData(`Еду из Цхинвала Владикавказ
Выезд с 12 часов или по набору`);

  assert.match(rangeParsed.departureText || '', /8-9|утром/i);
  assert.match(hourOnlyParsed.departureText || '', /12\s*час/i);
});

test('prefers per-seat price over full car price in one taxi post', () => {
  const text = 'Еду из Цхинвала Владикавказ Заберу 3 пассажира по 800 руб. Возможен под заказ выезд любое время. Полная машина 3000 руб';

  assert.equal(extractTaxiPrice(text, 3000), 800);
  assert.equal(extractTaxiStructuredData(text).priceValue, 800);
});

test('extracts bare price after proezd keyword without currency marker', () => {
  const text = `Водитель
Из Цхинвала во Владикавказ
ПРОЕЗД 800
Есть 4 места`;

  assert.equal(extractTaxiPrice(text, null), 800);
  assert.equal(extractTaxiStructuredData(text).priceValue, 800);
});

test('extracts bare dotted price after proezd keyword', () => {
  const text = `Владикавказ - Цхинвал
Завтра утром
Проезд 800.
Тел. 89286882227`;

  assert.equal(extractTaxiPrice(text, null), 800);
  assert.equal(extractTaxiStructuredData(text).priceValue, 800);
});

test('marks taxi offer as expired when departure time is already in the past', () => {
  const text = `Сегодня в 7:30 еду во Владикавказ
Есть 3 места
800р`;

  assert.equal(
    isTaxiOfferExpired(text, '2026-03-19T06:00:00.000Z', new Date('2026-03-19T18:00:00.000Z')),
    true
  );
});

test('does not mark taxi offer as expired when departure is still ahead', () => {
  const text = `Завтра в 7:30 еду во Владикавказ
Есть 3 места
800р`;

  assert.equal(
    isTaxiOfferExpired(text, '2026-03-19T06:00:00.000Z', new Date('2026-03-19T18:00:00.000Z')),
    false
  );
});

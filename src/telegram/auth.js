import input from 'input';

export function buildAuthParams({ defaultPhoneNumber, forceSms }) {
  let authForceSms = forceSms;
  const authParams = {
    phoneNumber: async () => {
      const phone = defaultPhoneNumber.trim();
      if (!/^\+\d{10,15}$/.test(phone)) {
        throw new Error('PHONE_NUMBER_INVALID');
      }
      return phone;
    },
    password: async () => await input.text('2FA password (если есть): '),
    phoneCode: async (isCodeViaApp) => {
      if (isCodeViaApp === true) {
        console.log('Код отправлен в приложение Telegram (служебный чат Telegram).');
      } else if (isCodeViaApp === false) {
        console.log('Код отправлен по SMS на номер.');
      }
      return await input.text('Code from Telegram: ');
    },
    onError: async (err) => {
      logAuthError(err);
      const raw = String(err?.errorMessage || err?.message || err).toUpperCase();
      if (raw.includes('SEND_CODE_UNAVAILABLE') && authForceSms) {
        authForceSms = false;
        authParams.forceSMS = false;
        console.log('Переключаюсь с SMS на код в приложении Telegram и повторяю вход.');
        return false;
      }
      return shouldStopAuth(err, authForceSms);
    },
    forceSMS: authForceSms,
  };

  return authParams;
}

export function logAuthError(err) {
  const hint = explainAuthError(err);
  if (hint) {
    console.error(`Auth error: ${hint}`);
  }
  console.error(err);
}

function explainAuthError(err) {
  const raw = String(err?.errorMessage || err?.message || err).toUpperCase();
  const waitSeconds = Number(err?.seconds) || Number(raw.match(/FLOOD_WAIT_?(\d+)/)?.[1] || 0);

  if (raw.includes('FLOOD_WAIT') || raw === 'FLOOD' || err?.code === 420 || waitSeconds > 0) {
    return waitSeconds > 0
      ? `Слишком много попыток входа. Подождите ${waitSeconds} сек.`
      : 'Слишком много попыток входа. Подождите и попробуйте позже.';
  }
  if (raw.includes('PHONE_NUMBER_INVALID')) return 'Неверный номер телефона. Используйте формат +7XXXXXXXXXX.';
  if (raw.includes('PHONE_CODE_INVALID')) return 'Неверный код подтверждения из Telegram.';
  if (raw.includes('PHONE_CODE_EXPIRED')) return 'Код подтверждения истек. Запросите новый код.';
  if (raw.includes('SEND_CODE_UNAVAILABLE')) {
    return 'Telegram не разрешает resend/SMS для этого входа. Отключите TG_FORCE_SMS и получите код в приложении Telegram.';
  }
  if (raw.includes('SESSION_PASSWORD_NEEDED')) return 'На аккаунте включен 2FA. Введите пароль в поле 2FA password.';
  if (raw.includes('PASSWORD_HASH_INVALID')) return 'Неверный 2FA-пароль.';
  if (raw.includes('AUTH_RESTART')) return 'Авторизация сброшена Telegram. Повторите вход.';

  return null;
}

function shouldStopAuth(err, currentForceSms = false) {
  const raw = String(err?.errorMessage || err?.message || err).toUpperCase();

  if (raw.includes('FLOOD_WAIT') || raw === 'FLOOD' || err?.code === 420 || Number(err?.seconds) > 0) {
    return true;
  }
  if (raw.includes('SEND_CODE_UNAVAILABLE')) return !currentForceSms;
  if (raw.includes('PHONE_NUMBER_INVALID')) return true;
  return false;
}


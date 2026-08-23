> **HISTORICAL PLAN — DO NOT USE AS CURRENT INSTALLATION INSTRUCTIONS**
> `setup.sql` and `oauth-protect.sql` have been retired from the current project tree.

# План: Google OAuth для «Классной копилки 2 „А“»

## 1. `index.html` — авторизация через Google

### Конфиг Supabase-клиента (сейчас строки 582–588)
Включаю обратно механизмы сессии, обязательные для OAuth:
```js
auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
```

### Разметка
- **Экран входа `#authGate`** — карточка в стиле сайта (бумага, пунктирные рамки, шрифт Neucha): логотип-копилка, заголовок «Классная копилка 2 „А“», подпись «Финансовый отчёт — только для родителей» и красивая кнопка **«Войти через Google»** (белая, с официальным разноцветным G-логотипом SVG, hover/active-эффекты, состояние «Перенаправляем…»).
- **`#protectedContent`** (скрыт по умолчанию) — оборачиваю существующие блоки: статистику, табы, секции «Ученики / Расходы / Фонды». Логику таблиц не трогаю.
- **Шапка** — при входе показываются маленький чип с email пользователя и компактная кнопка **«Выйти»** (скрыты до входа). Кнопка «Для учителя» (PIN) и плавающие модалки редактирования тоже доступны только после входа.

### JS-логика
- `signInWithGoogle()` → `supabase.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin + window.location.pathname } })`.
- `supabase.auth.onAuthStateChange(...)`: при наличии сессии — скрыть гейт, показать контент, email в шапке и **один раз** вызвать `loadAllData() → renderAll() → subscribeToRealtime()` (флаг-защита от повторного запуска при TOKEN_REFRESHED). При SIGNED_OUT — вернуть экран входа, сбросить режим администратора, закрыть realtime-канал.
- Прямой вызов `loadAllData()` из `DOMContentLoaded` убирается — загрузка таблиц теперь только после авторизации (как вы просили, логика БД не меняется, только обёртка).
- `signOutApp()` → `supabase.auth.signOut()`; статус-пилюля в шапке при выходе показывает нейтральное «Ожидаем входа».

## 2. Новый файл `oauth-protect.sql` — серверное скрытие данных
Небольшой скрипт для SQL Editor (не пересоздаёт таблицы, данные не трогает):
```sql
REVOKE SELECT ON funds, students, campaigns, contributions, expenses FROM anon;
REVOKE EXECUTE ON FUNCTION verify_admin_pin(TEXT),
  admin_set_contribution(TEXT, UUID, UUID, NUMERIC),
  admin_add_expense(TEXT, DATE, TEXT, UUID, NUMERIC, TEXT),
  admin_delete_expense(TEXT, UUID),
  admin_add_student(TEXT, TEXT) FROM anon;
```
Роль `authenticated` (вошедшие через Google) сохраняет все права — приложение для родителей и учителя работает как раньше, но анонимно бюджет больше не прочитать ни через сайт, ни напрямую через API.

## 3. `README.md` — инструкция по включению Google OAuth
Раздел «Вход через Google» с шагами:
1. Google Cloud Console: экран согласия → OAuth Client ID (Web), redirect URI `https://vdeexzvsjlqvsjlqvyckvqqvz.supabase.co/auth/v1/callback` (точный URL — `https://vdeexzvsjlqvyckvqqvz.supabase.co/auth/v1/callback`).
2. Supabase → Authentication → Providers → Google → включить, вставить Client ID/Secret.
3. Authentication → URL Configuration: Site URL = адрес сайта, добавить redirect-адреса (продакшен + `http://localhost:8080`).
4. Модерация: удаление неизвестных почт в Authentication → Users (сессия удалённого пользователя отвалится в течение часа при обновлении токена).
5. ~~Запуск `oauth-protect.sql`.~~ Устаревший исторический шаг — не выполнять.

## Проверка
- Локальный сервер (`python3 -m http.server`): до входа — только экран входа, контент и кнопка «Для учителя» скрыты; после входа (эмуляция/реальный редирект) — контент, email и «Выйти»; после выхода — снова гейт.
- Консоль без ошибок, загрузка таблиц не стартует до авторизации.
- Полный цикл OAuth требует настроенного провайдера в дашборде — проверю UI-состояния и подготовлю точную инструкцию для настройки.

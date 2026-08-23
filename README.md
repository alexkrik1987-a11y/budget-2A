# «Бюджет класса» — запуск и подключение Supabase

Проект состоит из статического адаптивного интерфейса и базы Supabase. Сборка через npm не требуется: сайт можно разместить на Netlify, Vercel, Cloudflare Pages, GitHub Pages или обычном Nginx-хостинге.

## Что реализовано

Интерфейс содержит сводку с общей кассой и тремя фондами, круговые диаграммы, автоматические статусы учеников, поиск и фильтры, шаблоны сборов, журнал расходов, закрытое хранилище чеков, месячные CSV/Excel-отчёты и печать. Также доступны ручные и ежедневные резервные копии, восстановление из JSON и отмена последнего изменения.

Родитель может только читать данные. Администратор меняет план сбора, открывает и закрывает сборы, вводит взносы, добавляет расходы и ссылки на чеки. Права защищены не только интерфейсом, но и RLS-политиками PostgreSQL.

## 1. Создание проекта Supabase

Создайте проект на Supabase. В разделе **SQL Editor → New query** выполняйте актуальные SQL-файлы отдельно и строго в таком порядке:

1. `supabase.sql`
2. `class-chat.sql`
3. `chat-pinning.sql`
4. `chat-archive.sql`
5. `parent-access-requests.sql`
6. `archive-features.sql`
7. `class-receipts-storage.sql`
8. `useful-info.sql`

Для существующей базы применяйте только отдельно согласованный файл нужной функции после PRE-CHECK. Не запускайте весь набор повторно как одну миграцию.

Затем добавьте email администратора и родителей. Адреса должны совпадать с Google-аккаунтами и быть в нижнем регистре:

````sql
insert into public.class_members (email, role) values
  ('admin@example.com', 'ADMIN'),
  ('parent1@example.com', 'PARENT'),
  ('parent2@example.com', 'PARENT')
on conflict (email) do update set role = excluded.role;
````

## 2. Google OAuth

В Supabase откройте **Authentication → Providers → Google** и включите Google. Создайте OAuth Client в Google Cloud Console и перенесите Client ID и Client Secret в Supabase.

В Google OAuth укажите callback URL, который показывает Supabase в настройках Google Provider. Обычно он имеет вид:

````text
https://PROJECT_ID.supabase.co/auth/v1/callback
````

В **Authentication → URL Configuration** укажите публичный адрес сайта как `Site URL`, а также добавьте его в `Redirect URLs`. Для локальной проверки добавьте:

````text
http://localhost:8080/**
````

## 3. Подключение frontend

В начале `app.js` замените два значения:

````javascript
const SUPABASE_URL = "https://PROJECT_ID.supabase.co";
const SUPABASE_ANON_KEY = "ВАШ_PUBLISHABLE_ИЛИ_ANON_KEY";
````

Используйте только **Publishable key** или старый **anon key**. Никогда не публикуйте `service_role key`: он обходит RLS и предназначен исключительно для защищённого сервера.

## 4. Локальный запуск

Не открывайте `index.html` через `file://`, потому что OAuth требует HTTP-адрес. Запустите локальный сервер из каталога проекта:

````bash
cd budget-class
python3 -m http.server 8080 --bind 127.0.0.1
````

Откройте `http://localhost:8080`.

## 5. Размещение на Nginx

Скопируйте файлы на сервер с безопасными правами:

````bash
sudo mkdir -p /var/www/budget-class
sudo cp index.html styles.css app.js /var/www/budget-class/
sudo chown -R root:root /var/www/budget-class
sudo find /var/www/budget-class -type d -exec chmod 755 {} \;
sudo find /var/www/budget-class -type f -exec chmod 644 {} \;
````

Пример `/etc/nginx/sites-available/budget-class.conf`:

````nginx
server {
    listen 80;
    listen [::]:80;
    server_name budget.example.ru;

    root /var/www/budget-class;
    index index.html;

    server_tokens off;

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(?:css|js|png|jpg|jpeg|gif|svg|webp|ico)$ {
        expires 7d;
        add_header Cache-Control "public, max-age=604800, immutable";
        try_files $uri =404;
    }

    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
}
````

Активируйте конфигурацию и выпустите TLS-сертификат:

````bash
sudo ln -s /etc/nginx/sites-available/budget-class.conf /etc/nginx/sites-enabled/budget-class.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d budget.example.ru
````

После публикации добавьте `https://budget.example.ru/**` в Supabase Redirect URLs.

## Важные замечания

Фонд «Дни рождения» присутствует в расчётах. Чтобы начать собирать в него деньги, администратор создаёт в разделе «Настройки» новый сбор и выбирает фонд «Дни рождения». Исходные 9 месяцев относятся к основному фонду, а 4 праздника — к фонду праздников.

Чеки, загруженные через форму расхода, хранятся в приватном Supabase Storage и открываются участникам класса по временной ссылке. Внешние HTTPS-ссылки оставлены как запасной вариант. Для персональных данных учеников рекомендуется использовать сокращённые фамилии, как в исходном списке, и выдавать доступ только актуальным родителям.

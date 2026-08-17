-- =====================================================
-- Защита данных: чтение только для вошедших
-- =====================================================
-- Запустите один раз в Supabase SQL Editor после setup.sql.
-- Скрипт не пересоздаёт таблицы и не удаляет данные: он лишь
-- забирает у анонимной роли (anon) право читать таблицы и
-- вызывать административные RPC. Роль authenticated
-- (вошедшие через Google) все права сохраняет.

REVOKE SELECT ON funds, students, campaigns, contributions, expenses FROM anon;

REVOKE EXECUTE ON FUNCTION verify_admin_pin(TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_set_contribution(TEXT, UUID, UUID, NUMERIC) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_add_expense(TEXT, DATE, TEXT, UUID, NUMERIC, TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_delete_expense(TEXT, UUID) FROM anon;
REVOKE EXECUTE ON FUNCTION admin_add_student(TEXT, TEXT) FROM anon;

-- =====================================================
-- SQL-скрипт для Supabase: Бюджет 2А класса
-- =====================================================
-- Вставьте скрипт целиком в Supabase SQL Editor и выполните один раз.
-- Скрипт пересоздаёт таблицы и данные класса.

CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

DROP TABLE IF EXISTS expenses CASCADE;
DROP TABLE IF EXISTS contributions CASCADE;
DROP TABLE IF EXISTS campaigns CASCADE;
DROP TABLE IF EXISTS students CASCADE;
DROP TABLE IF EXISTS funds CASCADE;
DROP TABLE IF EXISTS class_budget_settings CASCADE;

CREATE TABLE funds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO funds (name, description, color, sort_order) VALUES
  ('Основной фонд', 'Канцелярия, учебные материалы, подарки учителю', '#3b82f6', 1),
  ('Праздники', 'Новый год, 8 марта, выпускной', '#ec4899', 2),
  ('Дни рождения', 'Подарки именинникам', '#f59e0b', 3),
  ('Хознужды', 'Моющие средства, бумажные полотенца', '#10b981', 4),
  ('Экскурсии', 'Поездки, музеи, театры', '#8b5cf6', 5);

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  last_name TEXT NOT NULL CHECK (char_length(trim(last_name)) BETWEEN 2 AND 120),
  first_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO students (last_name, sort_order) VALUES
  ('Варчак К.', 1), ('Горовик В.', 2), ('Дергачёв А.', 3),
  ('Иштутинов Т.', 4), ('Кармес Д.', 5), ('Лепетухина В.', 6),
  ('Лукьянова С.', 7), ('Макаренко О.', 8), ('Марков М.', 9),
  ('Мотовилов З.', 10), ('Удовенко А.', 11), ('Чан В.', 12),
  ('Ширманова Д.', 13), ('Яковлева М.', 14);

CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE RESTRICT,
  type TEXT NOT NULL DEFAULT 'ONE_TIME' CHECK (type IN ('ONE_TIME', 'MONTHLY', 'CUSTOM')),
  expected_amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (expected_amount >= 0),
  is_open BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO campaigns (name, fund_id, type, expected_amount, is_open, sort_order)
SELECT 'Основной сбор', id, 'MONTHLY', 1000.00, TRUE, 1
FROM funds WHERE name = 'Основной фонд';

CREATE TABLE contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  amount NUMERIC(10, 2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, campaign_id)
);

INSERT INTO contributions (student_id, campaign_id, amount)
SELECT s.id, c.id, 0.00
FROM students s CROSS JOIN campaigns c WHERE c.is_open;

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  date DATE NOT NULL,
  description TEXT NOT NULL CHECK (char_length(trim(description)) BETWEEN 2 AND 500),
  amount NUMERIC(10, 2) NOT NULL CHECK (amount > 0),
  category TEXT NOT NULL DEFAULT 'MAIN',
  fund_id UUID NOT NULL REFERENCES funds(id) ON DELETE RESTRICT,
  receipt_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE class_budget_settings (
  key TEXT PRIMARY KEY,
  pin_hash TEXT NOT NULL
);

INSERT INTO class_budget_settings (key, pin_hash)
VALUES ('admin_pin', extensions.crypt('8521', extensions.gen_salt('bf')));

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER contributions_updated_at BEFORE UPDATE ON contributions
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER expenses_updated_at BEFORE UPDATE ON expenses
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Родители имеют только публичное чтение. Все изменения проходят через RPC ниже.
ALTER TABLE funds ENABLE ROW LEVEL SECURITY;
ALTER TABLE students ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE class_budget_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public can read funds" ON funds FOR SELECT USING (true);
CREATE POLICY "Public can read students" ON students FOR SELECT USING (true);
CREATE POLICY "Public can read campaigns" ON campaigns FOR SELECT USING (true);
CREATE POLICY "Public can read contributions" ON contributions FOR SELECT USING (true);
CREATE POLICY "Public can read expenses" ON expenses FOR SELECT USING (true);

-- Проверка PIN выполняется в базе, а сам hash не доступен через API.
CREATE OR REPLACE FUNCTION verify_admin_pin(pin TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM class_budget_settings
    WHERE key = 'admin_pin' AND pin_hash = extensions.crypt(pin, pin_hash)
  );
END;
$$;

CREATE OR REPLACE FUNCTION admin_set_contribution(
  pin TEXT, target_student_id UUID, target_campaign_id UUID, new_amount NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE result_id UUID;
BEGIN
  IF NOT verify_admin_pin(pin) THEN RAISE EXCEPTION 'Неверный ПИН-код'; END IF;
  IF new_amount IS NULL OR new_amount < 0 OR new_amount > 100000000 THEN
    RAISE EXCEPTION 'Некорректная сумма';
  END IF;
  INSERT INTO contributions (student_id, campaign_id, amount)
  VALUES (target_student_id, target_campaign_id, new_amount)
  ON CONFLICT (student_id, campaign_id) DO UPDATE SET amount = EXCLUDED.amount
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_add_expense(
  pin TEXT, expense_date DATE, expense_description TEXT, target_fund_id UUID,
  expense_amount NUMERIC, expense_receipt_url TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE result_id UUID;
BEGIN
  IF NOT verify_admin_pin(pin) THEN RAISE EXCEPTION 'Неверный ПИН-код'; END IF;
  IF expense_date IS NULL OR char_length(trim(expense_description)) < 2
     OR expense_amount IS NULL OR expense_amount <= 0 OR expense_amount > 100000000 THEN
    RAISE EXCEPTION 'Некорректные данные расхода';
  END IF;
  INSERT INTO expenses (date, description, fund_id, amount, receipt_url)
  VALUES (expense_date, trim(expense_description), target_fund_id, expense_amount, NULLIF(trim(expense_receipt_url), ''))
  RETURNING id INTO result_id;
  RETURN result_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_delete_expense(pin TEXT, target_expense_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
BEGIN
  IF NOT verify_admin_pin(pin) THEN RAISE EXCEPTION 'Неверный ПИН-код'; END IF;
  DELETE FROM expenses WHERE id = target_expense_id;
  RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION admin_add_student(pin TEXT, student_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE new_id UUID; next_order INTEGER;
BEGIN
  IF NOT verify_admin_pin(pin) THEN RAISE EXCEPTION 'Неверный ПИН-код'; END IF;
  IF char_length(trim(student_name)) < 2 THEN RAISE EXCEPTION 'Укажите имя ученика'; END IF;
  SELECT COALESCE(MAX(sort_order), 0) + 1 INTO next_order FROM students;
  INSERT INTO students (last_name, sort_order) VALUES (trim(student_name), next_order) RETURNING id INTO new_id;
  INSERT INTO contributions (student_id, campaign_id, amount)
  SELECT new_id, id, 0 FROM campaigns WHERE is_open;
  RETURN new_id;
END;
$$;

-- Убираем прямую запись через REST API и открываем только необходимые RPC.
REVOKE ALL ON TABLE class_budget_settings FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON funds, students, campaigns, contributions, expenses FROM anon, authenticated;
GRANT SELECT ON funds, students, campaigns, contributions, expenses TO anon, authenticated;
REVOKE ALL ON FUNCTION verify_admin_pin(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_set_contribution(TEXT, UUID, UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_add_expense(TEXT, DATE, TEXT, UUID, NUMERIC, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_delete_expense(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_add_student(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION verify_admin_pin(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_set_contribution(TEXT, UUID, UUID, NUMERIC) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_add_expense(TEXT, DATE, TEXT, UUID, NUMERIC, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_delete_expense(TEXT, UUID) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_add_student(TEXT, TEXT) TO anon, authenticated;

-- Supabase Realtime для обновления у всех открытых вкладок.
ALTER PUBLICATION supabase_realtime ADD TABLE students, campaigns, contributions, expenses, funds;

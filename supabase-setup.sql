-- ═══════════════════════════════════════════════════════════
-- أنا وانت — إعداد Supabase الكامل (آمن)
-- شغّل مرة واحدة: Supabase → SQL Editor → Run
-- ═══════════════════════════════════════════════════════════

-- أعمدة إضافية
ALTER TABLE public.game_rooms
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

ALTER TABLE public.game_rooms
  ADD COLUMN IF NOT EXISTS enabled_cats text DEFAULT '["r","d","n"]';

UPDATE public.game_rooms
  SET created_at = to_timestamp(host_heartbeat / 1000.0)
  WHERE created_at IS NULL AND host_heartbeat > 0;

UPDATE public.game_rooms
  SET enabled_cats = '["r","d","n"]'
  WHERE enabled_cats IS NULL;

-- Realtime: بث تحديثات الغرف
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.game_rooms;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- قراءة توكن الغرفة من الهيدر
CREATE OR REPLACE FUNCTION public.get_room_token()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(TRIM((current_setting('request.headers', true)::json ->> 'x-room-token')), '');
$$;

-- عدد غرف الانتظار الفارغة (حد إنشاء عام)
CREATE OR REPLACE FUNCTION public.count_recent_waiting_rooms()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COUNT(*)::integer
  FROM public.game_rooms
  WHERE status = 'waiting'
    AND guest_name IS NULL
    AND created_at > now() - interval '2 hours';
$$;

-- معاينة غرفة بالكود (بدون توكنات)
CREATE OR REPLACE FUNCTION public.preview_room_by_code(p_code text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.game_rooms%ROWTYPE;
BEGIN
  IF p_code IS NULL OR length(trim(p_code)) <> 6 OR trim(p_code) !~ '^\d{6}$' THEN
    RETURN NULL;
  END IF;

  SELECT *
  INTO r
  FROM public.game_rooms
  WHERE code = trim(p_code)
    AND status = 'waiting'
    AND guest_name IS NULL
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN json_build_object(
    'id', r.id,
    'code', r.code,
    'host_name', r.host_name,
    'enabled_cats', r.enabled_cats,
    'status', r.status
  );
END;
$$;

-- انضمام آمن: تحديث ذري + توكن ضيف من السيرفر
CREATE OR REPLACE FUNCTION public.join_room(p_code text, p_guest_name text)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.game_rooms%ROWTYPE;
  clean_name text;
  new_token text;
BEGIN
  IF p_code IS NULL OR length(trim(p_code)) <> 6 OR trim(p_code) !~ '^\d{6}$' THEN
    RETURN NULL;
  END IF;

  clean_name := left(trim(p_guest_name), 20);
  IF length(clean_name) < 1 THEN
    RETURN NULL;
  END IF;

  new_token := gen_random_uuid()::text;

  UPDATE public.game_rooms
  SET
    guest_name = clean_name,
    guest_token = new_token,
    status = 'playing',
    guest_heartbeat = (extract(epoch FROM now()) * 1000)::bigint
  WHERE code = trim(p_code)
    AND status = 'waiting'
    AND guest_name IS NULL
  RETURNING * INTO r;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  RETURN row_to_json(r);
END;
$$;

GRANT EXECUTE ON FUNCTION public.count_recent_waiting_rooms() TO anon;
GRANT EXECUTE ON FUNCTION public.preview_room_by_code(text) TO anon;
GRANT EXECUTE ON FUNCTION public.join_room(text, text) TO anon;

-- تفعيل RLS
ALTER TABLE public.game_rooms ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rooms_select" ON public.game_rooms;
DROP POLICY IF EXISTS "rooms_insert" ON public.game_rooms;
DROP POLICY IF EXISTS "rooms_update" ON public.game_rooms;
DROP POLICY IF EXISTS "rooms_delete" ON public.game_rooms;

-- قراءة: فقط بصاحب التوكن (لا تسريب غرف waiting)
CREATE POLICY "rooms_select" ON public.game_rooms
  FOR SELECT TO anon
  USING (
    get_room_token() = host_token
    OR get_room_token() = guest_token
  );

-- إنشاء: حد عام 50 غرفة انتظار فارغة في الساعتين
CREATE POLICY "rooms_insert" ON public.game_rooms
  FOR INSERT TO anon
  WITH CHECK (
    count_recent_waiting_rooms() < 50
  );

-- تحديث: فقط بصاحب التوكن (الانضمام عبر join_room RPC)
CREATE POLICY "rooms_update" ON public.game_rooms
  FOR UPDATE TO anon
  USING (
    get_room_token() = host_token
    OR get_room_token() = guest_token
  )
  WITH CHECK (true);

CREATE POLICY "rooms_delete" ON public.game_rooms
  FOR DELETE TO anon
  USING (
    get_room_token() = host_token
    OR get_room_token() = guest_token
  );

-- تنظيف الغرف القديمة
CREATE OR REPLACE FUNCTION public.cleanup_old_game_rooms()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.game_rooms
  WHERE
    (status = 'waiting' AND guest_name IS NULL AND (
      (created_at IS NOT NULL AND created_at < now() - interval '2 hours')
      OR (host_heartbeat > 0 AND host_heartbeat < (extract(epoch FROM now() - interval '2 hours') * 1000)::bigint)
    ))
    OR
    (status = 'finished' AND created_at IS NOT NULL AND created_at < now() - interval '24 hours');

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- جدولة التنظيف كل ساعة (فعّل pg_cron من Extensions أولاً)
-- SELECT cron.schedule('cleanup-game-rooms', '0 * * * *', $$SELECT public.cleanup_old_game_rooms()$$);

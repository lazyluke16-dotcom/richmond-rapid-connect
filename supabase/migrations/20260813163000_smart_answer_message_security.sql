-- Keep receptionist messages read-only to authenticated clients. Status changes
-- are performed through a tenant-scoped SECURITY DEFINER RPC.
REVOKE INSERT, UPDATE, DELETE ON public.reception_messages FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.mark_my_reception_messages_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  bid uuid;
  changed integer;
BEGIN
  SELECT bu.business_id INTO bid
  FROM public.business_users bu
  WHERE bu.user_id = auth.uid()
  ORDER BY CASE WHEN bu.role IN ('owner','admin') THEN 0 ELSE 1 END, bu.business_id
  LIMIT 1;

  IF bid IS NULL THEN
    RAISE EXCEPTION 'No business membership' USING ERRCODE = '42501';
  END IF;

  UPDATE public.reception_messages
  SET status = 'read'
  WHERE business_id = bid
    AND status = 'unread';

  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END
$$;

REVOKE EXECUTE ON FUNCTION public.mark_my_reception_messages_read()
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_my_reception_messages_read()
  TO authenticated;

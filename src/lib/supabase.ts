import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL ??
  (typeof process !== 'undefined' ? process.env.SUPABASE_URL : '') ??
  '';
const supabaseKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ??
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ??
  (typeof process !== 'undefined'
    ? process.env.SUPABASE_ANON_KEY ?? process.env.SUPABASE_PUBLISHABLE_KEY
    : '') ??
  '';

export const supabase = createClient(supabaseUrl, supabaseKey);